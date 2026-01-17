# LP Token Price Backfill - UI Update Plan

## Goal
Update LP Token Price Backfill to match the functionality of other backfill components (Actions/Backstop):
1. Add date range selection
2. Add ability to run directly from UI (with BigQuery dry run/estimate)
3. Add simulation/preview before actual execution

---

## Current State

**Frontend:** [LpPriceBackfill.tsx](frontend/src/components/LpPriceBackfill.tsx)
- Simple 2-step workflow: copy query → upload JSON file manually
- No date range selection (query uses hardcoded start date)
- No cost estimation
- No preview/simulate capability
- Preview mode only works on uploaded files

**Backend:** [bigquery.ts:1945-2116](src/api/routes/bigquery.ts)
- `GET /api/bigquery/lp-prices/stats` - Get statistics
- `GET /api/bigquery/lp-prices/query` - Get static query template
- `GET /api/bigquery/lp-prices/data` - Fetch existing prices
- `POST /api/bigquery/lp-prices/upload` - Upload JSON file

**Service:** [lp-price-backfill.ts](src/services/lp-price-backfill.ts)
- `getBigQueryQuery(startDate, endDate?)` - Already supports date range!
- `runBackfill()` - Only processes uploaded files

---

## Proposed Changes

### 1. Backend - New Endpoints

Add to `src/api/routes/bigquery.ts`:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/lp-prices/estimate` | POST | Get cost estimate for date range query |
| `/lp-prices/simulate` | POST | Preview data with limit (dry run) |
| `/lp-prices/backfill` | POST | Execute backfill directly from BigQuery |

**Request payload (all 3 endpoints):**
```typescript
{
  startDate?: string    // YYYY-MM-DD
  endDate?: string      // YYYY-MM-DD
  limit?: number        // For simulate/preview
}
```

**Estimate response:**
```typescript
{
  success: boolean
  gb: string           // Data size to process
  cost: string         // Estimated USD cost
  query: string        // The query that would run
}
```

**Simulate response:**
```typescript
{
  success: boolean
  rows_count: number
  estimated_cost: string
  rows: LpPriceRow[]   // Preview of data (limited)
  query: string
}
```

**Backfill response:**
```typescript
{
  success: boolean
  rows_fetched: number
  rows_inserted: number
  rows_skipped: number
  estimated_cost: string
}
```

### 2. Backend - Service Updates

Update `src/services/lp-price-backfill.ts`:

- Add `getEstimate(startDate, endDate)` - Dry run query to get cost
- Add `simulate(startDate, endDate, limit)` - Run query with limit, return preview
- Add `runFromBigQuery(startDate, endDate)` - Execute full query and insert to DB

### 3. Frontend - UI Updates

Update `frontend/src/components/LpPriceBackfill.tsx`:

**Add state for:**
```typescript
type RangeType = 'days' | 'dateRange'

const [rangeType, setRangeType] = useState<RangeType>('days')
const [daysBack, setDaysBack] = useState('30')
const [startDate, setStartDate] = useState('')
const [endDate, setEndDate] = useState('')
const [mode, setMode] = useState<'query' | 'upload'>('query')
```

**Add UI sections:**
1. Mode toggle (Run Query vs Upload JSON)
2. Range type selector (Days Back vs Date Range)
3. Date inputs based on range type
4. Three action buttons: "Get Cost Estimate" → "Preview Data" → "Run Backfill"
5. Cost estimate display
6. Data preview table
7. Keep existing JSON upload as alternative mode

---

## Implementation Order

1. **Backend service** - Add estimate/simulate/backfill methods
2. **Backend routes** - Add new API endpoints
3. **Frontend** - Update UI with date range and new workflow

---

## Questions Before Implementation

1. Should we keep the JSON upload mode as a fallback, or replace it entirely with the BigQuery-direct approach?
2. For the date range, should we also support ledger range like Backstop/Actions do, or just dates?
3. What should be the default "days back" value? (Currently thinking 30 days)

---

## Files to Modify

- `src/services/lp-price-backfill.ts` - Add new methods
- `src/api/routes/bigquery.ts` - Add new endpoints
- `frontend/src/components/LpPriceBackfill.tsx` - Update UI

No new files needed.
