# Plan: Track BLND Amount for Backstop Claim Events

## Overview

When a user claims BLND emissions from the backstop, two events occur in the same transaction:
1. **Backstop `claim` event** (contract `CAQQ...3IM7`) - returns LP tokens received
2. **Comet pool `deposit` event** (contract `CAS3...VEAM`) - contains the actual BLND amount deposited

Currently, we only capture the LP tokens from the backstop claim event. This plan adds tracking of the actual BLND amount by correlating with the Comet pool deposit event.

## Event Flow Analysis

```
Transaction Flow (same tx_hash):
┌────────────────────────────────────────────────────────────────────────────┐
│  User calls: claim(GDD7...PT4J, [CCCC...GYFS], 0) on Backstop              │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  1. Backstop (CAQQ...3IM7) calculates emissions owed                       │
│     → Calls Comet pool to convert BLND → LP tokens                         │
│                                                                            │
│  2. Comet Pool (CAS3...VEAM) receives BLND deposit:                        │
│     → dep_tokn_amt_in_get_lp_tokns_out(BLND_token, 19963949, 0, Backstop)  │
│     → Returns 3280057 LP tokens                                            │
│     → Emits event: ["POOL", "deposit"] with token_amount_in: 19963949      │
│                                                                            │
│  3. Backstop deposits LP tokens for user & emits:                          │
│     → Event: ["claim", user_address] with data: 3280057 (LP tokens)        │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

## Contract Addresses

| Contract | Address | Role |
|----------|---------|------|
| Backstop | `CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7` | Emits `claim` event with LP tokens |
| Comet Pool | `CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM` | Emits `deposit` event with BLND amount |
| BLND Token | `CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY` | Confirms token_in is BLND |

## Event Structures

### Backstop `claim` Event (currently captured)
```json
{
  "topics": [{"symbol": "claim"}, {"address": "<user_address>"}],
  "data": {"i128": "<lp_tokens>"}
}
```

### Comet Pool `deposit` Event (needs to be correlated)
```json
{
  "topics": [{"symbol": "POOL"}, {"symbol": "deposit"}],
  "data": {
    "caller": "<backstop_contract>",
    "token_amount_in": {"i128": "<blnd_amount>"},
    "token_in": "<blnd_token_address>"
  }
}
```

## Design Decision: Same Row vs New Row

### Option A: Add `blnd_amount` column to existing row

**Pros:**
- The BLND amount is directly related to the claim event - it's the same logical action
- Keeps all claim-related data in one place for easy querying
- Follows the same pattern as `emissions_amount` for `gulp_emissions` events
- No need for complex joins at query time

**Cons:**
- Requires JOIN at ingestion time (BigQuery) or post-processing (Goldsky)
- Mixes data from two different contracts in one row

### Option B: Store as separate row, link later (USER PREFERRED)

Store the Comet pool deposit as a separate event row, linked via `transaction_hash`.

**Pros:**
- Clean separation - each row represents one contract event
- Simpler ingestion - no cross-contract JOINs needed during ingestion
- More flexible - can capture additional Comet pool events in the future
- Data integrity - each event is stored exactly as emitted
- Easier debugging - can see both events independently

**Cons:**
- Requires JOIN at query time to see claim + BLND amount together
- Slightly more storage (separate row vs column)

**Linking Strategy:**
- Both events share the same `transaction_hash`
- Query-time JOIN: `WHERE a.transaction_hash = b.transaction_hash`
- Can create a view for convenience

**Important: User Linkage**
The Comet pool event does NOT contain the user address directly. The `caller` field is the **Backstop contract**, not the user:

```
Comet deposit event:
  caller = CAQQ...3IM7 (Backstop contract)  ← NOT the user
  token_amount_in = BLND amount

Backstop claim event:
  user_address = GDD7...PT4J (actual user)  ← User is here
  lp_tokens = LP tokens received
```

To get the user for a Comet deposit, you MUST join via `transaction_hash`:
```sql
SELECT
  b.user_address,           -- from backstop claim
  c.token_amount_in AS blnd -- from comet deposit
