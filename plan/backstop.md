# Blend Backstop Position Tracking

## Overview

This document describes the architecture for tracking Blend Protocol backstop positions. The backstop is a first-loss capital mechanism where users deposit 80:20 BLND:USDC LP tokens to provide insurance for lending pools.

## Contract Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Comet LP Pool                                 │
│  Contract: CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM │
│  80:20 BLND:USDC AMM - Issues LP tokens                         │
└─────────────────────────┬───────────────────────────────────────┘
                          │ LP tokens deposited
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Backstop Contract                             │
│  Contract: CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7 │
│  Single contract managing backstop for ALL pools                │
│  Events: deposit, withdraw, queue_withdrawal, claim, etc.       │
└─────────────────────────┬───────────────────────────────────────┘
                          │ coverage allocation per pool
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Blend Lending Pools                           │
│  CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD (V2)  │
│  CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS (YBX) │
│  CAE7QVOMBLZ53CDRGK3UNRRHG5EZ5NQA7HHTFASEMYBWHG6MDFZTYHXC (Orbit)│
│  CBYOBT7ZCCLQCBUYYIABZLSEGDPEUWXCUXQTZYOG3YBDR7U357D5ZIRF (Forex)│
│  CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI (Ether)│
└─────────────────────────────────────────────────────────────────┘
```

## Related Contracts (Blend v2 Mainnet)

| Contract | Address |
|----------|---------|
| **Backstop** | `CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7` |
| Comet LP (BLND:USDC 80:20) | `CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM` |
| BLND Token | `CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY` |
| Emitter | `CCOQM6S7ICIUWA225O5PSJWUBEMXGFSSW2PQFO6FP4DQEKMS5DASRGRR` |
| Pool Factory | `CDSYOAVXFY7SM5S64IZPPPYB4GVGGLMQVFREPSQQEZVIWXX5R23G4QSU` |

## Event Types

### Position Events (verified from v2 contract - Dec 2024)

| Event | Description | pool_address | user_address | lp_tokens | shares |
|-------|-------------|--------------|--------------|-----------|--------|
| `deposit` | User deposits LP tokens | topics[1] | topics[2] | data.vec[0] | data.vec[1] |
| `withdraw` | User withdraws after queue | topics[1] | topics[2] | data.vec[1] | data.vec[0] |
| `queue_withdrawal` | User queues shares (17-day lock) | topics[1] | topics[2] | - | data.vec[0] |
| `dequeue_withdrawal` | User cancels queued withdrawal | topics[1] | topics[2] | - | data.vec[0] |
| `claim` | User claims emissions (global) | NULL | topics[1] | data.i128 | - |
| `donate` | Contract donates interest | topics[1] | topics[2] | data.i128 | - |
| `draw` | Pool draws for bad debt | topics[1] | NULL | data.vec[1] | - |
| `gulp_emissions` | Convert BLND to LP tokens | topics[1] | NULL | data.vec[0] | - |

---

## Event Structures

### `deposit`

User deposits LP tokens to backstop a specific pool.

**Topics:**
```json
[
  {"symbol": "deposit"},
  {"address": "<pool_address>"},    // Which lending pool
  {"address": "<user_address>"}     // Depositor
]
```

**Data:**
```json
{
  "vec": [
    {"i128": "<lp_tokens>"},   // LP tokens deposited
    {"i128": "<shares>"}       // Backstop shares received
  ]
}
```

**Fields:**
- `pool_address`: topics[1].address
- `user_address`: topics[2].address
- `lp_tokens`: data.vec[0].i128
- `shares`: data.vec[1].i128

---

### `withdraw`

User completes withdrawal after queue period expires.

**Topics:**
```json
[
  {"symbol": "withdraw"},
  {"address": "<pool_address>"},
  {"address": "<user_address>"}
]
```

**Data:**
```json
{
  "vec": [
    {"i128": "<shares>"},      // Backstop shares burned
    {"i128": "<lp_tokens>"}    // LP tokens received
  ]
}
```

**Fields:**
- `pool_address`: topics[1].address
- `user_address`: topics[2].address
- `shares`: data.vec[0].i128
- `lp_tokens`: data.vec[1].i128

---

### `queue_withdrawal`

User queues shares for withdrawal (starts 17-day timer in V2).

**Topics:**
```json
[
  {"symbol": "queue_withdrawal"},
  {"address": "<pool_address>"},
  {"address": "<user_address>"}
]
```

**Data:**
```json
{
  "vec": [
    {"i128": "<shares>"},      // Shares queued
    {"u64": "<expiration>"}    // Unix timestamp when withdrawal unlocks
  ]
}
```

**Fields:**
- `pool_address`: topics[1].address
- `user_address`: topics[2].address
- `shares`: data.vec[0].i128
- `q4w_exp`: data.vec[1].u64 (unix timestamp)

---

### `dequeue_withdrawal`

User cancels a queued withdrawal.

**Topics:**
```json
[
  {"symbol": "dequeue_withdrawal"},
  {"address": "<pool_address>"},
  {"address": "<user_address>"}
]
```

**Data:**
```json
{
  "vec": [
    {"i128": "<shares>"}       // Shares returned to active
  ]
}
```

---

### `claim`

User claims earned interest and BLND emissions. Note: This is a **global claim** across all pools the user has backstopped.

**Topics:**
```json
[
  {"symbol": "claim"},
  {"address": "<user_address>"}    // No pool_address - global
]
```

**Data:**
```json
{"i128": "<lp_tokens>"}            // LP tokens claimed (auto-deposited)
```

**Fields:**
- `user_address`: topics[1].address
- `lp_tokens`: data.i128

---

### `donate`

Donation to the backstop (typically from lending pool interest payments).

**Topics:**
```json
[
  {"symbol": "donate"},
  {"address": "<pool_address>"},    // Which lending pool
  {"address": "<donor_address>"}    // Contract donating (usually pool contract)
]
```

**Data:**
```json
{"i128": "<lp_tokens>"}             // LP tokens donated
```

**Fields:**
- `pool_address`: topics[1].address
- `user_address`: topics[2].address (donor - usually a contract address like CA...)
- `lp_tokens`: data.i128

---

### `draw`

Pool draws from backstop to cover bad debt (rare event - indicates pool health issues).

**Topics:**
```json
[
  {"symbol": "draw"},
  {"address": "<pool_address>"}     // Pool drawing funds
]
```

**Data:**
```json
{
  "vec": [
    {"address": "<to_address>"},    // Recipient of drawn funds
    {"i128": "<amount>"}            // LP tokens drawn
  ]
}
```

**Fields:**
- `pool_address`: topics[1].address
- `user_address`: NULL (pool-level event, recipient is in data)
- `lp_tokens`: data.vec[1].i128

---

### `gulp_emissions`

Convert accumulated BLND emissions into LP tokens for the pool's backstop.

**Topics:**
```json
[
  {"symbol": "gulp_emissions"},
  {"address": "<pool_address>"}     // Pool receiving emissions
]
```

**Data:**
```json
{
  "vec": [
    {"i128": "<backstop_emissions>"},  // LP tokens added to backstop
    {"i128": "<pool_emissions>"}       // Emissions for pool rewards
  ]
}
```

**Fields:**
- `pool_address`: topics[1].address
- `user_address`: NULL (pool-level event)
- `lp_tokens`: data.vec[0].i128 (backstop emissions)

---

## Database Schema

### `backstop_events` Table

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `id` | TEXT | NO | Unique event ID (Goldsky format) |
| `transaction_hash` | TEXT | NO | Transaction hash |
| `ledger_sequence` | BIGINT | NO | Ledger/block number |
| `ledger_closed_at` | TIMESTAMP | NO | Event timestamp |
| `action_type` | VARCHAR(30) | NO | Event type (deposit, withdraw, etc.) |
| `pool_address` | VARCHAR(56) | YES | NULL for `claim` (global event) |
| `user_address` | VARCHAR(56) | YES | NULL for `gulp_emissions`, `draw` (pool-level) |
| `lp_tokens` | DECIMAL(38,0) | YES | LP token amount |
| `shares` | DECIMAL(38,0) | YES | Backstop share amount |
| `q4w_exp` | BIGINT | YES | Queue expiration (queue_withdrawal only) |
| `src` | VARCHAR(10) | YES | Data source ('gs'=Goldsky, 'bq'=BigQuery) |

**NULL field rules:**
- `pool_address` = NULL when `action_type = 'claim'` (claims are global across all pools)
- `user_address` = NULL when `action_type IN ('gulp_emissions', 'draw')` (pool-level events)

---

## Position Calculation

To calculate a user's current backstop position for a pool:

```sql
SELECT
  user_address,
  pool_address,
  SUM(CASE
    WHEN action_type = 'deposit' THEN shares
    WHEN action_type = 'withdraw' THEN -shares
    WHEN action_type = 'queue_withdrawal' THEN -shares  -- queued = locked
    WHEN action_type = 'dequeue_withdrawal' THEN shares -- returned to active
    ELSE 0
  END) AS active_shares,
  SUM(CASE
    WHEN action_type = 'queue_withdrawal' THEN shares
    WHEN action_type = 'withdraw' THEN -shares  -- completed withdrawal
    WHEN action_type = 'dequeue_withdrawal' THEN -shares
    ELSE 0
  END) AS queued_shares
