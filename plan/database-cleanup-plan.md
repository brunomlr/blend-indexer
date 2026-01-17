# Database Cleanup Plan

Analysis of empty tables created during development. **No deletions will be made until user approval.**

## Summary

| Status | Tables | Views |
|--------|--------|-------|
| Empty (candidates for cleanup) | 7 | 6 (dependent on empty tables) |
| Has Data (keep) | 8 | 0 |

---

## Empty Tables (Candidates for Cleanup)

### 1. `blend_actions` - **RECOMMENDED: DROP**
- **Purpose**: Main Goldsky pipeline for blend actions (supply, withdraw, borrow, repay, claim)
- **Created by**: `stellar-events-stream/src/db/migrate.ts`
- **Why empty**: Goldsky streaming was never connected/configured
- **Dependencies**: 6 views depend on this table (v_derived_rates, v_user_positions, v_latest_rates, v_daily_rates, v_user_claims, v_user_total_claims)
- **Impact**: Low - we use `parsed_events` (358K rows from BigQuery backfill) instead

### 2. `blend_events` - **RECOMMENDED: DROP**
- **Purpose**: Raw Blend events for Goldsky direct postgres sink
- **Created by**: `stellar-events-stream/src/db/migrate.ts`
- **Why empty**: Goldsky not configured
- **Dependencies**: None
- **Impact**: None - intermediate table never used

### 3. `blend_events_parsed` - **RECOMMENDED: DROP**
- **Purpose**: Parsed Blend events from Goldsky transform
- **Created by**: `stellar-events-stream/src/db/migrate.ts`
- **Why empty**: Goldsky not configured
- **Dependencies**: None
- **Impact**: None - intermediate table never used

### 4. `blend_res_data` - **RECOMMENDED: DROP**
- **Purpose**: ResData from Goldsky transform (b_rate, d_rate, supplies)
- **Created by**: `stellar-events-stream/src/db/migrate.ts`
- **Why empty**: Goldsky not configured
- **Dependencies**: None
- **Impact**: None - we use BigQuery data instead

### 5. `raw_events` - **RECOMMENDED: DROP**
- **Purpose**: Debug/audit storage for raw Stellar events
- **Created by**: `stellar-events-stream/src/db/migrate.ts`
- **Why empty**: Never used for debugging
- **Dependencies**: None
- **Impact**: None - debugging table

### 6. `user_positions` - **KEEP (empty but needed)**
- **Purpose**: Daily user position snapshots (supply/collateral/liabilities)
- **Created by**: `src/scripts/setup-db.ts`, `src/scripts/recreate-user-positions.ts`
- **Why empty**: Table was recreated but backfill never run
- **Dependencies**: Referenced by API routes (`/api/positions/*`)
- **Impact**: HIGH if removed - breaks API endpoints
- **Action needed**: Run backfill or decide if this feature is needed

### 7. `pools` - **KEEP (empty but needed)**
- **Purpose**: Pool reference table (name, version, is_active)
- **Created by**: Referenced in code but CREATE TABLE not found (may be created manually)
- **Why empty**: `sync-pools-tokens.ts` script never run
- **Dependencies**: Referenced by `explore-repository.ts` for pool listings
- **Impact**: HIGH if removed - breaks explore API
- **Action needed**: Run `npx ts-node src/scripts/sync-pools-tokens.ts`

---

## Views Depending on Empty Tables

All views depend on `blend_actions` which is empty, making them non-functional:

| View | Depends On | Purpose |
|------|------------|---------|
| `v_derived_rates` | blend_actions | Calculate implied rates from actions |
| `v_user_positions` | blend_actions | Aggregate user positions from actions |
| `v_latest_rates` | v_derived_rates | Latest rate per asset |
| `v_daily_rates` | v_derived_rates | Daily rate snapshots |
| `v_user_claims` | blend_actions | User claim events |
| `v_user_total_claims` | blend_actions | Total claims per user |

**RECOMMENDATION**: Drop all views since they serve no purpose without `blend_actions`.

---

## Tables With Data (KEEP)

| Table | Rows | Purpose |
|-------|------|---------|
| `tokens` | 2 | Token metadata (symbol, decimals) |
| `emission_configs` | 24 | EPS values per pool/asset |
| `pool_snapshots` | 481 | Daily pool b_rate/d_rate/supply |
| `daily_emission_apy` | 2,268 | Calculated BLND emission APY |
| `daily_token_prices` | 4,103 | Historical token prices |
| `daily_rates` | 4,401 | Historical interest rates |
| `backstop_events` | 19,871 | Backstop deposit/withdraw/claim events |
| `parsed_events` | 358,179 | All Blend actions from BigQuery |

---

## Cleanup Actions

