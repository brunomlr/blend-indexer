# New ID Format Plan

## Context

Following investigation of event ID mismatches between BigQuery (BQ) and Goldsky (GS), we identified:

1. **137 duplicate records** existed in Neon (cleaned up on 2024-12-11)
2. **Root cause**: Old backfill runs before `operation_id IS NOT NULL` filter ingested events with NULL operation_id
3. **BigQuery limitation**: No native `event_index` field - we use `ROW_NUMBER()` which is non-deterministic

## Current ID Format (BACKUP)

```
{ledger}-{tx_hash}-op-{op_index}-event-{event_index}
```

**Example:** `60194413-0f57a1f898...f7fc-op-0-event-4`

### Current BQ Actions ID Construction (backup)
```sql
-- From bigquery-actions-backfill.ts lines 127-149
WITH events_with_index AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY ledger_sequence, transaction_hash, operation_id
      ORDER BY JSON_VALUE(topics_decoded, '$[0].symbol')
    ) - 1 AS event_index
  FROM `crypto-stellar.crypto_stellar.history_contract_events`
  WHERE ...
)
SELECT
  CONCAT(
    CAST(ledger_sequence AS STRING), '-',
    transaction_hash, '-op-',
    CAST((operation_id - transaction_id - 1) AS STRING), '-event-',
    CAST(event_index AS STRING)
  ) AS id,
  ...
```

### Current GS Actions ID (backup)
```yaml
# From pipeline-blend-actions.yaml line 31-32
# Uses Goldsky's native unique event ID directly
id,
```

### Current GS Unified Pipeline ID (backup)
```yaml
# From pipeline_unified_blend-events.yaml
# Uses Goldsky's native unique event ID directly for both transforms

# parsed_backstop_events transform (lines 37-180):
parsed_backstop_events:
  type: sql
  primary_key: id
  sql: |-
    SELECT
            -- Unique event ID
            id,
            transaction_hash,
            ledger_sequence,
            ledger_closed_at,
            -- ... rest of backstop fields ...
    FROM backstop_events
    WHERE JSON_VALUE(topics, '$[0].symbol') IN (...)

# parsed_events transform (lines 159-311):
parsed_events:
  type: sql
  primary_key: id
  sql: |-
    SELECT
            -- Use Goldsky's native unique event ID
            id,
            contract_id AS pool_id,
            transaction_hash,
            ledger_sequence,
            ledger_closed_at,
            -- ... rest of actions fields ...
    FROM blend_events
    WHERE JSON_VALUE(topics, '$[0].symbol') IN (...)
```

### Current BQ Backstop ID Construction (backup)
```sql
-- From bigquery-backstop-backfill.ts lines 138-156
WITH events_with_index AS (
  SELECT
    *,
    ROW_NUMBER() OVER (
      PARTITION BY ledger_sequence, transaction_hash, operation_id
      ORDER BY action_type
    ) - 1 AS event_index
  FROM ...
)
SELECT
  CONCAT(
    CAST(ledger_sequence AS STRING), '-',
    IFNULL(transaction_hash, 'unknown'), '-op-',
    CAST(IFNULL(operation_id - transaction_id - 1, 0) AS STRING), '-event-',
    CAST(IFNULL(event_index, 0) AS STRING)
  ) AS id,
  ...
```

---

## New ID Format (Proposed)

```
{ledger}-{content_hash_16chars}
```

**Example:** `60194413-8ec5db9b11bc5974`

**Note:** `transaction_hash` is included IN the hash calculation (not raw in ID) to save storage space.
The `transaction_hash` is still stored as a separate column for querying.

---

## Field Extraction Comparison: Actions (parsed_events)

