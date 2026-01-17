# Plan: Backfilling Historical Backstop Rates

## Executive Summary

Based on analysis of your existing infrastructure, the **most practical approach** is to derive historical rates entirely from your `backstop_events` data. You don't need Mercury or external contract state queries because pool state can be reconstructed from event history.

## Key Insight

The `pool_shares` and `pool_tokens` values change **only** through events:

| Event Type | pool_shares | pool_tokens | Rate Effect |
|------------|-------------|-------------|-------------|
| deposit | +shares | +tokens | Neutral (proportional) |
| withdraw | -shares | -tokens | Neutral (proportional) |
| queue_withdrawal | unchanged | unchanged | None |
| dequeue_withdrawal | unchanged | unchanged | None |
| **donate** | unchanged | **+tokens** | **Rate increases** |
| **draw** | unchanged | **-tokens** | **Rate decreases** |
| **gulp_emissions** | unchanged | **+tokens** | **Rate increases** |
| claim | unchanged | unchanged | None |

This means we can **reconstruct exact historical pool state** by processing events in order.

---

## Data Source Analysis

### What You Have

1. **BigQuery** (`crypto_stellar.history_contract_events`)
   - Complete event history from genesis
   - Already integrated with your backfill infrastructure
   - Cost: ~$5-20 per full table scan (estimatable via existing `/estimate` endpoint)

2. **Goldsky** (real-time streaming)
   - Already configured in `pipeline-backstop.yaml`
   - Events flow to `backstop_events` table

3. **backstop_events table**
   - Contains `shares` and `lp_tokens` for each event
   - `ledger_closed_at` for timestamping
   - Already has all 5 tracked pools' events

### What You Don't Have (and don't need)

- **Mercury indexer** - Not in your stack, not needed
- **Horizon historical state** - Limited, not needed
- **Direct contract storage queries** - Only gives current state

---

## Recommended Schema

```sql
CREATE TABLE backstop_daily_rates (
  rate_date DATE NOT NULL,
  pool_id TEXT NOT NULL,                    -- Lending pool address
  backstop_id TEXT NOT NULL,                -- Always: CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7
  pool_shares NUMERIC(38,0) NOT NULL,       -- Running total of shares in pool
  pool_tokens NUMERIC(38,0) NOT NULL,       -- Running total of LP tokens in pool
  shares_to_tokens_rate NUMERIC NOT NULL,   -- pool_tokens / pool_shares (as float)
  lp_token_price NUMERIC,                   -- USD per LP token (Phase 2)
  blnd_price_usd NUMERIC,                   -- BLND price (Phase 2)
  last_ledger_sequence BIGINT NOT NULL,     -- Last processed ledger for this date
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (rate_date, pool_id)
);

-- Indexes for efficient queries
CREATE INDEX idx_backstop_rates_pool ON backstop_daily_rates(pool_id);
CREATE INDEX idx_backstop_rates_date ON backstop_daily_rates(rate_date);
```

---

## Implementation Plan

### Phase 1: Shares-to-Tokens Rate (Complete Solution)

#### Step 1.1: Ensure Complete Event History

First, verify you have all backstop events from genesis:

```sql
-- Run in BigQuery to check event range
SELECT
  MIN(closed_at) as first_event,
  MAX(closed_at) as last_event,
  COUNT(*) as total_events
FROM `crypto-stellar.crypto_stellar.history_contract_events`
WHERE contract_id = 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7'
  AND successful = true
  AND JSON_VALUE(topics_decoded, '$[0].symbol') IN
    ('deposit', 'withdraw', 'queue_withdrawal', 'dequeue_withdrawal',
     'claim', 'donate', 'draw', 'gulp_emissions')
```

If your local `backstop_events` table is missing early events, run a backfill first via your existing infrastructure.

#### Step 1.2: Create Rate Computation Service

New file: `src/services/backstop-rates-backfill.ts`

**Algorithm:**

