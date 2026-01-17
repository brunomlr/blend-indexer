# Plan: BLND Emission APY Calculation

## Overview

This plan covers calculating and storing historical BLND emission APY for:
1. **Backstop depositors** - per-pool EPS from backstop contract
2. **Lending pool users** - per-asset supply/borrow EPS from pool contracts

**Key Finding**: The Blend SDK uses a simple formula based on `eps` (emissions per second) stored in each contract. We can replicate this for historical data.

---

## How Blend SDK Calculates Emission APY

From `@blend-capital/blend-sdk/dist/esm/emissions.js`:

```javascript
emissionsPerYearPerToken(supply, decimals) {
    const totalEmissions = (eps / 10^epsDecimals) * 31536000;  // annual BLND
    return totalEmissions / (supply / 10^decimals);            // per token
}
```

**Formula:**
```
emissions_per_year_per_token = (eps × 31,536,000) / total_supply
```

**To convert to APY %:**
```
emission_apy = emissions_per_year_per_token × blnd_price / asset_price × 100
```

---

## Key Constants

| Constant | Value |
|----------|-------|
| Blend v2 Launch Date | April 14, 2025 |
| Seconds per Year | 31,536,000 |
| EPS Decimals (V2) | 14 (both lending and backstop) |
| Backstop ID | `CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7` |
| BLND Token | `CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY` |
| Comet LP Token | `CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM` |

---

## Architecture Decision

### What to Store in DB

| Data | Store? | Reason |
|------|--------|--------|
| EPS configs | ✅ Yes | Constant since launch, query once |
| Historical daily APY | ✅ Yes | Pre-calculated for fast chart queries |
| Current/live APY | ❌ No | Frontend calculates from current prices |

### Data Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Contract Query  │────▶│ emission_configs │────▶│ Historical APY  │
│ (one-time)      │     │ (static table)   │     │ Calculation     │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ pool_snapshots  │────▶│ daily_emission_  │◀────│ daily_token_    │
│ (b/d_supply)    │     │ apy              │     │ prices          │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                │
                                ▼
                        ┌─────────────────┐
                        │ Frontend Charts │
                        │ (historical)    │
                        └─────────────────┘

┌─────────────────┐     ┌──────────────────┐
│ emission_configs│────▶│ Frontend Live   │◀──── Current prices (API)
│ (eps values)    │     │ APY Calculation │◀──── Current supply (API)
└─────────────────┘     └──────────────────┘
```

---

## Database Schema

### Table 1: Emission Configs (One-Time Fetch)

```sql
-- Store EPS values from contract (assumed constant since v2 launch)
CREATE TABLE emission_configs (
  id SERIAL PRIMARY KEY,
  config_type TEXT NOT NULL,               -- 'lending_supply', 'lending_borrow', 'backstop'
  pool_address TEXT NOT NULL,
  asset_address TEXT,                       -- NULL for backstop
  eps NUMERIC NOT NULL,                     -- emissions per second (raw bigint value)
  eps_decimals INT NOT NULL,                -- 14 for V2 (both lending and backstop)
  expiration BIGINT,                        -- unix timestamp when emissions expire
  effective_from DATE DEFAULT '2025-04-14', -- v2 launch date
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (config_type, pool_address, COALESCE(asset_address, ''))
);

-- Indexes
CREATE INDEX idx_emission_configs_pool ON emission_configs(pool_address);
CREATE INDEX idx_emission_configs_type ON emission_configs(config_type);
```

### Table 2: Daily Emission APY (Backfilled + Daily Cron)

```sql
-- Store pre-calculated daily emission APY for historical queries
CREATE TABLE daily_emission_apy (
  id SERIAL PRIMARY KEY,
  rate_date DATE NOT NULL,
  apy_type TEXT NOT NULL,                   -- 'lending_supply', 'lending_borrow', 'backstop'
  pool_address TEXT NOT NULL,
  asset_address TEXT,                       -- NULL for backstop

  -- Input values (for debugging/audit)
  eps NUMERIC NOT NULL,                     -- from emission_configs
  eps_decimals INT NOT NULL,
  total_supply NUMERIC NOT NULL,            -- b_supply, d_supply, or backstop tokens
  blnd_price_usd NUMERIC,
  asset_price_usd NUMERIC,                  -- asset price or LP token price for backstop

  -- Calculated values
  emissions_per_year_per_token NUMERIC,     -- (eps * 31536000) / total_supply
  emission_apy NUMERIC,                     -- emissions_per_year_per_token * blnd_price / asset_price * 100

  created_at TIMESTAMP DEFAULT NOW(),

  CONSTRAINT daily_emission_apy_unique
    UNIQUE (rate_date, apy_type, pool_address, COALESCE(asset_address, ''))
);

