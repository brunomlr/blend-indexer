# Plan: Track gulp_emissions Data

## Overview
Add new columns to `backstop_events` table to capture the emissions data from `gulp_emissions` events.

## Event Structure
```json
topics: [{"symbol":"gulp_emissions"}, {"address":"<pool_address>"}]
data: {"vec":[{"i128":"<emissions_amount>"}, {"i128":"<emissions_shares>"}]}
```

## Changes Required

### 1. Database Schema (`stellar-events-stream/src/db/schema.ts`)
Add two new columns to `backstopEvents` table:
- `emissions_amount` - numeric(38,0) - BLND tokens gulped (vec[0])
- `emissions_shares` - numeric(38,0) - shares/tokens delta (vec[1])

### 2. Database Migration
Run SQL to add columns to existing table:
```sql
ALTER TABLE backstop_events
ADD COLUMN emissions_amount NUMERIC(38,0),
ADD COLUMN emissions_shares NUMERIC(38,0);
```

### 3. Goldsky Pipeline (`stellar-events-stream/goldsky/pipeline-backstop.yaml`)
Update `parsed_backstop_events` transform to extract:
```sql
-- Emissions amount (gulp_emissions only)
CASE
  WHEN JSON_VALUE(topics, '$[0].symbol') = 'gulp_emissions'
  THEN CAST(COALESCE(
    JSON_VALUE(data, '$.vec[0].i128'),
    JSON_VALUE(data, '$.vec[0].i128.lo')
  ) AS DECIMAL)
  ELSE NULL
END AS emissions_amount,

-- Emissions shares (gulp_emissions only)
CASE
  WHEN JSON_VALUE(topics, '$[0].symbol') = 'gulp_emissions'
  THEN CAST(COALESCE(
    JSON_VALUE(data, '$.vec[1].i128'),
    JSON_VALUE(data, '$.vec[1].i128.lo')
  ) AS DECIMAL)
  ELSE NULL
END AS emissions_shares
```

### 4. BigQuery Backfill Service (`src/services/bigquery-backstop-backfill.ts`)
Add extraction for the two new fields in `buildQuery()`:
```sql
-- Emissions amount (gulp_emissions only)
CASE
  WHEN action_type = 'gulp_emissions' THEN CAST(COALESCE(
    JSON_VALUE(data_decoded, '$.vec[0].i128'),
    JSON_VALUE(data_decoded, '$.vec[0].i128.lo')
  ) AS STRING)
  ELSE NULL
END AS emissions_amount,

-- Emissions shares (gulp_emissions only)
CASE
  WHEN action_type = 'gulp_emissions' THEN CAST(COALESCE(
    JSON_VALUE(data_decoded, '$.vec[1].i128'),
    JSON_VALUE(data_decoded, '$.vec[1].i128.lo')
  ) AS STRING)
  ELSE NULL
END AS emissions_shares
```

### 5. Backstop Repository (`src/repositories/backstop-repository.ts`)
Update `BackstopEventRow` interface and insert logic to include new fields.

## Execution Order
1. Run database migration (add columns)
2. Update schema.ts
3. Update backstop-repository.ts
4. Update bigquery-backstop-backfill.ts
5. Update pipeline-backstop.yaml
6. Redeploy Goldsky pipeline
7. Backfill historical gulp_emissions data

## Notes
- New columns are nullable since only `gulp_emissions` events will have values
- Existing data won't have these values - need backfill for historical gulp events
- Pipeline version needs to be bumped when redeploying
