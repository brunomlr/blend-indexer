# Historical Prices Tracking - Next Steps

## Completed

- [x] Database migration: Added `pegged_currency` column to `tokens` table
- [x] Database migration: Created `daily_token_prices` table
- [x] Seeded token metadata (coingecko_id, pegged_currency)
- [x] Created CoinGecko backfill script
- [x] Created LP token backfill script
- [x] Created daily price capture cron job and API endpoints

## Files Created

| File | Purpose |
|------|---------|
| `src/scripts/backfill-coingecko-prices.ts` | Backfill historical prices from CoinGecko |
| `src/scripts/backfill-lp-prices.ts` | Import LP prices from BigQuery export |
| `src/scripts/capture-daily-prices.ts` | Manual/cron script for daily capture |
| `src/services/daily-price-capture.ts` | Service class for price capture logic |
| `src/api/routes/cron-prices.ts` | API endpoints for cron triggers |

---

## Next Steps

### Step 1: Run CoinGecko Backfill

```bash
npx ts-node src/scripts/backfill-coingecko-prices.ts
```

This will:
- Fetch historical prices for XLM (`stellar`), BLND (`blend-2`), AQUA (`aquarius`)
- Populate stablecoin prices (USDC, EURC, etc.) with pegged values ($1.00)
- Date range: 2025-04-15 to today

**Expected output:** ~250 days × 3 tokens = ~750 price points for CoinGecko tokens, plus stablecoin entries.

---

### Step 2: Run LP Token Backfill (BigQuery)

**2a. Run this BigQuery query:**

```sql
WITH total_shares AS (
  SELECT
    DATE(closed_at) as price_date,
    CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.i128') AS NUMERIC) as total_lp_tokens
  FROM `crypto-stellar.crypto_stellar.contract_data`
  WHERE contract_id = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM'
    AND key_decoded LIKE '%TotalShares%'
    AND closed_at >= '2025-04-15'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY DATE(closed_at) ORDER BY closed_at DESC) = 1
),
record_data AS (
  SELECT
    DATE(closed_at) as price_date,
    CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.map[0].val.map[0].val.i128') AS NUMERIC) as usdc_balance
  FROM `crypto-stellar.crypto_stellar.contract_data`
  WHERE contract_id = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM'
    AND key_decoded LIKE '%AllRecordData%'
    AND closed_at >= '2025-04-15'
  QUALIFY ROW_NUMBER() OVER (PARTITION BY DATE(closed_at) ORDER BY closed_at DESC) = 1
)
SELECT
  t.price_date,
  (5.0 * r.usdc_balance / t.total_lp_tokens) / 1e7 as lp_token_price
FROM total_shares t
JOIN record_data r ON t.price_date = r.price_date
ORDER BY t.price_date
```

**2b. Export results to JSON file** (e.g., `lp-prices.json`)

Expected format:
```json
[
  {"price_date": "2025-04-15", "lp_token_price": 0.302},
  {"price_date": "2025-04-16", "lp_token_price": 0.305},
  ...
]
```

**2c. Run import script:**

```bash
npx ts-node src/scripts/backfill-lp-prices.ts ./lp-prices.json
```

---

### Step 3: Validate Data

Run these queries to verify the backfill:

```sql
-- Check price coverage per token
SELECT
  t.symbol,
  t.coingecko_id,
  t.pegged_currency,
  MIN(dtp.price_date) as earliest,
  MAX(dtp.price_date) as latest,
  COUNT(dtp.id) as days
FROM tokens t
LEFT JOIN daily_token_prices dtp ON t.asset_address = dtp.token_address
GROUP BY t.symbol, t.coingecko_id, t.pegged_currency
ORDER BY t.symbol;

-- Sample recent prices
SELECT
  t.symbol,
  dtp.price_date,
  dtp.usd_price,
  dtp.source
FROM daily_token_prices dtp
JOIN tokens t ON t.asset_address = dtp.token_address
WHERE dtp.price_date >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY dtp.price_date DESC, t.symbol;
```

---

### Step 4: Test Daily Capture

```bash
npx ts-node src/scripts/capture-daily-prices.ts
```

This will capture today's prices from the SDK oracle and backstop.

---

### Step 5: Set Up Daily Cron

**Option A: API Trigger (recommended for serverless)**

Add `CRON_SECRET` to your `.env`:
```
CRON_SECRET=your-secret-here
```

Then schedule a daily call to:
```
POST /api/cron/capture-prices
Authorization: Bearer your-secret-here
```

**Option B: Direct Script (for VPS/server)**

Add to crontab:
```bash
# Run daily at midnight UTC
0 0 * * * cd /path/to/backfill_backend && npx ts-node src/scripts/capture-daily-prices.ts >> /var/log/price-capture.log 2>&1
```

**Option C: GitHub Actions**

Create `.github/workflows/daily-prices.yml`:
```yaml
name: Daily Price Capture
on:
  schedule:
    - cron: '0 0 * * *'  # Daily at midnight UTC
  workflow_dispatch:  # Manual trigger

jobs:
  capture:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
        working-directory: backfill_backend
      - run: npx ts-node src/scripts/capture-daily-prices.ts
        working-directory: backfill_backend
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

---

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/cron/capture-prices` | POST | Trigger price capture (requires `CRON_SECRET`) |
| `/api/cron/prices/status` | GET | Check latest prices and coverage |

---

## Checklist

- [ ] Run CoinGecko backfill script
- [ ] Run BigQuery for LP token prices
- [ ] Import LP prices from JSON
- [ ] Validate data with queries
- [ ] Test daily capture script
- [ ] Set up daily cron job
- [ ] Monitor for 2-3 days to ensure cron runs correctly
