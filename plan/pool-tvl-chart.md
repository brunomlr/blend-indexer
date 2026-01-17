# Daily TVL Snapshots Plan

## Overview
Create a system for storing daily TVL (Total Value Locked) snapshots for pools and tokens, including both supply TVL and borrow amounts.

## Current State Analysis

### Existing Data (pool_snapshots table)
- **Date Range**: April 14, 2025 - January 5, 2026 (267 days)
- **Total Records**: 3,048 rows
- **Coverage**: 24 unique pool-asset pairs across 5 pools
- **Problem**: Data is **sparse** - only captures days when events occur (not daily snapshots)

### Pools Tracked
| Pool | Short Name | Start Date | Assets |
|------|-----------|------------|--------|
| YieldBlox | YieldBlox | Apr 17, 2025 | 8 assets (XLM, USDC, EURC, AQUA, CETES, etc.) |
| Fixed | Fixed | Apr 14, 2025 | 3 assets (XLM, USDC, EURC) |
| Orbit | Orbit | May 1, 2025 | 4 assets (XLM, oUSD, CETES, USTRY) |
| Forex | Forex | Jul 14, 2025 | 4 assets (XLM, USDx, EURx, GBPx) |
| Etherfuse | Etherfuse | Nov 24, 2025 | 5 assets (XLM, USDC, CETES, TESOURO, USTRY) |

### Data Coverage Issue
Current `pool_snapshots` only has data on days with activity:
- Fixed/USDC: 266 of 267 days (almost complete)
- YieldBlox/USDC: 263 of 267 days
- Etherfuse pools: Only ~20 days each (started Nov 24)
- Many pool-assets have significant gaps

---

## TVL Calculation

### Formula
For each pool-asset pair:

```
Supply TVL (in token units) = b_supply * b_rate
Borrow Amount (in token units) = d_supply * d_rate
Net TVL = Supply TVL - Borrow Amount
```

Where:
- `b_supply`: Total bTokens in circulation (supply receipt tokens)
- `b_rate`: Interest rate index for supply (starts at 1, grows over time)
- `d_supply`: Total dTokens in circulation (debt receipt tokens)
- `d_rate`: Interest rate index for debt (starts at 1, grows faster than b_rate)

### USD Conversion
To get TVL in USD:
```
Supply TVL USD = (b_supply * b_rate) * token_usd_price
Borrow Amount USD = (d_supply * d_rate) * token_usd_price
```

Token prices are available in `daily_token_prices` table (Nov 26, 2024 - Jan 7, 2026).

### Example (YieldBlox/USDC on Jan 5, 2026)
```
b_supply = 6,045,356.13
b_rate = 1.097056148826
d_supply = 4,722,103.86
d_rate = 1.145781733521

Supply TVL = 6,045,356.13 * 1.097 = 6,631,875.58 USDC
Borrow Amount = 4,722,103.86 * 1.146 = 5,411,426.15 USDC
Net TVL = 1,220,449.43 USDC
```

---

## Proposed New Table: `daily_tvl_snapshots`

```sql
CREATE TABLE daily_tvl_snapshots (
    id SERIAL PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    pool_id VARCHAR(56) NOT NULL,
    asset_address VARCHAR(56) NOT NULL,

    -- Raw values from pool data
    b_supply NUMERIC(20,7),
    d_supply NUMERIC(20,7),
    b_rate NUMERIC(20,12),
    d_rate NUMERIC(20,12),

    -- Calculated TVL in token units
    supply_tvl NUMERIC(30,7),        -- b_supply * b_rate
    borrow_amount NUMERIC(30,7),     -- d_supply * d_rate

    -- USD values (if price available)
    supply_tvl_usd NUMERIC(20,2),
    borrow_amount_usd NUMERIC(20,2),
    token_price_usd NUMERIC(20,10),

    -- Metadata
    source VARCHAR(20) DEFAULT 'backfill',  -- 'backfill', 'daily_snapshot', 'event'
    ledger_sequence BIGINT,
    created_at TIMESTAMP DEFAULT NOW(),

    UNIQUE(pool_id, asset_address, snapshot_date)
);

-- Indexes for common queries
CREATE INDEX idx_tvl_date ON daily_tvl_snapshots(snapshot_date);
CREATE INDEX idx_tvl_pool ON daily_tvl_snapshots(pool_id);
CREATE INDEX idx_tvl_pool_date ON daily_tvl_snapshots(pool_id, snapshot_date);
```

---

## Backfill Approaches

### Option A: Forward Fill from April 14, 2025 (Recommended)

**Approach**: Use existing event data from `pool_snapshots`, fill gaps by carrying forward the last known values.