FROM comet_pool_events c
JOIN backstop_events b ON c.transaction_hash = b.transaction_hash
WHERE b.action_type = 'claim'
```

---

## Implementation Plan - Option A (Add Column)

### 1. Database Schema

Add a new nullable column to `backstop_events`:

```sql
ALTER TABLE backstop_events
ADD COLUMN blnd_amount NUMERIC(38,0);
```

**Field Rules:**
- Only populated for `action_type = 'claim'`
- NULL for all other action types
- Stored in raw token units (7 decimal places for BLND)

### 2. Backstop Repository (`src/repositories/backstop-repository.ts`)

Update `BackstopEventRow` interface:
```typescript
export interface BackstopEventRow {
  // ... existing fields ...
  blnd_amount: string | null;  // BLND tokens claimed (claim events only)
}
```

Update insert logic to include the new column.

### 3. BigQuery Backfill (`src/services/bigquery-backstop-backfill.ts`)

Modify the query to JOIN with Comet pool deposit events:

```sql
WITH backstop_events AS (
  -- Existing backstop event extraction
  SELECT
    transaction_hash,
    ledger_sequence,
    closed_at,
    JSON_VALUE(topics_decoded, '$[0].symbol') AS action_type,
    -- ... other fields ...
  FROM `crypto-stellar.crypto_stellar.history_contract_events`
  WHERE contract_id = 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7'
    AND JSON_VALUE(topics_decoded, '$[0].symbol') IN ('deposit', 'withdraw', 'queue_withdrawal', 'dequeue_withdrawal', 'claim', 'donate', 'draw', 'gulp_emissions')
    AND in_successful_contract_call = TRUE
),
comet_deposits AS (
  -- Extract BLND deposits from Comet pool
  SELECT
    transaction_hash,
    CAST(COALESCE(
      JSON_VALUE(data_decoded, '$.token_amount_in.i128'),
      JSON_VALUE(data_decoded, '$.token_amount_in.i128.lo')
    ) AS STRING) AS blnd_amount,
    JSON_VALUE(data_decoded, '$.token_in.address') AS token_in
  FROM `crypto-stellar.crypto_stellar.history_contract_events`
  WHERE contract_id = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM'
    AND JSON_VALUE(topics_decoded, '$[0].symbol') = 'POOL'
    AND JSON_VALUE(topics_decoded, '$[1].symbol') = 'deposit'
    AND in_successful_contract_call = TRUE
    -- Only BLND deposits (not USDC)
    AND JSON_VALUE(data_decoded, '$.token_in.address') = 'CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY'
)
SELECT
  b.*,
  CASE
    WHEN b.action_type = 'claim' THEN c.blnd_amount
    ELSE NULL
  END AS blnd_amount
