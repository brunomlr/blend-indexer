# Plan: Historical Backstop Q4W Percentage Backfill

## Overview

**Goal**: Capture historical daily Q4W (Queue for Withdrawal) percentage for each blend backstop pool.

**Q4W Percentage** = `(q4w_shares / total_shares) * 100`

This metric shows what percentage of backstop deposits are currently queued for withdrawal, which is important for:
- Assessing backstop liquidity/stability
- Understanding depositor sentiment over time
- Risk analysis for lending pools

---

## Current State

### What We Have
| Data | Table | Status |
|------|-------|--------|
| Backstop events (deposit, withdraw, queue_withdrawal, etc.) | `backstop_events` | ✅ Have |
| Current pool balance (shares, tokens, q4w) | Via Blend SDK | ✅ Live only |
| Historical lending pool rates | `pool_snapshots` | ✅ Have |

### What We Need
| Data | Source | Status |
|------|--------|--------|
| Historical daily backstop pool balance (shares, tokens, q4w) | Hubble `contract_data` | ❌ Need to implement |

---

## Data Source

### Hubble BigQuery `contract_data` Table

Similar to how LP price backfill queries `contract_data` for Comet pool storage, we need to query the backstop contract's storage for pool balance data.

**Backstop Contract**: `CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7`

### Discovered Storage Structure ✅

**Storage Key**: `PoolBalance`

```json
// Key structure
{"vec":[{"symbol":"PoolBalance"},{"address":"POOL_ADDRESS"}]}

// Value structure (map keys in alphabetical order)
{
  "map": [
    {"key":{"symbol":"q4w"},"val":{"i128":"0"}},
    {"key":{"symbol":"shares"},"val":{"i128":"7753012859021"}},
    {"key":{"symbol":"tokens"},"val":{"i128":"7753012859021"}}
  ]
}
```

**JSON Paths**:
| Field | Path |
|-------|------|
| Pool Address | `$.vec[1].address` (from key_decoded) |
| q4w | `$.map[0].val.i128` (from val_decoded) |
| shares | `$.map[1].val.i128` (from val_decoded) |
| tokens | `$.map[2].val.i128` (from val_decoded) |

**Pools Found in Sample Data**:
- `CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS`
- `CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD`
- `CBNR7PYFY775UG7W37B4OJG2OBBUKLFW6VIBHFDKKLR2HECPRMRZMDK3`

---

## Database Schema

### New Table: `backstop_pool_snapshots`

```sql
CREATE TABLE backstop_pool_snapshots (
  id SERIAL PRIMARY KEY,
  pool_address VARCHAR(56) NOT NULL,        -- The lending pool being backed
  snapshot_date DATE NOT NULL,
  snapshot_timestamp TIMESTAMP NOT NULL,
  ledger_sequence BIGINT NOT NULL,

  -- Raw values from contract storage
  shares NUMERIC(38, 0) NOT NULL,           -- Total backstop shares
  tokens NUMERIC(38, 0) NOT NULL,           -- Total LP tokens deposited
  q4w NUMERIC(38, 0) NOT NULL,              -- Shares queued for withdrawal

  -- Calculated fields
  q4w_pct NUMERIC(10, 4),                   -- (q4w / shares) * 100

  -- Metadata
  src VARCHAR(10) DEFAULT 'bq',             -- 'bq' = BigQuery, 'gs' = Goldsky
  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(pool_address, snapshot_date)
);

CREATE INDEX idx_backstop_pool_snapshots_lookup
  ON backstop_pool_snapshots(pool_address, snapshot_date);

CREATE INDEX idx_backstop_pool_snapshots_date
  ON backstop_pool_snapshots(snapshot_date DESC);
```

---

## BigQuery Query

