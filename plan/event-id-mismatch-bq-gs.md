# Event ID Mismatch Between BigQuery and Goldsky

## Problem Statement

Events ingested from BigQuery (BQ) and Goldsky (GS) for the same transaction have different event IDs, causing duplicate records instead of proper deduplication.

**Example:**
| Source | ID | Event Index |
|--------|-----|-------------|
| BigQuery | `60241041-8278f6a8...-op-0-event-0` | 0 |
| Goldsky | `60241041-8278f6a8...-op-0-event-1` | 1 |

Both records represent the **same event** (identical user, amount, action_type) but have different IDs.

## ID Format

The event ID format is: `{ledger}-{tx_hash}-op-{op_index}-event-{event_index}`

- `ledger` = ledger_sequence
- `tx_hash` = transaction_hash
- `op_index` = operation index within transaction (`operation_id - transaction_id - 1`)
- `event_index` = **event index within the operation** (this is the problem)

## Root Cause Analysis

### How Goldsky Assigns Event Index

Goldsky receives the `id` field directly from the Stellar events dataset (`stellar.events`). This ID contains the **actual event emission order** from the Soroban VM - the sequence in which events were emitted during contract execution.

### How BigQuery Backfill Assigns Event Index

The BQ backfill constructs the ID manually using:

```sql
ROW_NUMBER() OVER (
  PARTITION BY ledger_sequence, transaction_hash, operation_id
  ORDER BY JSON_VALUE(topics_decoded, '$[0].symbol')  -- Orders by action_type alphabetically
) - 1 AS event_index
```

**Problems with this approach:**

1. **Only counts filtered events**: BQ backfill only sees events matching our action types (`claim`, `supply`, etc.). Other events (`fn_call`, `fn_return`, `transfer`, `fee`, `core_metrics`) are excluded from the count.

2. **Alphabetical ordering**: When multiple events have the same action_type (e.g., two `claim` events), the order is non-deterministic.

3. **NULL operation_id**: Some events in BigQuery have `operation_id = NULL`, making ID construction unreliable.

### Example: Transaction 8278f6a8...

This transaction contains multiple events in the same operation:

| Event Type | Count |
|------------|-------|
| core_metrics | 19 |
| fn_call | 2 |
| fn_return | 2 |
| transfer | 2 |
| fee | 2 |
| claim | 2 |

Goldsky counts ALL events and assigns `claim` as `event-1` (because `fn_call` is `event-0`).

BQ backfill only sees the `claim` events, filters to one (valid operation_id), and assigns `event-0`.

## BigQuery Data Issues

1. **Duplicate records**: Two `claim` events exist with identical `topics_decoded` and `data_decoded`
2. **NULL operation_id**: One record has `operation_id = NULL`
3. **No native event index**: BigQuery doesn't store the original Stellar event sequence number

## Potential Solutions

### Option 1: Reconstruct Event Index from ALL Events

Modify the BQ query to:
1. Fetch ALL events for each operation (not just filtered action types)
2. Order events to match Stellar's emission order (TBD: what order?)
3. Assign event indices based on position
4. Then filter to only the action types we want

**Challenge**: We don't know what ORDER BY clause would match Stellar's emission order.

### Option 2: Content-Based Deduplication

Instead of relying on ID matching, detect duplicates based on:
- `transaction_hash`
- `action_type`
- `user_address`
- `amount_underlying` (or `lp_tokens` for backstop)

**Challenge**: Legitimate duplicate events (same user, same amount, same action in one tx) would be incorrectly deduplicated.

### Option 3: Filter NULL operation_id + Use Natural Order

1. Filter out events with `operation_id IS NULL`
2. Use `ROW_NUMBER() OVER (PARTITION BY operation_id)` without ORDER BY
3. Hope that BigQuery's natural row order matches Stellar's emission order

**Challenge**: BigQuery doesn't guarantee row order without ORDER BY.

### Option 4: Cross-Reference with Goldsky

When inserting BQ records:
1. Check if a GS record exists with matching `(tx_hash, action_type, user_address, amount)`
2. If yes, use the GS record's ID instead of constructing a new one
3. If no, construct ID as before

**Challenge**: Requires DB lookup for every insert, slower performance.

### Option 5: Prefer Goldsky, Use BQ for Historical Only

- Use Goldsky for real-time/recent data (correct IDs)
- Use BQ backfill only for historical data before Goldsky pipeline started
- Accept that BQ IDs won't match GS format for historical data

**Challenge**: Need to handle ID conflicts when GS catches up to historical data.

## Investigation Needed

1. **Determine Stellar's event ordering**: What order does Stellar emit events within an operation? Is it deterministic?

2. **Check BigQuery natural order**: Does BigQuery's default row order (without ORDER BY) match Stellar's emission order?

3. **Examine contract_event_xdr**: Does the raw XDR contain an event index or sequence?

4. **Test Option 1**: Query all events in an operation and see if any ordering matches Goldsky's indices.

## Affected Files

- `src/services/bigquery-actions-backfill.ts` - Actions backfill (lines 127-148)
- `src/services/bigquery-backstop-backfill.ts` - Backstop backfill (lines 137-154)

## Recommended Solution

**Content-based deduplication during BQ insert**

Since:
1. Goldsky doesn't store `contract_event_xdr`
2. BigQuery doesn't have the correct event index
3. Both sources have identical parsed content (`topics`, `data`)

The recommended approach:

### Implementation

1. Before inserting BQ records, check if a GS record exists with matching:
   - `transaction_hash`
   - `pool_id` (for actions) or `contract_id` (for backstop)
   - `action_type`
   - `user_address`
   - `ledger_sequence`

2. If match found → **skip BQ insert** (GS record has correct ID)

3. If no match → **insert with constructed ID** (historical data before GS pipeline started)

### Why This Works

- GS records have correct IDs from Stellar
- BQ backfill is primarily for historical data before GS pipeline existed
- For overlapping data, GS takes precedence
- Avoids duplicate records with mismatched IDs

### Additional Fix: Filter NULL operation_id

Also filter out events with `operation_id IS NULL` in BQ queries to avoid malformed/duplicate records:

```sql
WHERE operation_id IS NOT NULL
```

## Next Steps

1. Add `operation_id IS NOT NULL` filter to BQ backfill queries
2. Implement content-based duplicate check in `insertBatch()` methods
3. Test with known mismatched events (ledger 60241041)
4. Consider adding a `content_hash` column for future-proofing (optional)
