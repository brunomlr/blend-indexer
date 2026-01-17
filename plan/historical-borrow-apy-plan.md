# Historical Borrow APY Calculation - Plan

## Context

There are **two types of APY** in Blend:

1. **Emission APY** (already implemented) - BLND token rewards for participating
2. **Interest APY** (this plan) - The actual interest rate borrowers pay / lenders earn

This plan covers calculating **historical Interest APY** (specifically borrow APY, but supply APY uses the same approach).

---

## What We Currently Have

### Data Available

| Table | Column | Description | Status |
|-------|--------|-------------|--------|
| `pool_snapshots` | `d_rate` | Borrow interest rate accumulator | **Have it** (481 rows) |
| `pool_snapshots` | `b_rate` | Supply interest rate accumulator | **Have it** |
| `pool_snapshots` | `snapshot_date` | Daily snapshots | **Have it** |
| `pool_snapshots` | `pool_id` | Pool identifier | **Have it** |
| `pool_snapshots` | `asset_address` | Asset identifier | **Have it** |
| `daily_token_prices` | `usd_price` | Asset prices | **Have it** (4,103 rows) |

### Understanding Rate Accumulators

In Blend (like Aave/Compound), `b_rate` and `d_rate` are **accumulators** that grow over time:
- They start at 1.0 (or 1e9 in fixed-point)
- They increase as interest accrues
- The rate of increase IS the interest rate

**Example:**
- Day 1: `d_rate = 1.000000`
- Day 2: `d_rate = 1.000274` (grew by 0.0274% in one day)
- Annualized: `(1.000274)^365 - 1 = 10.5%` APY

---

## What's Needed for Calculation

### Formula

```
daily_rate_change = d_rate_today / d_rate_yesterday - 1
borrow_apy = ((1 + daily_rate_change)^365 - 1) * 100
```

For supply APY, use `b_rate` instead of `d_rate`.

### Required Data

| Requirement | Status | Notes |
|-------------|--------|-------|
| Daily d_rate values | **YES** | In `pool_snapshots` |
| Consecutive day snapshots | **PARTIAL** | Need to verify coverage |
| Asset prices (optional) | **YES** | Only if showing in USD terms |

### Gap Analysis

**What we need to verify:**

1. **Date coverage** - Do we have consecutive daily snapshots for the full date range?
   ```sql
   SELECT
     pool_id,
     asset_address,
     MIN(snapshot_date) as first_date,
     MAX(snapshot_date) as last_date,
     COUNT(*) as total_days,
     COUNT(*) / (MAX(snapshot_date) - MIN(snapshot_date) + 1)::float as coverage
   FROM pool_snapshots
   GROUP BY pool_id, asset_address;
   ```

2. **Rate value sanity** - Are d_rate values sensible?
   ```sql
   SELECT
     pool_id,
     asset_address,
     MIN(d_rate) as min_d_rate,
     MAX(d_rate) as max_d_rate,
     AVG(d_rate) as avg_d_rate
   FROM pool_snapshots
   GROUP BY pool_id, asset_address;
   ```

---

## Implementation Options

### Option A: Store Pre-calculated APY (Recommended)

Create a new table `daily_interest_apy`:

```sql
CREATE TABLE daily_interest_apy (
  id SERIAL PRIMARY KEY,
  rate_date DATE NOT NULL,
  pool_address VARCHAR(56) NOT NULL,
  asset_address VARCHAR(56) NOT NULL,

  -- Raw rate values
  b_rate NUMERIC(20, 12) NOT NULL,
  d_rate NUMERIC(20, 12) NOT NULL,
  prev_b_rate NUMERIC(20, 12),
  prev_d_rate NUMERIC(20, 12),

  -- Calculated APY (percentage)
  supply_apy NUMERIC(10, 4),  -- e.g., 5.25 means 5.25%
  borrow_apy NUMERIC(10, 4),

  -- Metadata
  source VARCHAR(20) DEFAULT 'pool_snapshots',
  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT daily_interest_apy_unique
    UNIQUE (rate_date, pool_address, asset_address)
);
```

**Pros:**
- Fast queries for frontend
- Consistent with `daily_emission_apy` pattern
- Can add to existing backfill script

**Cons:**
- Another table to maintain
- Data duplication (rates stored in two places)

### Option B: Calculate On-the-fly with SQL View

```sql
CREATE VIEW v_daily_interest_apy AS
WITH rate_changes AS (
  SELECT
    snapshot_date as rate_date,
    pool_id as pool_address,
    asset_address,
    b_rate,
    d_rate,
    LAG(b_rate) OVER (PARTITION BY pool_id, asset_address ORDER BY snapshot_date) as prev_b_rate,
    LAG(d_rate) OVER (PARTITION BY pool_id, asset_address ORDER BY snapshot_date) as prev_d_rate
  FROM pool_snapshots
)
SELECT
  rate_date,
  pool_address,
  asset_address,
  b_rate,
  d_rate,
  -- Supply APY: ((b_rate / prev_b_rate)^365 - 1) * 100
  CASE
    WHEN prev_b_rate > 0 AND prev_b_rate IS NOT NULL
    THEN (POWER(b_rate / prev_b_rate, 365) - 1) * 100
    ELSE NULL
  END as supply_apy,
  -- Borrow APY: ((d_rate / prev_d_rate)^365 - 1) * 100
  CASE
    WHEN prev_d_rate > 0 AND prev_d_rate IS NOT NULL
    THEN (POWER(d_rate / prev_d_rate, 365) - 1) * 100
    ELSE NULL
  END as borrow_apy
FROM rate_changes
WHERE prev_d_rate IS NOT NULL;
```

**Pros:**
- No additional storage
- Always calculated from source data
- No backfill needed

**Cons:**
- Slower queries (window function every time)
- Complex for frontend to consume

---

## Recommendation

**Use Option A** (pre-calculated table) because:
1. Matches existing pattern (`daily_emission_apy`)
2. Better query performance for frontend
3. Can be added to existing backfill script
4. Allows storing additional metadata (utilization, etc.)

---

## Implementation Steps

### Phase 1: Verify Data
1. Run verification queries above
2. Identify any gaps in daily snapshots
3. Verify d_rate values are sensible (should be > 1.0 and growing)

### Phase 2: Create Table
1. Create `daily_interest_apy` table
2. Add indexes for common query patterns

### Phase 3: Backfill Script
1. Add `--interest` flag to `backfill-emission-apy.ts` OR
2. Create new script `backfill-interest-apy.ts`

### Phase 4: Frontend Integration
1. Add API endpoint for interest APY
2. Update frontend to show combined APY (interest + emission)

---

## Total APY Display

For a complete user experience, show:

```
YieldBlox Pool - USDC Supply
├── Base Interest APY:  4.25%  (from d_rate accumulator)
├── BLND Rewards:      +0.87%  (emission APY)
└── Total APY:          5.12%

YieldBlox Pool - USDC Borrow
├── Base Interest APY:  6.50%  (cost to borrower)
├── BLND Rewards:      -1.23%  (reduces effective cost)
└── Net Cost:           5.27%
```

---

## Questions Resolved

1. **Date range** - Same as emission APY: V2 launch (2025-04-14) to today, default 30 days for backfill
2. **Averaging** - Daily values (same as emission APY)
3. **Missing days** - Skip days with gaps (if no previous day rate, APY = NULL for that day)

---

*Plan created: 2026-01-05*
*Status: READY FOR IMPLEMENTATION*
