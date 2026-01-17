# BLND Emission APY - Frontend Consumption Guide

This document describes how frontend applications can consume BLND emission APY data from the backend.

## Database Schema

### Table: `daily_emission_apy`

| Column | Type | Description |
|--------|------|-------------|
| `id` | integer | Primary key |
| `rate_date` | date | The date for this APY snapshot |
| `apy_type` | text | Type of emission: `backstop`, `lending_supply`, or `lending_borrow` |
| `pool_address` | varchar | Blend pool contract address |
| `asset_address` | varchar | Asset contract address (NULL for backstop) |
| `eps` | numeric | Emissions per second (raw value) |
| `eps_decimals` | bigint | Decimal places for EPS (14 for V2 pools) |
| `total_supply` | numeric | Total supply used in calculation |
| `blnd_price_usd` | numeric | BLND token price on this date |
| `asset_price_usd` | numeric | Asset/LP token price on this date |
| `emissions_per_year_per_token` | numeric | BLND tokens emitted per year per deposited token |
| `emission_apy` | numeric | **Final APY percentage** (what to display) |
| `source` | varchar | Data source: `sdk` (live), `bigquery` (historical lending), `backstop_events` (historical backstop) |
| `created_at` | timestamp | Record creation timestamp |

### APY Types

1. **`backstop`**: Emission APY for backstop depositors (LP token stakers)
   - `asset_address` is NULL
   - `asset_price_usd` is the LP token price
   - `total_supply` is total LP tokens deposited in the backstop

2. **`lending_supply`**: Emission APY for lenders (suppliers)
   - `asset_address` is the supplied asset (e.g., USDC, XLM)
   - `total_supply` is the pool's bSupply for this asset

3. **`lending_borrow`**: Emission APY for borrowers
   - `asset_address` is the borrowed asset
   - `total_supply` is the pool's dSupply for this asset

## APY Calculation Formula

The stored `emission_apy` is calculated as:

```
emission_apy = (eps / 10^eps_decimals) * 31536000 / total_supply * blnd_price_usd / asset_price_usd * 100
```

Where:
- `31536000` = seconds per year
- Result is a percentage (e.g., `5.02` means 5.02% APY)

## Common Query Patterns

### 1. Get Latest APY for All Assets in a Pool

```sql
SELECT DISTINCT ON (apy_type, asset_address)
  rate_date,
  apy_type,
  pool_address,
  asset_address,
  emission_apy,
  total_supply,
  blnd_price_usd,
  asset_price_usd
FROM daily_emission_apy
WHERE pool_address = $1
ORDER BY apy_type, asset_address, rate_date DESC;
```

### 2. Get Backstop APY for All Pools (Latest)

```sql
SELECT DISTINCT ON (pool_address)
  rate_date,
  pool_address,
  emission_apy,
  total_supply as lp_tokens_staked
FROM daily_emission_apy
WHERE apy_type = 'backstop'
ORDER BY pool_address, rate_date DESC;
```

### 3. Get Lending Supply APY for a Specific Asset

```sql
SELECT
  rate_date,
  pool_address,
  emission_apy,
  total_supply as b_supply
FROM daily_emission_apy
WHERE apy_type = 'lending_supply'
  AND asset_address = $1
ORDER BY rate_date DESC
LIMIT 30;  -- Last 30 days
```

### 4. Get Historical APY for Charting

```sql
SELECT
  rate_date,
  apy_type,
  asset_address,
  emission_apy
FROM daily_emission_apy
WHERE pool_address = $1
  AND rate_date >= $2  -- start_date
  AND rate_date <= $3  -- end_date
ORDER BY rate_date, apy_type, asset_address;
```

### 5. Get All APYs for Today with Token Info

```sql
SELECT
  e.rate_date,
  e.apy_type,
  e.pool_address,
  e.asset_address,
  t.symbol,
  t.name,
  e.emission_apy,
  e.blnd_price_usd,
  e.asset_price_usd
FROM daily_emission_apy e
LEFT JOIN tokens t ON t.address = e.asset_address
WHERE e.rate_date = CURRENT_DATE
ORDER BY e.pool_address, e.apy_type, t.symbol;
```

## Suggested API Endpoints

### GET `/api/emission-apy`
Get latest emission APY for all pools and assets.

**Response:**
```json
{
  "success": true,
  "date": "2026-01-04",
  "data": [
    {
      "pool_address": "CCCCIQSD...",
      "pool_name": "YieldBlox",
      "backstop_apy": 42.5,
      "lending": [
        {
          "asset_address": "CCW67TSZ...",
          "symbol": "USDC",
          "supply_apy": 0.87,
          "borrow_apy": 1.23
        }
      ]
    }
  ]
}
```

### GET `/api/emission-apy/:pool_address`
Get emission APY for a specific pool.

**Query params:**
- `days` (optional): Number of historical days (default: 1)

### GET `/api/emission-apy/asset/:asset_address`
Get emission APY for a specific asset across all pools.

### GET `/api/emission-apy/history`
Get historical emission APY data for charting.

**Query params:**
- `pool_address` (optional)
- `asset_address` (optional)
- `apy_type` (optional): `backstop`, `lending_supply`, `lending_borrow`
- `start_date` (required)
- `end_date` (required)

## Frontend Display Guidelines

### Backstop APY Display
- Show as "BLND Emission APY" or "Backstop Rewards"
- This is the APY earned by staking LP tokens in the backstop
- Denominated in terms of LP token value

### Lending APY Display
- Show separately as "BLND Supply APY" and "BLND Borrow APY"
- This is in addition to the base interest rate APY
- Total APY = Base APY + BLND Emission APY

### Formatting
- Display with 2 decimal places for values > 1%
- Display with 3-4 decimal places for small values < 1%
- Include "%" symbol

### Example Display

```
YieldBlox Pool - USDC
├── Supply APY
│   ├── Base Rate:     4.25%
│   └── BLND Rewards: +0.87%
│   └── Total:         5.12%
│
└── Borrow APY
    ├── Base Rate:     6.50%
    └── BLND Rewards: -1.23%  (reduces effective cost)
    └── Net Cost:      5.27%
```

## Data Freshness

- Historical data is backfilled from V2 launch (2025-04-14)
- **Daily capture via GitHub Action** (`.github/workflows/daily-prices.yml`):
  - Runs at **midnight UTC** every day
  - Step 1: Captures token prices via `capture-daily-prices.ts`
  - Step 2: Calculates emission APY via `backfill-emission-apy.ts --today`
  - Uses Blend SDK for live pool data (bSupply, dSupply, EPS)
- For real-time APY during the day, use the Blend SDK directly

### GitHub Action Details

The workflow can also be triggered manually via `workflow_dispatch`.

**Required secrets:**
- `DATABASE_URL`: PostgreSQL connection string
- `STELLAR_RPC_URL`: Soroban RPC endpoint

**Scripts executed:**
1. `src/scripts/capture-daily-prices.ts` - Fetches current prices for all tracked tokens
2. `src/scripts/backfill-emission-apy.ts --today` - Calculates APY using live SDK data

## Related Tables

- `emission_configs`: Current EPS configuration per pool/asset
- `pool_snapshots`: Historical b_supply/d_supply from BigQuery
- `daily_token_prices`: Historical token prices
- `backstop_events`: Backstop deposit/withdraw events
- `pools`: Pool metadata (name, address)
- `tokens`: Token metadata (symbol, name, decimals)
