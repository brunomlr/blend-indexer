# Historical LP Token Price Indexer

## Problem Statement

We need to calculate the USD value of backstop LP token positions at historical points in time. Currently, we can only get the LP token price at the current moment via the Blend SDK's `BackstopToken.lpTokenPrice`.

### Why This Matters

- **Yield tracking**: To calculate actual USD returns, not just LP token quantity changes
- **Tax reporting**: Need USD values at specific transaction dates
- **Portfolio history**: Show historical portfolio value in USD over time

### Current Data Limitations

The `backstop_events` table only captures:
- `lp_tokens` - quantity of LP tokens deposited/withdrawn
- `shares` - backstop shares issued/burned
- `ledger_closed_at` - timestamp

It does **NOT** capture:
- LP token price in USD
- BLND/USDC composition of the Comet pool
- BLND price

---

## Solution: Index Comet Pool State from Hubble

### Architecture

The BLND/USDC LP token is issued by the **Comet pool** (a weighted AMM). The pool maintains 80% value in BLND and 20% value in USDC.

```
LP Token Price = Total Pool Value / Total LP Tokens
              = (USDC Balance / 0.20) / Total LP Tokens
              = (5 × USDC Balance) / Total LP Tokens
```

Key insight: We only need the **USDC balance** and **Total LP tokens** to calculate the LP price. We don't need the BLND price directly because the 80/20 value weighting is maintained by arbitrage.

### Data Source: Stellar Hubble (BigQuery)

Hubble's `contract_data` table stores historical contract state snapshots.

**Comet Pool Contract**: `CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM`

**Key data points available**:

| Key | Description | Example Value |
|-----|-------------|---------------|
| `TotalShares` | Total LP tokens in circulation | `124276070959251` (stroops) |
| `AllRecordData` | Token balances and weights | See below |

**AllRecordData structure**:
```json
{
  "map": [
    {
      "key": {"address": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"},
      "val": {
        "map": [
          {"key": {"symbol": "balance"}, "val": {"i128": "7500869045656"}},
          {"key": {"symbol": "weight"}, "val": {"i128": "2000000"}}
        ]
      }
    },
    {
      "key": {"address": "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY"},
      "val": {
        "map": [
          {"key": {"symbol": "balance"}, "val": {"i128": "607003362374840"}},
          {"key": {"symbol": "weight"}, "val": {"i128": "8000000"}}
        ]
      }
    }
  ]
}
```

**Token Addresses**:
- USDC: `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` (weight: 20%)
- BLND: `CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY` (weight: 80%)

---

## Implementation Plan

### Step 1: Create Database Table for LP Price History

```sql
CREATE TABLE comet_pool_snapshots (
  id SERIAL PRIMARY KEY,
  ledger_sequence BIGINT NOT NULL,
  closed_at TIMESTAMP NOT NULL,
  usdc_balance NUMERIC(38, 0) NOT NULL,  -- in stroops (7 decimals)
  blnd_balance NUMERIC(38, 0) NOT NULL,  -- in stroops (7 decimals)
  total_lp_tokens NUMERIC(38, 0) NOT NULL,  -- in stroops (7 decimals)
  lp_token_price NUMERIC(20, 10) NOT NULL,  -- calculated USD price
  UNIQUE(ledger_sequence)
);

CREATE INDEX idx_comet_snapshots_date ON comet_pool_snapshots(closed_at);
```

### Step 2: Backfill Historical Data from Hubble

**Final Query - Daily Closing LP Prices (TESTED & WORKING)**:

```sql
WITH total_shares AS (
  SELECT
    ledger_sequence,
    closed_at,
    DATE(closed_at) as price_date,
    CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.i128') AS NUMERIC) as total_lp_tokens
  FROM `crypto-stellar.crypto_stellar.contract_data`
  WHERE contract_id = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM'
    AND JSON_EXTRACT_SCALAR(key_decoded, '$.vec[0].symbol') = 'TotalShares'
    AND closed_at >= '2025-04-15'
),
record_data AS (
  SELECT
    ledger_sequence,
    CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.map[0].val.map[0].val.i128') AS NUMERIC) as usdc_balance
  FROM `crypto-stellar.crypto_stellar.contract_data`
  WHERE contract_id = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM'
    AND JSON_EXTRACT_SCALAR(key_decoded, '$.vec[0].symbol') = 'AllRecordData'
    AND closed_at >= '2025-04-15'
),
combined AS (
  SELECT
    t.price_date,
    t.ledger_sequence,
    (5.0 * r.usdc_balance / t.total_lp_tokens) as lp_token_price,
    ROW_NUMBER() OVER (PARTITION BY t.price_date ORDER BY t.ledger_sequence DESC) as rn
  FROM total_shares t
  JOIN record_data r ON t.ledger_sequence = r.ledger_sequence
)
SELECT
  price_date,
  lp_token_price,
  ledger_sequence
FROM combined
WHERE rn = 1
ORDER BY price_date
```