-- Indexes for efficient queries
CREATE INDEX idx_daily_emission_apy_date ON daily_emission_apy(rate_date);
CREATE INDEX idx_daily_emission_apy_pool ON daily_emission_apy(pool_address);
CREATE INDEX idx_daily_emission_apy_type_pool ON daily_emission_apy(apy_type, pool_address);
```

---

## Implementation Steps

### Phase 1: Fetch and Store EPS Configs

**Script**: `src/scripts/fetch-emission-configs.ts` (already created)

Run the script to fetch current EPS values:
```bash
npx ts-node src/scripts/fetch-emission-configs.ts
```

The script outputs:
- Lending pool EPS per asset (supply + borrow)
- Backstop EPS per pool
- Annual BLND emissions summary

**After running, manually insert into `emission_configs` table or extend script to do so.**

### Phase 2: Backfill Historical APY

#### For Backstop Emission APY:

```sql
-- Calculate historical backstop emission APY
INSERT INTO daily_emission_apy (
  rate_date, apy_type, pool_address, asset_address,
  eps, eps_decimals, total_supply, blnd_price_usd, asset_price_usd,
  emissions_per_year_per_token, emission_apy
)
WITH backstop_daily AS (
  -- Get daily backstop token totals per pool from events
  SELECT
    DATE(ledger_closed_at) as rate_date,
    pool_address,
    SUM(CASE
      WHEN action_type = 'deposit' THEN COALESCE(shares, 0)
      WHEN action_type = 'withdraw' THEN -COALESCE(shares, 0)
      ELSE 0
    END) OVER (PARTITION BY pool_address ORDER BY DATE(ledger_closed_at)) as total_shares,
    SUM(CASE
      WHEN action_type = 'deposit' THEN COALESCE(lp_tokens, 0)
      WHEN action_type = 'withdraw' THEN -COALESCE(lp_tokens, 0)
      WHEN action_type IN ('donate', 'gulp_emissions') THEN COALESCE(lp_tokens, 0)
      WHEN action_type = 'draw' THEN -COALESCE(lp_tokens, 0)
      ELSE 0
    END) OVER (PARTITION BY pool_address ORDER BY DATE(ledger_closed_at)) as total_tokens,
    SUM(CASE
      WHEN action_type = 'queue_withdrawal' THEN COALESCE(shares, 0)
      WHEN action_type = 'dequeue_withdrawal' THEN -COALESCE(shares, 0)
      WHEN action_type = 'withdraw' THEN -COALESCE(shares, 0)
      ELSE 0
    END) OVER (PARTITION BY pool_address ORDER BY DATE(ledger_closed_at)) as total_q4w
  FROM backstop_events
  WHERE pool_address IS NOT NULL
),
backstop_eod AS (
  -- Get end-of-day values
  SELECT DISTINCT ON (rate_date, pool_address)
    rate_date, pool_address, total_shares, total_tokens, total_q4w
  FROM backstop_daily
  ORDER BY rate_date, pool_address, total_shares DESC
),
with_config AS (
  SELECT
    b.rate_date,
    b.pool_address,
    b.total_shares,
    b.total_tokens,
    b.total_q4w,
    -- Convert shares to tokens for non-Q4W portion
    CASE WHEN b.total_shares > 0
      THEN ((b.total_shares - b.total_q4w) * b.total_tokens / b.total_shares)
      ELSE 0
    END as active_tokens,
    c.eps,
    c.eps_decimals
  FROM backstop_eod b
  JOIN emission_configs c
    ON c.pool_address = b.pool_address
    AND c.config_type = 'backstop'
)
SELECT
  w.rate_date,
  'backstop' as apy_type,
  w.pool_address,
  NULL as asset_address,
  w.eps,
  w.eps_decimals,
  w.active_tokens as total_supply,
  blnd.usd_price as blnd_price_usd,
  lp.usd_price as asset_price_usd,
  -- emissions_per_year_per_token = (eps / 10^decimals) * 31536000 / (supply / 10^7)
  CASE WHEN w.active_tokens > 0 THEN
    (w.eps::numeric / POWER(10, w.eps_decimals)) * 31536000 / (w.active_tokens::numeric / 1e7)
  ELSE 0 END as emissions_per_year_per_token,
  -- emission_apy = emissions_per_year_per_token * blnd_price * 100
  -- (already in BLND terms, just multiply by price for USD value as % of LP token value)
  CASE WHEN w.active_tokens > 0 AND lp.usd_price > 0 THEN
    ((w.eps::numeric / POWER(10, w.eps_decimals)) * 31536000 / (w.active_tokens::numeric / 1e7))
    * blnd.usd_price * 100
  ELSE 0 END as emission_apy