```typescript
// Pseudocode for rate computation
interface PoolState {
  poolShares: bigint;
  poolTokens: bigint;
}

const poolStates = new Map<string, PoolState>();

// Process events in chronological order
for (const event of events.orderBy('ledger_sequence')) {
  const state = poolStates.get(event.pool_address) || { poolShares: 0n, poolTokens: 0n };

  switch (event.action_type) {
    case 'deposit':
      state.poolShares += event.shares;
      state.poolTokens += event.lp_tokens;
      break;
    case 'withdraw':
      state.poolShares -= event.shares;
      state.poolTokens -= event.lp_tokens;
      break;
    case 'donate':
    case 'gulp_emissions':
      state.poolTokens += event.lp_tokens; // shares unchanged, rate increases
      break;
    case 'draw':
      state.poolTokens -= event.lp_tokens; // shares unchanged, rate decreases
      break;
    // queue_withdrawal, dequeue_withdrawal, claim: no effect on pool totals
  }

  poolStates.set(event.pool_address, state);

  // At end of each day, snapshot the state
  if (isEndOfDay(event) || isLastEventOfDay(event)) {
    insertDailyRate(event.date, event.pool_address, state);
  }
}
```

#### Step 1.3: Daily Aggregation Query

This query computes running totals per day directly from events:

```sql
-- Can be run in BigQuery or against local PostgreSQL
WITH ordered_events AS (
  SELECT
    DATE(ledger_closed_at) as event_date,
    pool_address,
    action_type,
    COALESCE(shares, 0) as shares,
    COALESCE(lp_tokens, 0) as lp_tokens,
    ledger_sequence,
    ROW_NUMBER() OVER (
      PARTITION BY pool_address, DATE(ledger_closed_at)
      ORDER BY ledger_sequence DESC
    ) as rn
  FROM backstop_events
  WHERE action_type IN ('deposit', 'withdraw', 'donate', 'draw', 'gulp_emissions')
),
cumulative_state AS (
  SELECT
    event_date,
    pool_address,
    SUM(CASE
      WHEN action_type = 'deposit' THEN shares
      WHEN action_type = 'withdraw' THEN -shares
      ELSE 0
    END) OVER (PARTITION BY pool_address ORDER BY event_date) as running_shares,
    SUM(CASE
      WHEN action_type = 'deposit' THEN lp_tokens
      WHEN action_type = 'withdraw' THEN -lp_tokens
      WHEN action_type IN ('donate', 'gulp_emissions') THEN lp_tokens
      WHEN action_type = 'draw' THEN -lp_tokens
      ELSE 0
    END) OVER (PARTITION BY pool_address ORDER BY event_date) as running_tokens,
    MAX(ledger_sequence) as last_ledger
  FROM ordered_events
)
SELECT DISTINCT ON (event_date, pool_address)
  event_date as rate_date,
  pool_address as pool_id,
  'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7' as backstop_id,
  running_shares as pool_shares,
  running_tokens as pool_tokens,
  CASE WHEN running_shares > 0
    THEN running_tokens::numeric / running_shares::numeric
    ELSE 0
  END as shares_to_tokens_rate,
  last_ledger as last_ledger_sequence
FROM cumulative_state
ORDER BY event_date, pool_address, last_ledger DESC;
```

#### Step 1.4: Implementation Tasks

1. Create `backstop-rates-repository.ts`
2. Create `backstop-rates-backfill.ts` service
3. Add API endpoints:
   - `GET /api/backstop-rates/backfill` - Run historical backfill
   - `GET /api/backstop-rates/latest` - Get current rates
   - `GET /api/backstop-rates/history/:poolId` - Get rate history
4. Create frontend component (similar to BackstopBackfill.tsx)

---

### Phase 2: LP Token Price (Future Enhancement)

This is more complex and has multiple options:

#### Option A: Track Comet Pool Events (Recommended)

The Comet BLND:USDC pool is a Stellar Soroban contract. Query its events similarly:

```sql
-- Find Comet pool contract events in BigQuery
SELECT *
FROM `crypto-stellar.crypto_stellar.history_contract_events`
WHERE contract_id = '<COMET_POOL_CONTRACT_ID>'  -- Need to identify this
  AND successful = true
LIMIT 100
```