| Field | BQ Path | GS Path | Notes |
|-------|---------|---------|-------|
| pool_id | contract_id | contract_id | Same |
| action_type | topics_decoded[0].symbol | topics[0].symbol | Same |
| asset_address | topics_decoded[1 or 2].address | topics[1 or 2].address | Conditional on action_type |
| user_address | topics_decoded[1 or 2].address | topics[1 or 2].address | Conditional on action_type |
| amount_underlying | data_decoded.vec[0 or 1].i128 | data.vec[0 or 1].i128 | Conditional, with .lo fallback |
| amount_tokens | data_decoded.vec[1].i128 | data.vec[1].i128 | With .lo fallback |
| implied_rate | CALCULATED | CALCULATED | Division of amounts - NOT in hash |
| auction_type | topics_decoded[1].u32 | topics[1].u32 | Auctions only |
| filler_address | data_decoded.vec[0].address | data.vec[0].address | fill_auction only |
| liquidation_percent | data_decoded.vec[0].u32 or vec[1].i128 | data.vec[0].u32 or vec[1].i128 | Conditional |
| bid_asset | data_decoded.vec[1 or 2].map[0]... | data.vec[1 or 2].map[0]... | Auctions |
| bid_amount | data_decoded.vec[1 or 2].map[0]... | data.vec[1 or 2].map[0]... | Auctions |
| lot_asset | data_decoded.vec[1 or 2].map[2]... | data.vec[1 or 2].map[2]... | Auctions |
| lot_amount | data_decoded.vec[1 or 2].map[2]... | data.vec[1 or 2].map[2]... | Auctions |

---

## Field Extraction Comparison: Backstop (backstop_events)

| Field | BQ Path | GS Path | Notes |
|-------|---------|---------|-------|
| pool_address | topics_decoded[1].address | topics[1].address | NULL for claim |
| action_type | topics_decoded[0].symbol | topics[0].symbol | Same |
| user_address | topics_decoded[1 or 2].address | topics[1 or 2].address | Conditional |
| lp_tokens | data_decoded.vec[0 or 1].i128 or $.i128 | data.vec[0 or 1].i128 or $.i128 | Conditional |
| shares | data_decoded.vec[0 or 1].i128 or $.i128 | data.vec[0 or 1].i128 or $.i128 | Conditional |
| q4w_exp | data_decoded.vec[1].u64 | data.vec[1].u64 | queue_withdrawal only |
| emissions_amount | data_decoded.vec[0].i128 | data.vec[0].i128 | gulp_emissions only |
| emissions_shares | data_decoded.vec[1].i128 | data.vec[1].i128 | gulp_emissions only |

---

## New Content Hash Formula: Actions (PARSED VALUES)

**IMPORTANT**: The hash is computed from **PARSED/EXTRACTED values**, NOT raw JSON paths.
This ensures consistency across BQ (via CTE), GS (via CASE expressions), and PostgreSQL migration (using stored columns).

Hash the same values that get stored in the database columns:

```sql
-- BQ version (via CTE that extracts parsed values first)
-- See bigquery-actions-backfill.ts for full CTE
SUBSTR(TO_HEX(SHA256(CONCAT(
  COALESCE(transaction_hash, ''),
  COALESCE(pool_id, ''),           -- = contract_id
  COALESCE(action_type, ''),       -- Extracted via CASE
  COALESCE(asset_address, ''),     -- Extracted via CASE (NULL for auctions)
  COALESCE(user_address, ''),      -- Extracted via CASE
  COALESCE(amount_underlying, ''), -- Extracted via CASE (STRING)
  COALESCE(amount_tokens, ''),     -- Extracted via CASE (STRING)
  COALESCE(auction_type, ''),      -- Extracted via CASE (STRING)
  COALESCE(filler_address, ''),    -- Extracted via CASE
  COALESCE(liquidation_percent, ''), -- Extracted via CASE (STRING)
  COALESCE(bid_asset, ''),         -- Extracted via CASE
  COALESCE(bid_amount, ''),        -- Extracted via CASE (STRING)
  COALESCE(lot_asset, ''),         -- Extracted via CASE
  COALESCE(lot_amount, '')         -- Extracted via CASE (STRING)
))), 1, 16) AS content_hash
```