FROM with_config w
LEFT JOIN daily_token_prices blnd
  ON blnd.price_date = w.rate_date
  AND blnd.token_address = 'CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY'
LEFT JOIN daily_token_prices lp
  ON lp.price_date = w.rate_date
  AND lp.token_address = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM';
```

#### For Lending Pool Emission APY:

```sql
-- Calculate historical lending emission APY
INSERT INTO daily_emission_apy (
  rate_date, apy_type, pool_address, asset_address,
  eps, eps_decimals, total_supply, blnd_price_usd, asset_price_usd,
  emissions_per_year_per_token, emission_apy
)
SELECT
  ps.snapshot_date as rate_date,
  'lending_supply' as apy_type,
  ps.pool_id as pool_address,
  ps.asset_address,
  c.eps,
  c.eps_decimals,
  ps.b_supply as total_supply,
  blnd.usd_price as blnd_price_usd,
  asset.usd_price as asset_price_usd,
  -- emissions_per_year_per_token
  CASE WHEN ps.b_supply > 0 THEN
    (c.eps::numeric / POWER(10, c.eps_decimals)) * 31536000 / ps.b_supply::numeric
  ELSE 0 END as emissions_per_year_per_token,
  -- emission_apy = emissions_per_year_per_token * blnd_price / asset_price * 100
  CASE WHEN ps.b_supply > 0 AND asset.usd_price > 0 THEN
    ((c.eps::numeric / POWER(10, c.eps_decimals)) * 31536000 / ps.b_supply::numeric)
    * blnd.usd_price / asset.usd_price * 100
  ELSE 0 END as emission_apy
FROM pool_snapshots ps
JOIN emission_configs c
  ON c.pool_address = ps.pool_id
  AND c.asset_address = ps.asset_address
  AND c.config_type = 'lending_supply'
LEFT JOIN daily_token_prices blnd
  ON blnd.price_date = ps.snapshot_date
  AND blnd.token_address = 'CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY'
LEFT JOIN daily_token_prices asset
  ON asset.price_date = ps.snapshot_date
  AND asset.token_address = ps.asset_address
WHERE ps.b_supply > 0;

-- Similar query for 'lending_borrow' using d_supply
```

### Phase 3: Daily Cron Job

Add to existing daily price capture or create new cron:

```typescript
// Run daily after price capture completes
async function calculateDailyEmissionAPY(date: Date) {
  // 1. Get EPS configs from emission_configs table
  // 2. Get supplies from pool_snapshots
  // 3. Get backstop state from backstop_events
  // 4. Get prices from daily_token_prices
  // 5. Calculate and insert into daily_emission_apy
}
```

### Phase 4: Frontend Integration

Frontend receives:
- **Historical APY**: Query `daily_emission_apy` table
- **Live APY**: Frontend calculates using:
  - `eps` from `emission_configs` (static, can be cached)
  - Current supply from real-time API
  - Current prices from price API

---

## Tracked Pools

| Pool Name | Pool ID | Version |
|-----------|---------|---------|
| YieldBlox | `CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS` | V2 |
| Blend Pool | `CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD` | V2 |
| Orbit | `CAE7QVOMBLZ53CDRGK3UNRRHG5EZ5NQA7HHTFASEMYBWHG6MDFZTYHXC` | V2 |
| Forex | `CBYOBT7ZCCLQCBUYYIABZLSEGDPEUWXCUXQTZYOG3YBDR7U357D5ZIRF` | V2 |
| Etherfuse | `CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI` | V2 |

---

## Data Sources Summary

| Data | Table | Status |
|------|-------|--------|
| EPS (emissions per second) | `emission_configs` | ⏳ Run script to populate |
| Pool b_supply / d_supply | `pool_snapshots` | ✅ Have |
| Backstop shares/tokens/q4w | `backstop_events` | ✅ Have |
| BLND price | `daily_token_prices` | ✅ Have |
| LP token price | `daily_token_prices` | ✅ Have |
| Asset prices | `daily_token_prices` | ✅ Have |

---

## Next Steps

1. [ ] Run `npx ts-node src/scripts/fetch-emission-configs.ts` to get current EPS values
2. [ ] Create database migration for `emission_configs` and `daily_emission_apy` tables
3. [ ] Insert EPS values into `emission_configs`
4. [ ] Run backfill queries to populate `daily_emission_apy`
5. [ ] Add daily cron job for ongoing APY calculation
6. [ ] Create API endpoints for frontend to query historical APY
7. [ ] Implement frontend live APY calculation
