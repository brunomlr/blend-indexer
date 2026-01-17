# CSV Upload Feature for BigQuery UI

## Status: IMPLEMENTED

## Overview
Add the ability to:
1. Display the BigQuery queries that will be run in the UI
2. Allow users to upload a CSV file with query results instead of running the query
3. Process the uploaded CSV data and insert into the database

## Current State
- Queries are already returned from `/api/bigquery/actions/simulate` and `/api/bigquery/backstop/simulate` endpoints (in `query` field)
- However, the queries are NOT displayed in the UI currently
- Data processing logic exists in `transformRows()` methods in the services

## Implementation Plan

### Phase 1: Display Queries in UI

#### Frontend Changes

**1. ActionsBackfill.tsx**
- Add state for query: `const [query, setQuery] = useState<string | null>(null)`
- Update `SimulateResult` interface to include `query?: string`
- Update `simulate()` function to extract and store query from response
- Add a new "Show Query" section after cost estimate that displays the query
- Style with monospace font, syntax highlighting optional, copy button

**2. BackstopBackfill.tsx**
- Same changes as ActionsBackfill.tsx

#### UI Design for Query Display
```
┌─────────────────────────────────────────────────────┐
│ BigQuery Query                              [Copy]  │
├─────────────────────────────────────────────────────┤
│ WITH events_with_index AS (                         │
│   SELECT ...                                        │
│   FROM `crypto-stellar.crypto_stellar...`           │
│   WHERE ...                                         │
│ )                                                   │
│ SELECT ...                                          │
└─────────────────────────────────────────────────────┘
```

### Phase 2: CSV Upload Backend

#### New API Endpoints

**1. POST /api/bigquery/actions/upload-csv**
- Accepts multipart form data with CSV file
- Parses CSV (use `csv-parse` or `papaparse` library)
- Validates CSV columns match expected schema:
  - `id`, `pool_id`, `transaction_hash`, `ledger_sequence`, `ledger_closed_at`
  - `action_type`, `asset_address`, `user_address`, `amount_underlying`, `amount_tokens`
  - `implied_rate`, `auction_type`, `filler_address`, `liquidation_percent`
  - `bid_asset`, `bid_amount`, `lot_asset`, `lot_amount`
- Uses existing `transformRows()` logic
- Calls `actionsRepository.insertBatch()`
- Returns same response format as backfill endpoint

**2. POST /api/bigquery/backstop/upload-csv**
- Same pattern for backstop events
- Expected columns:
  - `id`, `transaction_hash`, `ledger_sequence`, `ledger_closed_at`
  - `action_type`, `pool_address`, `user_address`
  - `lp_tokens`, `shares`, `q4w_exp`

#### File Structure
```
src/api/routes/bigquery.ts       # Add new routes
src/services/csv-processor.ts     # New file for CSV parsing/validation
```

### Phase 3: CSV Upload Frontend

#### UI Components

**1. New CSVUpload component**
- File input (accepts .csv)
- Drag & drop zone
- File preview (show first 5 rows)
- Upload button
- Progress indicator
- Result display

**2. Integration into ActionsBackfill/BackstopBackfill**
- Add tab or toggle: "Run Query" | "Upload CSV"
- When "Upload CSV" selected:
  - Show the query for reference
  - Show CSV upload component
  - Hide range selection controls

#### UI Design
```
┌─────────────────────────────────────────────────────┐
│ [Run Query]  [Upload CSV]                           │
├─────────────────────────────────────────────────────┤
│                                                     │
│ Run the query below in BigQuery Console and        │
│ export results as CSV, then upload here:           │
│                                                     │
│ ┌─────────────────────────────────────────────┐    │
│ │ DROP CSV FILE HERE                          │    │
│ │           or click to browse                │    │
│ └─────────────────────────────────────────────┘    │
│                                                     │
│ [Upload and Process]                                │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Dependencies to Add
- `multer` - for handling file uploads (may already be installed)
- `csv-parse` or `papaparse` - for CSV parsing

## Files to Modify/Create

### Backend
1. `src/api/routes/bigquery.ts` - Add CSV upload endpoints
2. `src/services/csv-processor.ts` (NEW) - CSV parsing and validation

### Frontend
1. `frontend/src/components/ActionsBackfill.tsx` - Add query display + CSV upload
2. `frontend/src/components/BackstopBackfill.tsx` - Add query display + CSV upload
3. `frontend/src/components/ui/CSVUpload.tsx` (NEW) - Reusable CSV upload component

## Expected CSV Format

### Blend Actions CSV
```csv
id,pool_id,transaction_hash,ledger_sequence,ledger_closed_at,action_type,asset_address,user_address,amount_underlying,amount_tokens,implied_rate,auction_type,filler_address,liquidation_percent,bid_asset,bid_amount,lot_asset,lot_amount
57000000-abc123...-op-0-event-0,CABC...,abc123...,57000000,2024-01-15T10:30:00Z,supply,CUSDC...,GUSER...,1000000,999000,1.001,,,,,,,
```

### Backstop Events CSV
```csv
id,transaction_hash,ledger_sequence,ledger_closed_at,action_type,pool_address,user_address,lp_tokens,shares,q4w_exp
57000000-abc123...-op-0-event-0,abc123...,57000000,2024-01-15T10:30:00Z,deposit,CPOOL...,GUSER...,1000000,999000,
```

## Testing Plan
1. Run "Get Cost Estimate" - verify query is displayed
2. Run "Preview Data" - verify query updates if params change
3. Export query results from BigQuery Console as CSV
4. Upload CSV - verify data is processed and inserted
5. Verify counts match between direct backfill and CSV upload