FROM backstop_events b
LEFT JOIN comet_deposits c ON b.transaction_hash = c.transaction_hash AND b.action_type = 'claim'
```

**Important Considerations:**
- The LEFT JOIN ensures we don't lose claim events if the Comet deposit event is missing
- Filter `token_in` to BLND address to avoid matching USDC deposits
- The Comet pool can have multiple deposits in one transaction (for other operations), so we specifically match:
  - Topic `["POOL", "deposit"]`
  - `token_in` = BLND token address
  - Same `transaction_hash`

### 4. Goldsky Pipeline (`stellar-events-stream/goldsky/pipeline-backstop.yaml`)

**Challenge**: Goldsky pipelines process events individually and don't easily support cross-contract joins.

**Options:**

**Option A: Post-Processing (Recommended)**
- Keep Goldsky pipeline as-is, capturing backstop events only
- Create a separate cron job/service that:
  1. Finds recent `claim` events with `blnd_amount IS NULL`
  2. Queries BigQuery for corresponding Comet pool deposits
  3. Updates the rows with BLND amounts

**Option B: Separate Comet Events Table**
- Create a new Goldsky pipeline for Comet pool deposit events
- Store in a separate table: `comet_pool_deposits`
- Join at query time or via a materialized view

**Option C: Dual-Pipeline with Same Transaction Linking**
- Modify the Goldsky pipeline to also capture Comet pool deposit events
- Insert into same `backstop_events` table with a special action type like `comet_deposit`
- Post-process to link and update claim rows

**Recommended: Option A** - simplest, avoids Goldsky pipeline complexity

### 5. Post-Processing Service (for Goldsky data)

Create a new service `src/services/claim-blnd-enrichment.ts`:

```typescript
export class ClaimBlndEnrichmentService {
  /**
   * Find claim events missing blnd_amount and enrich from BigQuery
   */
  async enrichMissingBlndAmounts(): Promise<void> {
    // 1. Query local DB for claim events where blnd_amount IS NULL
    // 2. Get list of transaction_hashes
    // 3. Query BigQuery for Comet pool deposits with those tx hashes
    // 4. Update local DB with blnd_amounts
  }
}
```

---

## Implementation Plan - Option B (Separate Rows) - USER PREFERRED

Store Comet pool deposit events as separate rows in a new table, linked to backstop claims via `transaction_hash`.

### 1. Database Schema

Create a new table for Comet pool events:

```sql
CREATE TABLE comet_pool_events (
  id TEXT PRIMARY KEY,
  transaction_hash TEXT NOT NULL,
  ledger_sequence BIGINT NOT NULL,
  ledger_closed_at TIMESTAMP NOT NULL,
  action_type VARCHAR(30) NOT NULL,        -- 'deposit', 'withdraw', 'swap', etc.
  caller_address VARCHAR(56),               -- Contract/user that initiated the action
  token_in VARCHAR(56),                     -- Token being deposited
  token_amount_in DECIMAL(38,0),            -- Amount of token_in
  token_out VARCHAR(56),                    -- Token being received (for swaps)
  token_amount_out DECIMAL(38,0),           -- Amount of token_out
  lp_tokens_minted DECIMAL(38,0),           -- LP tokens minted (for deposits)
  lp_tokens_burned DECIMAL(38,0),           -- LP tokens burned (for withdrawals)
  src VARCHAR(10),                          -- 'bq' or 'gs'
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for joining with backstop claims
CREATE INDEX idx_comet_pool_events_tx_hash ON comet_pool_events(transaction_hash);
CREATE INDEX idx_comet_pool_events_ledger ON comet_pool_events(ledger_sequence);
CREATE INDEX idx_comet_pool_events_caller ON comet_pool_events(caller_address);
```

### 2. Comet Repository (`src/repositories/comet-repository.ts`)

Create a new repository:

```typescript
export interface CometPoolEventRow {
  id: string;
  transaction_hash: string;
  ledger_sequence: number;
  ledger_closed_at: Date | string;
  action_type: string;
  caller_address: string | null;
  token_in: string | null;
  token_amount_in: string | null;
  token_out: string | null;
  token_amount_out: string | null;
  lp_tokens_minted: string | null;
  lp_tokens_burned: string | null;
  src: 'bq' | 'gs';
}

export class CometRepository {
  async insertBatch(rows: CometPoolEventRow[]): Promise<void> { ... }
  async getByTransactionHash(txHash: string): Promise<CometPoolEventRow[]> { ... }
}
```

### 3. BigQuery Backfill (`src/services/bigquery-comet-backfill.ts`)

Create a new backfill service for Comet pool events:

```sql
SELECT
  transaction_hash,
  ledger_sequence,
  closed_at,
  -- Action type from topics
  JSON_VALUE(topics_decoded, '$[1].symbol') AS action_type,
  -- Caller (who initiated the deposit/swap)
  COALESCE(
    JSON_VALUE(data_decoded, '$.caller.address'),
    JSON_VALUE(data_decoded, '$.caller')
  ) AS caller_address,
  -- Token in
  COALESCE(
    JSON_VALUE(data_decoded, '$.token_in.address'),
    JSON_VALUE(data_decoded, '$.token_in')
  ) AS token_in,
  -- Token amount in
  CAST(COALESCE(
    JSON_VALUE(data_decoded, '$.token_amount_in.i128'),
    JSON_VALUE(data_decoded, '$.token_amount_in.i128.lo'),
    JSON_VALUE(data_decoded, '$.token_amount_in')
  ) AS STRING) AS token_amount_in,
  -- Token out (for swaps)
  COALESCE(
    JSON_VALUE(data_decoded, '$.token_out.address'),
    JSON_VALUE(data_decoded, '$.token_out')
  ) AS token_out,
  -- Token amount out
  CAST(COALESCE(
    JSON_VALUE(data_decoded, '$.token_amount_out.i128'),
    JSON_VALUE(data_decoded, '$.token_amount_out.i128.lo'),
    JSON_VALUE(data_decoded, '$.token_amount_out')
  ) AS STRING) AS token_amount_out
FROM `crypto-stellar.crypto_stellar.history_contract_events`
WHERE contract_id = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM'
  AND JSON_VALUE(topics_decoded, '$[0].symbol') = 'POOL'
  AND JSON_VALUE(topics_decoded, '$[1].symbol') IN ('deposit', 'withdraw', 'swap')
  AND in_successful_contract_call = TRUE
```

**Note:** Can filter to only `deposit` events where `caller = Backstop contract` if we only care about claim-related deposits.

### 4. Goldsky Pipeline (`stellar-events-stream/goldsky/pipeline-comet.yaml`)

Create a new pipeline for Comet pool events:

```yaml
name: comet-pool-events
version: "1.0.0"

sources:
  - name: stellar_events
    type: substreams
    # ... stellar substreams config ...

transforms:
  - name: comet_events
    type: sql
    primary_key: id
    sql: |
      SELECT *
      FROM stellar_events
      WHERE contract_id = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM'
        AND JSON_VALUE(topics, '$[0].symbol') = 'POOL'

  - name: parsed_comet_events
    type: sql
    primary_key: id
    sql: |
      SELECT
        id,
        transaction_hash,
        ledger_sequence,
        closed_at AS ledger_closed_at,
        JSON_VALUE(topics, '$[1].symbol') AS action_type,
        JSON_VALUE(data, '$.caller.address') AS caller_address,
        JSON_VALUE(data, '$.token_in.address') AS token_in,
        CAST(COALESCE(
          JSON_VALUE(data, '$.token_amount_in.i128'),
          JSON_VALUE(data, '$.token_amount_in.i128.lo')
        ) AS DECIMAL) AS token_amount_in,
        'gs' AS src
      FROM comet_events

sinks:
  - name: postgres_comet_events
    type: postgres
    table: comet_pool_events
    from: parsed_comet_events
```

### 5. Query View for Joined Data

Create a convenience view to join claims with their BLND amounts:

```sql
CREATE VIEW claim_with_blnd AS
SELECT
  b.id,
  b.transaction_hash,
  b.ledger_sequence,
  b.ledger_closed_at,
  b.user_address,
  b.lp_tokens,
  c.token_amount_in AS blnd_amount,
  CAST(c.token_amount_in AS NUMERIC) / 10000000 AS blnd_human_readable,
  b.src AS backstop_src,
  c.src AS comet_src
FROM backstop_events b
LEFT JOIN comet_pool_events c
  ON b.transaction_hash = c.transaction_hash
  AND c.action_type = 'deposit'
  AND c.token_in = 'CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY'  -- BLND token
  AND c.caller_address = 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7'  -- Backstop
WHERE b.action_type = 'claim';
```

### 6. Execution Order for Option B

#### Phase 1: Schema & Repository
1. Create `comet_pool_events` table with indexes
2. Create `CometPoolEventRow` interface
3. Create `CometRepository` class

#### Phase 2: BigQuery Backfill
4. Create `bigquery-comet-backfill.ts` service
5. Test with small date range
6. Run full backfill for Comet pool events

#### Phase 3: Goldsky Pipeline
7. Create `pipeline-comet.yaml`
8. Deploy pipeline to Goldsky
9. Verify real-time events flowing

#### Phase 4: View & Verification
10. Create `claim_with_blnd` view
11. Verify joins are working correctly
12. Test query performance

### 7. Verification Queries for Option B

```sql
-- Check Comet deposits that correspond to backstop claims
SELECT
  c.ledger_sequence,
  c.transaction_hash,
  c.caller_address,
  c.token_amount_in AS blnd_amount,
  CAST(c.token_amount_in AS NUMERIC) / 10000000 AS blnd_human_readable
FROM comet_pool_events c
WHERE c.action_type = 'deposit'
  AND c.caller_address = 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7'
  AND c.token_in = 'CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY'
ORDER BY c.ledger_sequence DESC
LIMIT 10;

-- Check claims can be joined with BLND amounts
SELECT
  b.user_address,
  b.lp_tokens,
  c.token_amount_in AS blnd_amount,
  b.ledger_sequence
FROM backstop_events b
JOIN comet_pool_events c ON b.transaction_hash = c.transaction_hash
WHERE b.action_type = 'claim'
  AND c.action_type = 'deposit'
  AND c.token_in = 'CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY'
ORDER BY b.ledger_sequence DESC
LIMIT 10;

-- Find claims missing corresponding Comet deposits
SELECT b.*
FROM backstop_events b
LEFT JOIN comet_pool_events c
  ON b.transaction_hash = c.transaction_hash
  AND c.action_type = 'deposit'
WHERE b.action_type = 'claim'
  AND c.id IS NULL;
```

---

## Execution Order (Option A - Add Column)

### Phase 1: Schema & Repository
1. Run database migration (add `blnd_amount` column)
2. Update `BackstopEventRow` interface in `backstop-repository.ts`
3. Update insert/update logic to include new column

### Phase 2: BigQuery Backfill
4. Update `bigquery-backstop-backfill.ts` to join with Comet deposits
5. Test with a small date range
6. Run full backfill to populate `blnd_amount` for historical claims

### Phase 3: Goldsky Enrichment
7. Create `claim-blnd-enrichment.ts` service
8. Add cron job or manual trigger to run enrichment
9. Test with recent claims

### Phase 4: Verification
10. Write verification query to check claim events have blnd_amount populated
11. Document any edge cases found

## Verification Query

```sql
-- Check claim events have blnd_amount populated
SELECT
  COUNT(*) as total_claims,
  COUNT(blnd_amount) as claims_with_blnd,
  COUNT(*) - COUNT(blnd_amount) as claims_missing_blnd
FROM backstop_events
WHERE action_type = 'claim';

-- Sample claim events with BLND amounts
SELECT
  ledger_sequence,
  transaction_hash,
  user_address,
  lp_tokens,
  blnd_amount,
  CAST(blnd_amount AS NUMERIC) / 10000000 as blnd_human_readable
FROM backstop_events
WHERE action_type = 'claim'
  AND blnd_amount IS NOT NULL
ORDER BY ledger_sequence DESC
LIMIT 10;
```

## Edge Cases to Consider

1. **Multiple Comet deposits in same transaction**: Possible if user does other operations in same tx. Filter by `token_in = BLND` should handle this.

2. **Missing Comet deposit event**: Could happen if event data is corrupted. Use LEFT JOIN to preserve claim, leave `blnd_amount` NULL.

3. **claim events before this feature**: Historical claims can be backfilled from BigQuery.

4. **gulp_emissions also deposits to Comet**: These are pool-level, not user claims. The query filters by `action_type = 'claim'` to avoid confusion.

## Questions for User

Since Option B (separate rows) is preferred:

1. **Scope of Comet events**: Should we capture ALL Comet pool events (deposit, withdraw, swap) or only the `deposit` events triggered by the Backstop contract? Capturing all gives more flexibility for future use cases.

2. **Table naming**: Is `comet_pool_events` a good name, or would you prefer something else?

3. **Additional fields**: The Comet pool deposit also returns the LP tokens minted. Should we capture that as well (it would match the `lp_tokens` in the backstop claim event)?

4. **gulp_emissions**: When `gulp_emissions` happens, it also deposits BLND to Comet. Should we link those as well, or only user claims?