**Key notes**:
- Uses `JSON_EXTRACT_SCALAR(key_decoded, '$.vec[0].symbol')` to filter (not `LIKE`)
- Gets last ledger of each day (closing price) via `ROW_NUMBER()` window function
- Formula: `LP_price = (5 * usdc_balance) / total_lp_tokens` (no division by 1e7 - stroops cancel out)
- Verified: Dec 16, 2025 = $0.306, Dec 17, 2025 = $0.335

### Step 3: Parse and Insert Data

**Backfill script created**: `npm run backfill:lp-prices`

Usage:
```bash
# 1. Get the BigQuery query
npm run backfill:lp-prices -- --query

# 2. Run query in BigQuery Console, export as JSON

# 3. Dry run to preview import
npm run backfill:lp-prices -- ./data/lp-prices.json --dry-run

# 4. Run actual import
npm run backfill:lp-prices -- ./data/lp-prices.json
```

The script:
1. Parses the exported JSON file
2. Validates price data
3. Skips existing dates (idempotent)
4. Inserts into `daily_token_prices` table with source='hubble'

### Step 4: Create Daily Materialized View

For efficient lookups, create a daily snapshot:

```sql
CREATE MATERIALIZED VIEW daily_lp_prices AS
SELECT DISTINCT ON (DATE(closed_at))
  DATE(closed_at) as price_date,
  lp_token_price,
  usdc_balance / 1e7 as usdc_amount,
  blnd_balance / 1e7 as blnd_amount,
  total_lp_tokens / 1e7 as total_lp
FROM comet_pool_snapshots
ORDER BY DATE(closed_at), closed_at DESC;

CREATE UNIQUE INDEX idx_daily_lp_prices_date ON daily_lp_prices(price_date);
```

### Step 5: Query Historical USD Values

To get LP position value at a historical date:

```sql
SELECT
  be.ledger_closed_at,
  be.lp_tokens / 1e7 as lp_tokens,
  dlp.lp_token_price,
  (be.lp_tokens / 1e7) * dlp.lp_token_price as usd_value
FROM backstop_events be
JOIN daily_lp_prices dlp ON DATE(be.ledger_closed_at) = dlp.price_date
WHERE be.user_address = 'GXXXX...'
  AND be.action_type IN ('deposit', 'withdraw')
ORDER BY be.ledger_closed_at;
```

### Step 6: Ongoing Indexing

Add to your indexer to capture new snapshots:
- Subscribe to Comet pool contract changes
- Or periodically query Hubble for new data
- Or capture from SDK's `BackstopToken` on each indexer run

---

## Calculation Reference

### LP Token Price Formula

```
USDC_value = usdc_balance / 1e7          # Convert stroops to USDC
Total_pool_value = USDC_value / 0.20     # 80/20 weighting
Total_LP = total_lp_tokens / 1e7         # Convert stroops to LP tokens
LP_price = Total_pool_value / Total_LP   # USD per LP token
```

**Simplified (CORRECT formula - stroops cancel out)**:
```
LP_price = (5 * usdc_balance) / total_lp_tokens
```

Note: No division by 1e7 needed because both usdc_balance and total_lp_tokens are in stroops, so the units cancel out.

### Example Calculation

From Dec 16, 2025 data:
```
usdc_balance = 7,638,616,734,515 stroops
total_lp_tokens = 124,810,108,038,033 stroops

LP_price = (5 * 7,638,616,734,515) / 124,810,108,038,033
         = 38,193,083,672,575 / 124,810,108,038,033
         = $0.306 per LP token ✓
```

---

## Data Availability

- **Hubble data range**: Verify earliest available data (likely from contract deployment)
- **Backstop events range**: 2025-04-15 to present
- **Recommendation**: Backfill from 2025-04-15 (start of backstop_events) onwards

---

## Alternative: BLND Price Derivation

As a bonus, you can derive the BLND price from the same data:

```
BLND_value = Total_pool_value * 0.80
BLND_amount = blnd_balance / 1e7
BLND_price = BLND_value / BLND_amount
```