```sql
WITH daily_snapshots AS (
  SELECT
    DATE(closed_at) as snapshot_date,
    closed_at,
    ledger_sequence,
    JSON_EXTRACT_SCALAR(key_decoded, '$.vec[1].address') as pool_address,
    -- Map is alphabetically ordered: q4w, shares, tokens
    CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.map[0].val.i128') AS NUMERIC) as q4w,
    CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.map[1].val.i128') AS NUMERIC) as shares,
    CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.map[2].val.i128') AS NUMERIC) as tokens,
    ROW_NUMBER() OVER (
      PARTITION BY
        DATE(closed_at),
        JSON_EXTRACT_SCALAR(key_decoded, '$.vec[1].address')
      ORDER BY ledger_sequence DESC
    ) as rn
  FROM `crypto-stellar.crypto_stellar.contract_data`
  WHERE contract_id = 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7'
    AND JSON_EXTRACT_SCALAR(key_decoded, '$.vec[0].symbol') = 'PoolBalance'
    AND closed_at >= '${startDate}'
    AND closed_at < '${endDate}'
)
SELECT
  pool_address,
  snapshot_date,
  closed_at as snapshot_timestamp,
  ledger_sequence,
  shares,
  tokens,
  q4w,
  CASE
    WHEN shares > 0 THEN ROUND((q4w * 100.0 / shares), 4)
    ELSE 0
  END as q4w_pct
FROM daily_snapshots
WHERE rn = 1  -- Take last snapshot of each day per pool
ORDER BY pool_address, snapshot_date
```

### Cost Estimate Query

```sql
-- Dry run to estimate cost
SELECT COUNT(*)
FROM `crypto-stellar.crypto_stellar.contract_data`
WHERE contract_id = 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7'
  AND JSON_EXTRACT_SCALAR(key_decoded, '$.vec[0].symbol') = 'PoolBalance'
  AND closed_at >= '2025-04-14'
```

---

## Implementation Components

### 1. Backfill Service

**File**: `src/services/backstop-q4w-backfill.ts`

Similar to `LpPriceBackfillService`, with:

```
BackstopQ4wBackfillService
├── getBigQueryQuery(startDate, endDate)
├── getCostEstimate(params)
├── simulate(params)           -- Dry run, returns sample data
├── runFromBigQuery(params)    -- Execute and save to DB
└── getStats()                 -- Current DB statistics
```

**Parameters**:
```typescript
interface BackstopQ4wBackfillParams {
  startDate?: string;   // Default: '2025-04-14' (Blend v2 launch)
  endDate?: string;     // Default: today
  poolAddress?: string; // Optional: filter to specific pool
  limit?: number;       // For testing/simulation
}
```

### 2. Repository

**File**: `src/repositories/backstop-pool-snapshot-repository.ts`

```
BackstopPoolSnapshotRepository
├── insertBatch(rows)
├── getStats()
├── getLatestSnapshotDate()
├── getByPoolAndDateRange(poolAddress, startDate, endDate)
└── getQ4wPercentageHistory(poolAddress)
```

### 3. API Endpoints