### Phase 1: Drop Unused Views (Safe)
```sql
-- Views that depend on empty blend_actions
DROP VIEW IF EXISTS v_user_total_claims;
DROP VIEW IF EXISTS v_user_claims;
DROP VIEW IF EXISTS v_daily_rates;
DROP VIEW IF EXISTS v_latest_rates;
DROP VIEW IF EXISTS v_user_positions;
DROP VIEW IF EXISTS v_derived_rates;
```

### Phase 2: Drop Goldsky-related Tables (Safe)
```sql
-- Tables created for Goldsky that were never used
DROP TABLE IF EXISTS blend_res_data;
DROP TABLE IF EXISTS blend_events_parsed;
DROP TABLE IF EXISTS blend_events;
DROP TABLE IF EXISTS raw_events;
DROP TABLE IF EXISTS blend_actions;
```

### Phase 3: Populate Required Tables
```bash
# Populate the pools table
npx ts-node src/scripts/sync-pools-tokens.ts
```

### Phase 4 (Optional): Decision on user_positions
The `user_positions` table is empty but the schema and API endpoints exist.
- If feature is needed: Run user positions backfill
- If feature is not needed: Drop table and remove API routes

---

## Summary Decision Matrix

| Table | Rows | Action | Reason |
|-------|------|--------|--------|
| blend_actions | 0 | DROP | Goldsky never configured, using parsed_events |
| blend_events | 0 | DROP | Goldsky never configured |
| blend_events_parsed | 0 | DROP | Goldsky never configured |
| blend_res_data | 0 | DROP | Goldsky never configured |
| raw_events | 0 | DROP | Debug table never used |
| pools | 0 | **KEEP** | Needed by explore API, run sync script |
| user_positions | 0 | **KEEP** | Has API routes, decide on feature |

---

## Migration Script

Once approved, a single migration script can clean up:

```typescript
// src/scripts/cleanup-empty-tables.ts

const VIEWS_TO_DROP = [
  'v_user_total_claims',
  'v_user_claims',
  'v_daily_rates',
  'v_latest_rates',
  'v_user_positions',
  'v_derived_rates',
];

const TABLES_TO_DROP = [
  'blend_res_data',
  'blend_events_parsed',
  'blend_events',
  'raw_events',
  'blend_actions',
];

// Drops views first (due to dependencies), then tables
```

---

## Code Files to Update

After dropping tables from the database, these files should be updated to stay in sync:

### 1. `stellar-events-stream/src/db/migrate.ts`

**Remove CREATE TABLE statements for:**
- `blend_events` (lines 64-75)
- `blend_events_parsed` (lines 77-90)
- `blend_res_data` (lines 92-106)
- `blend_actions` (lines 108-124)
- `raw_events` (lines 49-61)

**Remove CREATE INDEX statements for:**
- `blend_events_pool_idx`, `blend_events_type_idx`, `blend_events_ledger_idx`
- `blend_actions_pool_idx`, `blend_actions_user_idx`, `blend_actions_asset_idx`, `blend_actions_type_idx`, `blend_actions_ledger_idx`, `blend_actions_user_asset_idx`
- `raw_events_contract_idx`, `raw_events_ledger_idx`

**Remove CREATE VIEW statements for:**
- `v_derived_rates`
- `v_user_positions`
- `v_latest_rates`
- `v_daily_rates`
- `v_user_claims`
- `v_user_total_claims`

### 2. `stellar-events-stream/src/db/schema.ts`

**Remove Drizzle schema definition for:**
- `rawEvents` table definition and types (lines 87-104)

**Keep:**
- `backstopEvents` (has 19K rows of data)
- All other schemas

### 3. Files that reference empty tables (check if still needed)

| File | References | Action |
|------|------------|--------|
| `src/scripts/sync-pools-tokens.ts` | `blend_actions` | Check if table exists before querying (already does this) |
| `src/services/sync-pools-tokens.ts` | `blend_actions` | Check if table exists before querying (already does this) |
| `src/api/routes/bigquery.ts` | `blend_actions` | Review and update |

---

*Plan created: 2026-01-04*
*Status: COMPLETED*

## Cleanup Log

- **Database tables dropped**: `blend_actions`, `blend_events`, `blend_events_parsed`, `blend_res_data`, `raw_events`
- **Database views dropped**: `v_derived_rates`, `v_user_positions`, `v_latest_rates`, `v_daily_rates`, `v_user_claims`, `v_user_total_claims`
- **Code updated**:
  - `stellar-events-stream/src/db/migrate.ts` - Removed CREATE TABLE/INDEX/VIEW for dropped objects
  - `stellar-events-stream/src/db/schema.ts` - Removed `rawEvents` Drizzle schema
  - `stellar-events-stream/src/services/blend-event-handler.ts` - Removed rawEvents imports and methods