**Process**:
1. For each pool-asset pair, get the first event date
2. For each day from first_event_date to today:
   - If there's an event on that day: use that data
   - If no event: carry forward the previous day's values (rates will be slightly stale but supplies are correct)
3. Join with `daily_token_prices` for USD values

**Pros**:
- Uses existing data, no external dependencies
- Simple to implement
- Accurate supply values (b_supply, d_supply don't change without events)
- Gaps represent no activity, so forward-fill is semantically correct

**Cons**:
- Interest rates (b_rate, d_rate) are slightly stale on forward-filled days
- Rate staleness is typically <0.01% per day for most pools
- Some pools started later (Forex Jul 2025, Etherfuse Nov 2025)

**Accuracy Assessment**:
- `b_supply` and `d_supply`: 100% accurate (only change on events)
- `b_rate` and `d_rate`: ~99.9% accurate (compound slowly)
- Example: 10% APY = ~0.026% daily rate change. Missing 1 day = 0.026% error.

---

### Option B: Backward from Current SDK Values

**Approach**: Use the Blend SDK to get current values, then work backwards calculating what the rates should have been.

**Process**:
1. Use SDK to get current pool state (b_supply, d_supply, b_rate, d_rate)
2. Work backwards applying reverse interest calculations

**Pros**:
- Current values guaranteed to match SDK
- Could be more accurate for recent data

**Cons**:
- Requires complex reverse interest calculations
- Interest rate model is non-trivial (varies by utilization)
- Historical supply changes still need event data
- More complex implementation
- Still needs event data for supply changes (can't reverse those)
- **Not feasible** for supplies - only rates could theoretically be reverse-calculated

---

### Option C: Hybrid Approach

**Approach**: Use forward-fill for historical data, but calibrate against current SDK values.

**Process**:
1. Forward-fill from April 14, 2025 to yesterday
2. Use SDK for today's snapshot (guaranteed accurate)
3. Check if latest forward-filled values match SDK within tolerance
4. If significant drift, investigate and correct

**Pros**:
- Historical data available immediately
- Current data always accurate
- Built-in validation mechanism

**Cons**:
- Extra complexity
- May show small jumps when SDK values differ from forward-filled

---

## Recommendation: Option A (Forward Fill)

**Reasoning**:
1. **Supply values are exact** - b_supply and d_supply only change on events
2. **Rate drift is minimal** - typically <0.03% per day
3. **Simpler implementation** - no reverse calculations needed
4. **Data already available** - no external API calls required
5. **Forward fill is semantically correct** - no activity means no change

### Expected Accuracy
For a chart showing daily TVL over time:
- Supply amounts: 100% accurate
- Interest rate effect: ~99.97% accurate per day
- USD values: Dependent on price accuracy (separate concern)

---

## Implementation Steps

### Phase 1: Database Setup
1. Create `daily_tvl_snapshots` table
2. Add necessary indexes
3. Create view for aggregated pool TVL (sum across all assets)

### Phase 2: Backfill Script
1. Query all unique pool-asset pairs from `pool_snapshots`
2. For each pair:
   - Get min/max dates
   - Generate continuous date series
   - Forward-fill gaps
   - Calculate TVL values
   - Join with token prices for USD
3. Insert into `daily_tvl_snapshots`

### Phase 3: Daily Snapshot GitHub Action
1. Create workflow that runs daily (e.g., 00:05 UTC)
2. For each pool-asset pair:
   - Get latest values from `pool_snapshots` or SDK
   - Calculate TVL
   - Insert snapshot
3. Add error alerting

### Phase 4: API Endpoints
1. `/api/tvl/pool/:poolId` - Pool TVL over time
2. `/api/tvl/pool/:poolId/asset/:assetAddress` - Asset TVL over time
3. `/api/tvl/total` - Total protocol TVL
4. Support date range filtering

---

## Open Questions for Discussion

1. **Start Date**: Should we start from April 14, 2025 (earliest data) or only when each pool/asset first has activity?

2. **Missing Pools Early Data**: Forex starts Jul 2025, Etherfuse starts Nov 2025. Show as zero before their start dates or omit?

3. **Price Gaps**: What to do when token price is missing for a day? (Forward-fill price too?)

4. **Granularity**: Daily snapshots sufficient, or need more frequent for high-activity pools?

5. **Storage**: Keep raw values (b_supply, b_rate) or just calculated TVL? (Recommend both for flexibility)

---

## Next Steps

1. Review and approve this plan
2. Create database migration for new table
3. Implement backfill script
4. Test with single pool first
5. Run full backfill
6. Set up daily GitHub Action
7. Build API endpoints