FROM backstop_events
WHERE user_address = :user
  AND pool_address = :pool
GROUP BY user_address, pool_address
```

---

## Share Rate Calculation

The exchange rate between LP tokens and shares changes over time:

```
share_rate = total_lp_tokens / total_shares
user_lp_value = user_shares × share_rate
```

---

## Key Difference: Backstop vs Lending Pool Rate Tracking

### Lending Pool Events (Easy)

```
┌────────────────────────────────────────────────────────────────┐
│ Lending Pool: Explicit Rate Storage                             │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│ Contract stores: bRate, dRate (updated every block)            │
│                                                                 │
│ To get position value at any ledger:                           │
│   1. Query contract state at that ledger                       │
│   2. Read bRate/dRate directly from storage                    │
│   3. Calculate: underlying = bTokens × bRate                   │
│                                                                 │
│ Rate source: Explicit contract storage                         │
│ Rate updates: Continuous (interest accrual every block)        │
│ Complexity: O(1) - single value lookup                         │
│                                                                 │
│ For events: Can store implied_rate = amount / tokens           │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### Backstop Events (Complex)

```
┌────────────────────────────────────────────────────────────────┐
│ Backstop: Derived Rate (No Explicit Storage)                    │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│ Contract stores: total_lp, total_shares per pool               │
│ NO explicit "share_rate" stored anywhere                       │
│                                                                 │
│ To get position value at any ledger:                           │
│   Option A: Query contract state                               │
│     - Read total_lp and total_shares                           │
│     - Calculate: share_rate = total_lp / total_shares          │
│                                                                 │
│   Option B: Derive from event history                          │
│     - Sum ALL events from genesis to that ledger               │
│     - Compute running totals per pool                          │
│     - Calculate: share_rate = total_lp / total_shares          │
│                                                                 │
│ Rate source: Derived (must be computed)                        │
│ Rate updates: Only on specific events (not every block)        │
│ Complexity: O(n) - need history or contract query              │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### When Does Share Rate Change?

The rate ONLY changes when LP tokens change WITHOUT corresponding share changes:

| Event | LP Change | Share Change | Rate Effect |
|-------|-----------|--------------|-------------|
| `deposit` | +X | +Y | **Neutral** (X/Y ≈ current rate) |
| `withdraw` | -X | -Y | **Neutral** (X/Y ≈ current rate) |
| `donate` | +X | 0 | **Rate increases** ↑ |
| `draw` | -X | 0 | **Rate decreases** ↓ |
| `gulp_emissions` | +X | 0 | **Rate increases** ↑ |
| `queue_withdrawal` | 0 | 0 | Neutral |
| `dequeue_withdrawal` | 0 | 0 | Neutral |
| `claim` | 0 | 0 | Neutral |

This is fundamentally different from lending pools where bRate increases every block due to interest accrual.

---

## Rate Tracking Challenges

### Challenge 1: No Rate Snapshot Available

**Problem**: Unlike `parsed_events.implied_rate` for lending pools, we can't easily capture the share_rate at event time.

**Why**:
- Lending pool events emit amount AND tokens, so `implied_rate = amount / tokens`
- Backstop events don't emit the current rate - just the transaction amounts
- The rate depends on global pool state, not just the event data

### Challenge 2: Rate Requires Full History

**Problem**: To know share_rate at event N, you need cumulative state from events 1 to N-1.

**Example**:
```
Event 1: deposit 1000 LP → 1000 shares  (rate = 1.0)
Event 2: donate 100 LP                   (rate = 1100/1000 = 1.1)
Event 3: deposit 110 LP → 100 shares     (rate still 1.1)
Event 4: draw 110 LP                     (rate = 1000/1100 = 0.909)
```

Without events 1-3, you cannot compute the rate at event 4.

### Challenge 3: Partial Backfills Are Incomplete

**Problem**: If you backfill events from ledger 1000-2000, you don't know:
- Total LP tokens at ledger 999
- Total shares at ledger 999
- Therefore cannot compute rate for any event in the range

**Solutions**:
1. Always backfill from genesis (complete history)
2. Query contract state at backfill start ledger
3. Accept missing rates for partial backfills

### Challenge 4: Per-Pool Rate Tracking

**Problem**: Each lending pool has its own backstop allocation with its own rate.

```
Pool A: 10,000 LP tokens, 9,000 shares → rate = 1.111
Pool B: 5,000 LP tokens, 5,500 shares → rate = 0.909
```

Must track running totals separately per pool.

### Challenge 5: Event Ordering Within Ledger

**Problem**: Multiple events in the same ledger affect rate sequentially.

```
Ledger 1000:
  Tx1: deposit 100 LP → 100 shares (rate was 1.0, still 1.0)
  Tx2: donate 10 LP (rate becomes 110/100 = 1.1)
  Tx3: deposit 110 LP → 100 shares (rate = 1.1, result: 220 LP, 200 shares)