Track swap/deposit/withdraw events to reconstruct historical:
- `totalBlnd` in pool
- `totalUsdc` in pool
- `totalLpSupply`

Then compute:
```
blndPrice = (totalUsdc / 0.2) / (totalBlnd / 0.8)
lpTokenPrice = (totalBlnd * blndPrice + totalUsdc) / totalLpSupply
```

**Blocker:** Need to identify the Comet pool contract address. This should be available from Blend SDK or their docs.

#### Option B: External BLND Price + Estimation

1. Fetch historical BLND/USD prices from:
   - CoinGecko API (free, limited history)
   - StellarExpert (Stellar-native)
   - DEX aggregator APIs

2. Estimate pool composition assuming 80/20 ratio maintained

3. Calculate approximate LP token price

**Pros:** Simpler, faster to implement
**Cons:** Less accurate, assumptions about pool balance

#### Option C: Leave as NULL for Now

Focus on Phase 1 (shares_to_tokens_rate) which gives you the primary conversion factor. Add LP token price later when you have:
- Clear Comet contract address
- Historical price data source

---

### Phase 3: Ongoing Daily Snapshots

#### Option A: Scheduled Job (Recommended)

Add a cron job or scheduled task:

```typescript
// Run daily at 00:05 UTC
async function snapshotDailyRates() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  // Query events from yesterday
  const events = await getEventsForDate(yesterday);

  // Compute running totals
  const rates = computeRates(events);

  // Insert into backstop_daily_rates
  await insertDailyRates(rates);
}
```

#### Option B: Event-Driven (Alternative)

Modify Goldsky pipeline to also update running totals on each event. More complex but real-time accurate.

---

## Validation Strategy

### Cross-Check with SDK

After backfill, verify current rates match live SDK values:

```typescript
import { Backstop } from '@blend-capital/blend-sdk';

const backstop = await Backstop.load(network, backstopId);
for (const [poolId, poolData] of backstop.pools) {
  const dbRate = await getLatestRate(poolId);
  const sdkRate = poolData.poolTokens / poolData.poolShares;

  console.log(`Pool ${poolId}:`);
  console.log(`  DB Rate: ${dbRate.shares_to_tokens_rate}`);
  console.log(`  SDK Rate: ${sdkRate}`);
  console.log(`  Match: ${Math.abs(dbRate - sdkRate) < 0.0001}`);
}
```

### Historical Spot Checks

Pick random historical events and verify:
```
event.lp_tokens / event.shares ≈ rate_at_date
```

---

## Questions I Need Answered

Before implementing, please clarify:

1. **Comet Pool Contract Address**
   - What is the contract address for the BLND:USDC Comet pool?
   - Is this available from Blend SDK or docs?

2. **Historical Range**
   - How far back do you need rates? (First backstop event date?)
   - What's the earliest date you'd show in balance charts?

3. **Price Data Priority**
   - Is Phase 1 (shares_to_tokens_rate only) sufficient for MVP?
   - Or do you need LP token price immediately for USD values?

4. **Precision Requirements**
   - The shares and lp_tokens are stored as NUMERIC(38,0) (integers in i128 form)
   - What precision do you need for the rate? (e.g., 18 decimal places)

5. **Initial Pool State**
   - Do you know if pools had any pre-seeded tokens/shares before first event?
   - (Likely 0/0 but worth confirming)

---

## Summary

| Approach | Complexity | Data Needed | Accuracy |
|----------|------------|-------------|----------|
| Phase 1: Derive from events | Low | Just backstop_events | 100% accurate |
| Phase 2A: Track Comet events | Medium | BigQuery + new pipeline | 100% accurate |
| Phase 2B: External prices | Low | Price API | ~95% accurate |

**Recommendation:** Start with Phase 1. It requires no new data sources and will give you accurate shares-to-tokens rates for all historical dates. Add LP token pricing in Phase 2 once you have the Comet contract address or decide on a price data source.