```sql
-- GS version (Flink SQL - hashes the same CASE expressions used for columns)
-- See pipeline-blend-actions.yaml and pipeline_unified_blend-events.yaml
SUBSTRING(SHA2(CONCAT(
  COALESCE(transaction_hash, ''),
  COALESCE(contract_id, ''),        -- pool_id
  COALESCE(action_type, ''),        -- Via JSON_VALUE
  COALESCE(asset_address_expr, ''), -- Via same CASE as column
  COALESCE(user_address_expr, ''),  -- Via same CASE as column
  COALESCE(amount_underlying_expr, ''), -- Via same CASE (as STRING)
  COALESCE(amount_tokens_expr, ''), -- Via same CASE (as STRING)
  COALESCE(auction_type_expr, ''),  -- Via same CASE (as STRING)
  COALESCE(filler_address_expr, ''),-- Via same CASE
  COALESCE(liquidation_percent_expr, ''), -- Via same CASE (as STRING)
  COALESCE(bid_asset_expr, ''),     -- Via same CASE
  COALESCE(bid_amount_expr, ''),    -- Via same CASE (as STRING)
  COALESCE(lot_asset_expr, ''),     -- Via same CASE
  COALESCE(lot_amount_expr, '')     -- Via same CASE (as STRING)
), 256), 1, 16) AS content_hash
```

```sql
-- PostgreSQL migration (uses stored column values directly)
SUBSTRING(ENCODE(SHA256(CONCAT(
  COALESCE(transaction_hash, ''),
  COALESCE(pool_id, ''),
  COALESCE(action_type, ''),
  COALESCE(asset_address, ''),
  COALESCE(user_address, ''),
  COALESCE(amount_underlying::TEXT, ''),
  COALESCE(amount_tokens::TEXT, ''),
  COALESCE(auction_type::TEXT, ''),
  COALESCE(filler_address, ''),
  COALESCE(liquidation_percent::TEXT, ''),
  COALESCE(bid_asset, ''),
  COALESCE(bid_amount::TEXT, ''),
  COALESCE(lot_asset, ''),
  COALESCE(lot_amount::TEXT, '')
)::BYTEA), 'hex'), 1, 16) AS content_hash
```

---

## New Content Hash Formula: Backstop (PARSED VALUES)

**IMPORTANT**: The hash is computed from **PARSED/EXTRACTED values**, NOT raw JSON paths.

```sql
-- BQ version (via CTE that extracts parsed values first)
-- See bigquery-backstop-backfill.ts for full CTE
SUBSTR(TO_HEX(SHA256(CONCAT(
  COALESCE(transaction_hash, ''),
  COALESCE(action_type, ''),       -- Extracted via JSON_VALUE
  COALESCE(pool_address, ''),      -- Extracted via CASE (NULL for claim)
  COALESCE(user_address, ''),      -- Extracted via CASE
  COALESCE(lp_tokens, ''),         -- Extracted via CASE (STRING)
  COALESCE(shares, ''),            -- Extracted via CASE (STRING)
  COALESCE(q4w_exp, ''),           -- Extracted via CASE (STRING)
  COALESCE(emissions_amount, ''),  -- Extracted via CASE (STRING)
  COALESCE(emissions_shares, '')   -- Extracted via CASE (STRING)
))), 1, 16) AS content_hash
```

```sql
-- GS version (Flink SQL - hashes the same CASE expressions used for columns)
-- See pipeline-backstop.yaml and pipeline_unified_blend-events.yaml
SUBSTRING(SHA2(CONCAT(
  COALESCE(transaction_hash, ''),
  COALESCE(action_type, ''),        -- Via JSON_VALUE
  COALESCE(pool_address_expr, ''),  -- Via same CASE as column
  COALESCE(user_address_expr, ''),  -- Via same CASE as column
  COALESCE(lp_tokens_expr, ''),     -- Via same CASE (as STRING)
  COALESCE(shares_expr, ''),        -- Via same CASE (as STRING)
  COALESCE(q4w_exp_expr, ''),       -- Via same CASE (as STRING)
  COALESCE(emissions_amount_expr, ''), -- Via same CASE (as STRING)
  COALESCE(emissions_shares_expr, '') -- Via same CASE (as STRING)
), 256), 1, 16) AS content_hash
```