**File**: Add to `src/api/routes/bigquery.ts`

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/bigquery/backstop-q4w/estimate` | POST | Get cost estimate |
| `/api/bigquery/backstop-q4w/simulate` | POST | Dry run with sample data |
| `/api/bigquery/backstop-q4w/execute` | POST | Run backfill |
| `/api/bigquery/backstop-q4w/stats` | GET | Current DB stats |

### 4. CLI Script

**File**: `src/scripts/run-backstop-q4w-backfill.ts`

```bash
# Usage examples
npm run backfill:backstop-q4w                           # Full backfill
npm run backfill:backstop-q4w -- --start-date 2025-05-01
npm run backfill:backstop-q4w -- --pool CAxxxx...       # Single pool
npm run backfill:backstop-q4w -- --dry-run              # Simulation only
```

---

## Tracked Pools

From `TRACKED_POOLS` in [pools.ts](../src/lib/blend/pools.ts):

| Pool Name | Pool Address |
|-----------|--------------|
| YieldBlox | `CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS` |
| Blend Pool | `CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD` |
| Orbit | `CAE7QVOMBLZ53CDRGK3UNRRHG5EZ5NQA7HHTFASEMYBWHG6MDFZTYHXC` |
| Forex | `CBYOBT7ZCCLQCBUYYIABZLSEGDPEUWXCUXQTZYOG3YBDR7U357D5ZIRF` |
| Etherfuse | `CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI` |

**Note**: The BigQuery discovery found these pools in backstop data:
- `CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS` (YieldBlox) ✅
- `CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD` (Blend Pool) ✅
- `CBNR7PYFY775UG7W37B4OJG2OBBUKLFW6VIBHFDKKLR2HECPRMRZMDK3` (Unknown - may be older/inactive pool)

---

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     Hubble BigQuery                              │
│  crypto-stellar.crypto_stellar.contract_data                     │
│  (backstop contract storage history)                             │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                BackstopQ4wBackfillService                        │
│  - Query contract_data for pool balance storage                  │
│  - Extract shares, tokens, q4w per pool per day                  │
│  - Calculate q4w_pct                                             │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│              backstop_pool_snapshots (PostgreSQL)                │
│  pool_address | snapshot_date | shares | tokens | q4w | q4w_pct │
└─────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      API / Frontend                              │
│  Historical Q4W percentage charts per pool                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Steps

### Phase 1: Discovery ✅ COMPLETED

- [x] Run storage key discovery query on BigQuery
- [x] Identify exact JSON paths for `shares`, `tokens`, `q4w`
- [x] Verify data exists for expected date range
- [x] Update this plan with actual key/value structure

**Results**:
- Storage key: `PoolBalance`
- JSON paths confirmed: `$.map[0].val.i128` (q4w), `$.map[1].val.i128` (shares), `$.map[2].val.i128` (tokens)
- Data available from 2025-04-14 (Blend v2 launch)

### Phase 2: Database ✅ COMPLETED

- [x] Create `backstop_pool_snapshots` table
- [x] Create indexes
- [x] Create repository class

**Files created**:
- `src/repositories/backstop-pool-snapshot-repository.ts`
- `src/scripts/migrate-backstop-pool-snapshots.ts`
- `src/types/index.ts` (added `BackstopPoolSnapshotRow`)

### Phase 3: Backfill Service ✅ COMPLETED

- [x] Create `BackstopQ4wBackfillService`
- [x] Implement `getBigQueryQuery()` with discovered paths
- [x] Implement `getCostEstimate()`
- [x] Implement `simulate()`
- [x] Implement `runFromBigQuery()`

**File created**: `src/services/backstop-q4w-backfill.ts`

### Phase 4: API & CLI ✅ COMPLETED

- [x] Add API endpoints to bigquery routes
- [x] Create CLI script
- [x] Add npm scripts to package.json

**Files modified/created**:
- `src/api/routes/bigquery.ts` (added `/backstop-q4w/*` endpoints)
- `src/scripts/run-backstop-q4w-backfill.ts`
- `package.json` (added `backfill:backstop-q4w` and `migrate:backstop-snapshots` scripts)

### Phase 5: Testing & Backfill

- [ ] Run migration: `npm run migrate:backstop-snapshots`
- [ ] Run simulation to verify data: `npm run backfill:backstop-q4w -- --dry-run`
- [ ] Get cost estimate for full backfill
- [ ] Execute full backfill: `npm run backfill:backstop-q4w -- --yes`
- [ ] Verify data integrity

---

## Cost Estimate

Based on LP price backfill patterns:
- `contract_data` table is large (~TB)
- Date-based partition pruning is critical
- Expected cost: $0.50 - $2.00 for full backfill (April 2025 to present)

---

## Open Questions

1. ~~**Storage key format**: Need to run discovery query to confirm exact key/value structure~~ ✅ RESOLVED
2. **Real-time updates**: Should Goldsky also capture contract state changes for live updates?
3. **Historical gaps**: How to handle days with no contract state changes? (Carry forward last known value)

---

## Related Files

**New files (this feature)**:
- [backstop-q4w-backfill.ts](../src/services/backstop-q4w-backfill.ts) - Backfill service
- [backstop-pool-snapshot-repository.ts](../src/repositories/backstop-pool-snapshot-repository.ts) - Repository
- [run-backstop-q4w-backfill.ts](../src/scripts/run-backstop-q4w-backfill.ts) - CLI script
- [migrate-backstop-pool-snapshots.ts](../src/scripts/migrate-backstop-pool-snapshots.ts) - Migration script

**Reference files**:
- [lp-price-backfill.ts](../src/services/lp-price-backfill.ts) - Similar pattern for contract_data queries
- [bigquery-backstop-backfill.ts](../src/services/bigquery-backstop-backfill.ts) - Backstop events backfill
- [backstop-repository.ts](../src/repositories/backstop-repository.ts) - Backstop events repository
- [fetch-emission-configs.ts](../src/scripts/fetch-emission-configs.ts) - Current state fetching via SDK