This gives you historical BLND prices without needing an external price feed.

---

## Current Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         DATA SOURCES                                 │
├─────────────────┬─────────────────────┬─────────────────────────────┤
│    Goldsky      │       Hubble        │      Blend SDK              │
│  (events only)  │  (contract_data)    │   (current state)           │
├─────────────────┼─────────────────────┼─────────────────────────────┤
│ • Backstop      │ • Historical Comet  │ • Current LP price          │
│   events        │   pool state        │ • Current balances          │
│ • Raw ledger    │ • TotalShares       │                             │
│ • NO contract   │ • AllRecordData     │                             │
│   state data    │   (USDC/BLND)       │                             │
└────────┬────────┴──────────┬──────────┴──────────────┬──────────────┘
         │                   │                         │
         ▼                   ▼                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         YOUR DATABASE                                │
├─────────────────────────────┬───────────────────────────────────────┤
│     backstop_events         │      comet_pool_snapshots             │
│  (from Goldsky)             │  (from Hubble + SDK cron)             │
└─────────────────────────────┴───────────────────────────────────────┘
```

**Key limitation:** Goldsky does not have `contract_data`, so it cannot provide Comet pool state (USDC/BLND balances, total LP tokens).

---

## Ongoing Daily Price Capture

Since Goldsky only provides events (not contract state), you need a **separate daily cron job** to capture LP prices using the Blend SDK.

### Daily Cron Job (Recommended)

Run a scheduled job (daily at midnight UTC) that captures the current Comet pool state:

```typescript
// daily-lp-snapshot.ts
import { Backstop } from '@blend-capital/blend-sdk';
import { Network } from '@blend-capital/blend-sdk';

const BACKSTOP_ID = 'CAO3AGAMZVRMHITL36EJ2VZQWKYRPWMQAPDQD5YEOF3GIF7T44U4JAL3';

async function captureDailyLpPrice() {
  const network: Network = {
    rpc: process.env.RPC_URL,
    passphrase: 'Public Global Stellar Network ; September 2015',
    opts: { allowHttp: false }
  };

  const backstop = await Backstop.load(network, BACKSTOP_ID);
  const bt = backstop.backstopToken;

  // Calculate LP price: (5 * USDC) / TotalLP
  const usdcBalance = bt.usdc;           // bigint stroops
  const blndBalance = bt.blnd;           // bigint stroops
  const totalLpTokens = bt.shares;       // bigint stroops
  const lpTokenPrice = bt.lpTokenPrice;  // already calculated by SDK

  await db.query(`
    INSERT INTO comet_pool_snapshots
      (ledger_sequence, closed_at, usdc_balance, blnd_balance, total_lp_tokens, lp_token_price)
    VALUES ($1, NOW(), $2, $3, $4, $5)
    ON CONFLICT (ledger_sequence) DO NOTHING
  `, [
    backstop.latestLedger,
    usdcBalance.toString(),
    blndBalance.toString(),
    totalLpTokens.toString(),
    lpTokenPrice
  ]);

  console.log(`Captured LP price: $${lpTokenPrice} at ledger ${backstop.latestLedger}`);
}

captureDailyLpPrice();
```

### Cron Schedule Options

| Frequency | Cron Expression | Use Case |
|-----------|-----------------|----------|
| Daily (midnight UTC) | `0 0 * * *` | Minimum for daily price lookups |
| Every 6 hours | `0 */6 * * *` | Better granularity |
| Hourly | `0 * * * *` | High precision (more data) |

### Where to Run the Cron

| Platform | How to Set Up |
|----------|---------------|
| **Vercel** | Add to `vercel.json` as a cron function |
| **GitHub Actions** | Scheduled workflow with `schedule` trigger |
| **Railway / Render** | Background worker with cron |
| **AWS Lambda** | EventBridge scheduled rule |

**Example: Vercel Cron**

```json
// vercel.json
{
  "crons": [
    {
      "path": "/api/cron/capture-lp-price",
      "schedule": "0 0 * * *"
    }
  ]
}
```

```typescript
// app/api/cron/capture-lp-price/route.ts
export async function GET() {
  await captureDailyLpPrice();
  return Response.json({ success: true });
}
```

---

## Summary: Complete Data Pipeline

| Data Type | Source | Method | Frequency |
|-----------|--------|--------|-----------|
| Backstop events | Goldsky | Continuous stream | Real-time |
| Historical LP prices | Hubble | One-time backfill query | Once |
| Ongoing LP prices | Blend SDK | Daily cron job | Daily |