```sql
-- PostgreSQL migration (uses stored column values directly)
SUBSTRING(ENCODE(SHA256(CONCAT(
  COALESCE(transaction_hash, ''),
  COALESCE(action_type, ''),
  COALESCE(pool_address, ''),
  COALESCE(user_address, ''),
  COALESCE(lp_tokens::TEXT, ''),
  COALESCE(shares::TEXT, ''),
  COALESCE(q4w_exp::TEXT, ''),
  COALESCE(emissions_amount::TEXT, ''),
  COALESCE(emissions_shares::TEXT, '')
)::BYTEA), 'hex'), 1, 16) AS content_hash
```

---

## New Full ID Construction

```sql
-- BQ Actions & Backstop
CONCAT(
  CAST(ledger_sequence AS STRING), '-',
  -- content_hash (which includes transaction_hash)
) AS id

-- GS Actions & Backstop (pipeline YAML)
CONCAT(
  CAST(ledger_sequence AS STRING), '-',
  -- content_hash (which includes transaction_hash)
) AS id
```

---

## Tables Affected

| Table | Source | Current ID Format | New ID Format |
|-------|--------|-------------------|---------------|
| `parsed_events` | BQ Actions backfill | `{ledger}-{tx}-op-{op}-event-{idx}` (~90 chars) | `{ledger}-{hash16}` (~25 chars) |
| `parsed_events` | GS Actions pipeline | Goldsky native ID (~90 chars) | `{ledger}-{hash16}` (~25 chars) |
| `backstop_events` | BQ Backstop backfill | `{ledger}-{tx}-op-{op}-event-{idx}` (~90 chars) | `{ledger}-{hash16}` (~25 chars) |
| `backstop_events` | GS Backstop pipeline | Goldsky native ID (~90 chars) | `{ledger}-{hash16}` (~25 chars) |

**Storage savings:** ~70% reduction in ID column size

---

## Implementation Plan

### Phase 1: Test & Validate
- [x] Create test query for known event
- [x] Verify hash produces unique values per event
- [ ] Test hash consistency between BQ and GS for same event (if possible)

### Phase 2: Update BigQuery Backfill
- [x] Modify `bigquery-actions-backfill.ts` - replace ROW_NUMBER ID with content hash of PARSED values (via CTE)
- [x] Modify `bigquery-backstop-backfill.ts` - replace ROW_NUMBER ID with content hash of PARSED values (via CTE)
- [ ] Test with simulation mode

### Phase 3: Update Goldsky Pipelines
- [x] Modify `pipeline-blend-actions.yaml` - replace native `id` with content hash of PARSED values
- [x] Modify `pipeline-backstop.yaml` - replace native `id` with content hash of PARSED values
- [x] Modify `pipeline_unified_blend-events.yaml` - replace native `id` with content hash of PARSED values
- [ ] Deploy updated pipelines

### Phase 4: Migrate Existing Data
- [x] Create migration SQL script for `parsed_events` table (uses stored columns = parsed values)
- [x] Create migration SQL script for `backstop_events` table (uses stored columns = parsed values)
- [ ] Test migration on sample data
- [ ] Execute migration (update all existing IDs to new format)
- [ ] Verify data integrity after migration

---

## Migration Script: parsed_events