```

Must process in correct order: (ledger_sequence, transaction_hash, event_index)

---

## Implementation Approaches

### Approach 1: Post-Process Rate Calculation (Recommended)

```typescript
// After fetching all events, compute rates in TypeScript
function computeShareRates(events: BackstopEvent[]): Map<string, number> {
  const poolState = new Map<string, { lp: bigint, shares: bigint }>();
  const rates = new Map<string, number>();

  // Events must be sorted by ledger, tx, index
  for (const event of events) {
    if (!event.pool_address) continue; // skip claims

    let state = poolState.get(event.pool_address) || { lp: 0n, shares: 0n };

    // Rate BEFORE this event
    const rate = state.shares > 0n
      ? Number(state.lp) / Number(state.shares)
      : 1.0;
    rates.set(event.id, rate);

    // Update state based on event
    switch (event.action_type) {
      case 'deposit':
        state.lp += BigInt(event.lp_tokens || 0);
        state.shares += BigInt(event.shares || 0);
        break;
      case 'withdraw':
        state.lp -= BigInt(event.lp_tokens || 0);
        state.shares -= BigInt(event.shares || 0);
        break;
      case 'donate':
      case 'gulp_emissions':
        state.lp += BigInt(event.lp_tokens || 0);
        break;
      case 'draw':
        state.lp -= BigInt(event.lp_tokens || 0);
        break;
    }
    poolState.set(event.pool_address, state);
  }
  return rates;
}
```

**Pros**: No external queries, works offline, deterministic
**Cons**: Requires complete event history from genesis

### Approach 2: Contract State Query

Query Soroban contract state at each event's ledger to get actual totals.

**Pros**: Works for partial backfills, always accurate
**Cons**: Expensive (1 RPC call per event), slow, rate-limited

### Approach 3: Hybrid (Initial State + Events)

1. Query contract state at backfill start
2. Use events to compute running totals from there

**Pros**: Works for partial backfills, fewer queries than Approach 2
**Cons**: Requires one initial contract query

### Approach 4: On-Demand Calculation

Don't store rate. Calculate from events when needed.

```sql
-- Get user position value at a specific ledger
WITH pool_state AS (
  SELECT
    pool_address,
    SUM(CASE
      WHEN action_type IN ('deposit', 'donate', 'gulp_emissions') THEN lp_tokens::numeric
      WHEN action_type IN ('withdraw', 'draw') THEN -lp_tokens::numeric
      ELSE 0
    END) as total_lp,
    SUM(CASE
      WHEN action_type = 'deposit' THEN shares::numeric
      WHEN action_type = 'withdraw' THEN -shares::numeric
      ELSE 0
    END) as total_shares
  FROM backstop_events
  WHERE ledger_sequence <= :target_ledger
  GROUP BY pool_address
),
user_position AS (
  SELECT
    pool_address,
    SUM(CASE
      WHEN action_type = 'deposit' THEN shares::numeric
      WHEN action_type = 'withdraw' THEN -shares::numeric
      ELSE 0
    END) as user_shares
  FROM backstop_events
  WHERE user_address = :user
    AND ledger_sequence <= :target_ledger
  GROUP BY pool_address
)
SELECT
  u.pool_address,
  u.user_shares,
  p.total_lp / NULLIF(p.total_shares, 0) as share_rate,
  u.user_shares * (p.total_lp / NULLIF(p.total_shares, 0)) as user_lp_value