```sql
-- Migration query to update existing parsed_events IDs to new format
-- Uses PARSED VALUES (stored columns) - matches BQ CTE and GS CASE expressions
-- Run this AFTER updating BQ backfill code but BEFORE re-ingesting

-- Step 1: Add temporary column for new ID
ALTER TABLE parsed_events ADD COLUMN new_id TEXT;

-- Step 2: Calculate new IDs based on content hash of PARSED values
-- This matches the hash formula in bigquery-actions-backfill.ts and pipeline-blend-actions.yaml
UPDATE parsed_events SET new_id = CONCAT(
  CAST(ledger_sequence AS TEXT), '-',
  SUBSTRING(ENCODE(SHA256(CONCAT(
    COALESCE(transaction_hash, ''),
    COALESCE(pool_id, ''),
    COALESCE(action_type, ''),
    COALESCE(asset_address, ''),
    COALESCE(user_address, ''),
    COALESCE(amount_underlying::TEXT, ''),
    COALESCE(amount_tokens::TEXT, ''),
    COALESCE(auction_type::TEXT, ''),
    COALESCE(filler_address, ''),
    COALESCE(liquidation_percent::TEXT, ''),
    COALESCE(bid_asset, ''),
    COALESCE(bid_amount::TEXT, ''),
    COALESCE(lot_asset, ''),
    COALESCE(lot_amount::TEXT, '')
  )::BYTEA), 'hex'), 1, 16)
);

-- Step 3: Verify no duplicates in new IDs
SELECT new_id, COUNT(*)
FROM parsed_events
GROUP BY new_id
HAVING COUNT(*) > 1;

-- Step 4: If no duplicates, swap IDs
-- DROP old primary key constraint first
ALTER TABLE parsed_events DROP CONSTRAINT IF EXISTS parsed_events_pkey;
UPDATE parsed_events SET id = new_id;
ALTER TABLE parsed_events ADD PRIMARY KEY (id);
ALTER TABLE parsed_events DROP COLUMN new_id;
```

---

## Migration Script: backstop_events

```sql
-- Migration query to update existing backstop_events IDs to new format
-- Uses PARSED VALUES (stored columns) - matches BQ CTE and GS CASE expressions

-- Step 1: Add temporary column for new ID
ALTER TABLE backstop_events ADD COLUMN new_id TEXT;

-- Step 2: Calculate new IDs based on content hash of PARSED values
-- This matches the hash formula in bigquery-backstop-backfill.ts and pipeline-backstop.yaml
-- NOTE: Does NOT include contract_id - only the parsed/stored values
UPDATE backstop_events SET new_id = CONCAT(
  CAST(ledger_sequence AS TEXT), '-',
  SUBSTRING(ENCODE(SHA256(CONCAT(
    COALESCE(transaction_hash, ''),
    COALESCE(action_type, ''),
    COALESCE(pool_address, ''),
    COALESCE(user_address, ''),
    COALESCE(lp_tokens::TEXT, ''),
    COALESCE(shares::TEXT, ''),
    COALESCE(q4w_exp::TEXT, ''),
    COALESCE(emissions_amount::TEXT, ''),
    COALESCE(emissions_shares::TEXT, '')
  )::BYTEA), 'hex'), 1, 16)
);

-- Step 3: Verify no duplicates in new IDs
SELECT new_id, COUNT(*)
FROM backstop_events
GROUP BY new_id
HAVING COUNT(*) > 1;

-- Step 4: If no duplicates, swap IDs
ALTER TABLE backstop_events DROP CONSTRAINT IF EXISTS backstop_events_pkey;
UPDATE backstop_events SET id = new_id;
ALTER TABLE backstop_events ADD PRIMARY KEY (id);
ALTER TABLE backstop_events DROP COLUMN new_id;
```

---

## Questions Resolved

1. **Same ID format for all sources?** YES - BQ, GS, CSV will all use content hash
2. **Downstream dependencies on current format?** NO
3. **Migration strategy?** Migrate IDs (update existing records with new format)
4. **Include tx_hash in ID?** NO - include in hash calculation only, saves ~70% storage

---

## Files to Modify

- `src/services/bigquery-actions-backfill.ts` (lines 127-149) ✅
- `src/services/bigquery-backstop-backfill.ts` (lines 138-156) ✅
- `stellar-events-stream/goldsky/pipeline-blend-actions.yaml` (lines 30-32) ✅
- `stellar-events-stream/goldsky/pipeline-backstop.yaml` (equivalent lines) ✅
- `stellar-events-stream/goldsky/pipeline_unified_blend-events.yaml` (parsed_backstop_events + parsed_events) ✅

---

## Related Documents

- [Event ID Mismatch Investigation](./event-id-mismatch-bq-gs.md)