FROM user_position u
JOIN pool_state p ON u.pool_address = p.pool_address;
```

**Pros**: No storage overhead, always accurate
**Cons**: Expensive query, scans full history each time

---

## Schema Enhancement Options

### Option A: Add share_rate to backstop_events

```sql
ALTER TABLE backstop_events ADD COLUMN share_rate NUMERIC(38,18);
-- Store rate at time of each event
```

### Option B: Separate pool state table

```sql
CREATE TABLE backstop_pool_state (
  pool_address VARCHAR(56) NOT NULL,
  ledger_sequence BIGINT NOT NULL,
  total_lp NUMERIC(38,0) NOT NULL,
  total_shares NUMERIC(38,0) NOT NULL,
  share_rate NUMERIC(38,18) NOT NULL,
  PRIMARY KEY (pool_address, ledger_sequence)
);
-- Only insert when state changes (donate, draw, gulp, deposit, withdraw)
```

---

## Withdrawal Queue Mechanics

1. User calls `queue_withdrawal` with amount of shares
2. Shares are locked and stop earning emissions
3. `q4w_exp` is set to `current_time + 17 days` (V2) or `+ 21 days` (V1)
4. After expiration AND if no bad debt exists, user can call `withdraw`
5. User can cancel anytime with `dequeue_withdrawal`

---

## References

- [Blend Whitepaper](https://docs.blend.capital/blend-whitepaper)
- [Backstopping Guide](https://docs.blend.capital/users/backstopping)
- [Mainnet Deployments](https://docs.blend.capital/mainnet-deployments)
