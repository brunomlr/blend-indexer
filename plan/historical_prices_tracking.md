# Historical Token Pricing - Backend Implementation Plan

## Goal

Backend infrastructure to store and retrieve historical token prices for all tokens tracked in the BLEND protocol.

**Scope:** Backend only (database, backfill scripts, daily cron). Frontend changes are out of scope.

---

## Requirements

1. **CoinGecko Historical Backfill** - Fetch historical prices for tokens that have CoinGecko listings
2. **Daily Price Snapshots** - Capture all token prices daily (including LP token from SDK)
3. **Stablecoin Handling** - Skip price fetching for tokens pegged 1:1 to a currency (e.g., USDC)
4. **Dynamic Token Discovery** - Read token list from database, not hardcoded

---

## Database Schema Changes

### 1. Extend `tokens` Table

Add columns for CoinGecko mapping and stablecoin identification:

```sql
ALTER TABLE tokens ADD COLUMN coingecko_id VARCHAR(50);
ALTER TABLE tokens ADD COLUMN pegged_currency VARCHAR(10);  -- 'USD', 'EUR', etc. NULL if not pegged

-- Update known tokens
UPDATE tokens SET coingecko_id = 'stellar' WHERE symbol = 'XLM';
UPDATE tokens SET coingecko_id = 'blend-2' WHERE symbol = 'BLND';
UPDATE tokens SET coingecko_id = 'aquarius' WHERE symbol = 'AQUA';
UPDATE tokens SET pegged_currency = 'USD' WHERE symbol = 'USDC';
-- LP token has no coingecko_id (fetched from SDK)
```

**Token Mapping Reference:**

| Symbol | asset_address | coingecko_id | pegged_currency |
|--------|--------------|--------------|-----------------|
| XLM | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2EZ4YXL` | `stellar` | NULL |
| BLND | `CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY` | `blend-2` | NULL |
| AQUA | `CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK` | `aquarius` | NULL |
| USDC | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` | NULL | `USD` |
| LP Token | `CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM` | NULL | NULL |

### 2. Create Unified `daily_token_prices` Table

Single table for ALL token prices (including LP token):

```sql
CREATE TABLE daily_token_prices (
  id SERIAL PRIMARY KEY,
  token_address VARCHAR(56) NOT NULL,
  price_date DATE NOT NULL,
  usd_price NUMERIC(20, 10) NOT NULL,
  source VARCHAR(20) NOT NULL,  -- 'coingecko', 'sdk_oracle', 'sdk_lp', 'pegged'
  created_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(token_address, price_date)
);

CREATE INDEX idx_daily_token_prices_lookup ON daily_token_prices(token_address, price_date);
CREATE INDEX idx_daily_token_prices_date ON daily_token_prices(price_date);
```

**Note:** This replaces the separate `comet_pool_snapshots` approach from the LP price plan. LP token prices now go into the same table for simpler queries.

---

## Implementation Steps

### Step 1: Database Migration

Create migration to add columns and new table:

```sql
-- migrations/add_token_prices.sql

-- 1. Extend tokens table
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS coingecko_id VARCHAR(50);
ALTER TABLE tokens ADD COLUMN IF NOT EXISTS pegged_currency VARCHAR(10);

-- 2. Create daily_token_prices table
CREATE TABLE IF NOT EXISTS daily_token_prices (
  id SERIAL PRIMARY KEY,
  token_address VARCHAR(56) NOT NULL,
  price_date DATE NOT NULL,
  usd_price NUMERIC(20, 10) NOT NULL,
  source VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(token_address, price_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_token_prices_lookup
  ON daily_token_prices(token_address, price_date);
CREATE INDEX IF NOT EXISTS idx_daily_token_prices_date
  ON daily_token_prices(price_date);
```

### Step 2: Seed Token Metadata

Script to populate `coingecko_id` and `pegged_currency` for known tokens:

```typescript
// scripts/seed-token-metadata.ts

const TOKEN_METADATA = [
  { symbol: 'XLM', coingecko_id: 'stellar', pegged_currency: null },
  { symbol: 'BLND', coingecko_id: 'blend-2', pegged_currency: null },
  { symbol: 'AQUA', coingecko_id: 'aquarius', pegged_currency: null },
  { symbol: 'USDC', coingecko_id: null, pegged_currency: 'USD' },
  // LP token has neither - price comes from SDK
];

async function seedTokenMetadata() {
  for (const token of TOKEN_METADATA) {
    await db.query(`
      UPDATE tokens
      SET coingecko_id = $1, pegged_currency = $2
      WHERE symbol = $3
    `, [token.coingecko_id, token.pegged_currency, token.symbol]);
  }
}
```

### Step 3: CoinGecko Historical Backfill Script

Fetches historical prices from CoinGecko for tokens with `coingecko_id`:

```typescript
// scripts/backfill-coingecko-prices.ts

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const START_DATE = new Date('2025-04-15');  // Start of backstop_events

interface TokenToBackfill {
  asset_address: string;
  coingecko_id: string;
  symbol: string;
}

async function getTokensToBackfill(): Promise<TokenToBackfill[]> {
  const result = await db.query(`
    SELECT asset_address, coingecko_id, symbol
    FROM tokens
    WHERE coingecko_id IS NOT NULL
      AND pegged_currency IS NULL
  `);
  return result.rows;
}

async function fetchCoinGeckoHistory(
  coingeckoId: string,
  from: Date,
  to: Date
): Promise<Array<[number, number]>> {
  const url = `${COINGECKO_BASE}/coins/${coingeckoId}/market_chart/range?vs_currency=usd&from=${Math.floor(from.getTime() / 1000)}&to=${Math.floor(to.getTime() / 1000)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CoinGecko API error: ${response.status}`);
  }

  const data = await response.json();
  return data.prices;  // [[timestamp_ms, price], ...]
}

async function backfillToken(token: TokenToBackfill) {
  console.log(`Backfilling ${token.symbol} (${token.coingecko_id})...`);

  const prices = await fetchCoinGeckoHistory(
    token.coingecko_id,
    START_DATE,
    new Date()
  );

  for (const [timestampMs, price] of prices) {
    const priceDate = new Date(timestampMs).toISOString().split('T')[0];

    await db.query(`
      INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
      VALUES ($1, $2, $3, 'coingecko')
      ON CONFLICT (token_address, price_date)
      DO UPDATE SET usd_price = EXCLUDED.usd_price, source = 'coingecko'
    `, [token.asset_address, priceDate, price]);
  }

  console.log(`  Inserted ${prices.length} price points`);
}

async function backfillPeggedTokens() {
  // Insert $1.00 for all dates for pegged tokens
  const result = await db.query(`
    SELECT asset_address, symbol, pegged_currency
    FROM tokens
    WHERE pegged_currency IS NOT NULL
  `);

  for (const token of result.rows) {
    console.log(`Backfilling ${token.symbol} (pegged to ${token.pegged_currency})...`);

    // Get date range from existing data
    const dateRange = await db.query(`
      SELECT MIN(price_date) as min_date, MAX(price_date) as max_date
      FROM daily_token_prices
    `);

    const minDate = dateRange.rows[0]?.min_date || START_DATE;
    const maxDate = dateRange.rows[0]?.max_date || new Date();

    // Generate all dates and insert $1.00 (assuming USD peg)
    const pegValue = token.pegged_currency === 'USD' ? 1.0 : 1.0;  // Extend for other currencies

    await db.query(`
      INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
      SELECT $1, d::date, $2, 'pegged'
      FROM generate_series($3::date, $4::date, '1 day'::interval) d
      ON CONFLICT (token_address, price_date) DO NOTHING
    `, [token.asset_address, pegValue, minDate, maxDate]);
  }
}

async function main() {
  const tokens = await getTokensToBackfill();

  for (const token of tokens) {
    await backfillToken(token);
    // Rate limit: wait 2 seconds between tokens
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  await backfillPeggedTokens();

  console.log('Backfill complete!');
}
```

### Step 4: LP Token Historical Backfill (from Hubble)

Separate script for LP token prices using BigQuery (as documented in `historical-lp-price-indexer.md`):

```typescript
// scripts/backfill-lp-prices.ts

// This uses the Hubble BigQuery approach from historical-lp-price-indexer.md
// LP prices are calculated as: (5 * usdc_balance) / total_lp_tokens / 1e7

const LP_TOKEN_ADDRESS = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM';

async function insertLpPricesFromHubble(hubbleData: Array<{
  price_date: string;
  lp_token_price: number;
}>) {
  for (const row of hubbleData) {
    await db.query(`
      INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
      VALUES ($1, $2, $3, 'hubble')
      ON CONFLICT (token_address, price_date)
      DO UPDATE SET usd_price = EXCLUDED.usd_price
    `, [LP_TOKEN_ADDRESS, row.price_date, row.lp_token_price]);
  }
}

// BigQuery query to run manually (per CLAUDE.md - don't run BigQuery directly):
/*
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
*/
```

### Step 5: Daily Price Capture Cron Job

Captures current prices from SDK (for all tokens including LP):

```typescript
// src/cron/capture-daily-prices.ts

import { Backstop, Pool } from '@blend-capital/blend-sdk';

const BACKSTOP_ID = 'CAO3AGAMZVRMHITL36EJ2VZQWKYRPWMQAPDQD5YEOF3GIF7T44U4JAL3';
const LP_TOKEN_ADDRESS = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM';

interface CaptureResult {
  captured: string[];
  errors: string[];
}

export async function captureDailyPrices(): Promise<CaptureResult> {
  const network = {
    rpc: process.env.RPC_URL!,
    passphrase: 'Public Global Stellar Network ; September 2015',
    opts: { allowHttp: false }
  };

  const today = new Date().toISOString().split('T')[0];
  const captured: string[] = [];
  const errors: string[] = [];

  // 1. Get all tracked pools from database
  const poolsResult = await db.query(`SELECT pool_id FROM pools WHERE is_active = true`);
  const poolIds = poolsResult.rows.map(r => r.pool_id);

  // 2. Capture LP token price from Backstop
  try {
    const backstop = await Backstop.load(network, BACKSTOP_ID);
    const lpPrice = backstop.backstopToken.lpTokenPrice;

    await saveDailyPrice(LP_TOKEN_ADDRESS, today, lpPrice, 'sdk_lp');
    captured.push(`LP: $${lpPrice.toFixed(4)}`);
  } catch (error) {
    errors.push(`LP token: ${error.message}`);
  }

  // 3. Capture reserve token prices from each pool
  for (const poolId of poolIds) {
    try {
      const pool = await Pool.load(network, poolId);

      for (const [assetId, reserve] of pool.reserves) {
        // Skip if this is a pegged token
        const tokenInfo = await db.query(
          `SELECT pegged_currency FROM tokens WHERE asset_address = $1`,
          [assetId]
        );

        if (tokenInfo.rows[0]?.pegged_currency) {
          // For pegged tokens, just save the pegged value
          await saveDailyPrice(assetId, today, 1.0, 'pegged');
          captured.push(`${assetId.slice(0, 8)}: $1.00 (pegged)`);
          continue;
        }

        if (reserve.oraclePrice && reserve.oraclePrice > 0) {
          await saveDailyPrice(assetId, today, reserve.oraclePrice, 'sdk_oracle');
          captured.push(`${assetId.slice(0, 8)}: $${reserve.oraclePrice.toFixed(4)}`);
        }
      }
    } catch (error) {
      errors.push(`Pool ${poolId.slice(0, 8)}: ${error.message}`);
    }
  }

  return { captured, errors };
}

async function saveDailyPrice(
  tokenAddress: string,
  date: string,
  price: number,
  source: string
) {
  await db.query(`
    INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (token_address, price_date)
    DO UPDATE SET usd_price = EXCLUDED.usd_price, source = EXCLUDED.source
  `, [tokenAddress, date, price, source]);
}
```

### Step 6: API Endpoint for Cron (if using Vercel/serverless)

```typescript
// src/api/routes/cron-prices.ts

import { Router } from 'express';
import { captureDailyPrices } from '../cron/capture-daily-prices';

const router = Router();

router.get('/cron/capture-prices', async (req, res) => {
  // Verify cron secret
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const result = await captureDailyPrices();

  console.log(`Captured prices: ${result.captured.join(', ')}`);
  if (result.errors.length > 0) {
    console.error(`Errors: ${result.errors.join(', ')}`);
  }

  res.json({
    success: result.errors.length === 0,
    captured: result.captured,
    errors: result.errors
  });
});

export default router;
```

---

## Price Source Priority

| Token Type | Historical Backfill | Daily Capture |
|------------|---------------------|---------------|
| Has `coingecko_id` | CoinGecko API | SDK Oracle |
| Has `pegged_currency` | Hardcode (e.g., $1.00) | Hardcode |
| LP Token | Hubble BigQuery | SDK Backstop |
| Other (no mapping) | Skip | SDK Oracle (if available) |

---

## Validation Queries

```sql
-- Check price coverage per token
SELECT
  t.symbol,
  t.asset_address,
  t.coingecko_id,
  t.pegged_currency,
  MIN(dtp.price_date) as earliest_price,
  MAX(dtp.price_date) as latest_price,
  COUNT(dtp.id) as price_days
FROM tokens t
LEFT JOIN daily_token_prices dtp ON t.asset_address = dtp.token_address
GROUP BY t.symbol, t.asset_address, t.coingecko_id, t.pegged_currency
ORDER BY t.symbol;

-- Check for gaps in price data
SELECT
  token_address,
  price_date,
  LAG(price_date) OVER (PARTITION BY token_address ORDER BY price_date) as prev_date,
  price_date - LAG(price_date) OVER (PARTITION BY token_address ORDER BY price_date) as gap_days
FROM daily_token_prices
HAVING gap_days > 1;

-- Sample prices for verification
SELECT
  t.symbol,
  dtp.price_date,
  dtp.usd_price,
  dtp.source
FROM daily_token_prices dtp
JOIN tokens t ON t.asset_address = dtp.token_address
WHERE dtp.price_date >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY t.symbol, dtp.price_date DESC;
```

---

## Checklist

### Phase 1: Database Setup
- [ ] Run migration to add `coingecko_id` and `pegged_currency` columns to `tokens`
- [ ] Run migration to create `daily_token_prices` table
- [ ] Run seed script to populate token metadata

### Phase 2: Historical Backfill
- [ ] Run CoinGecko backfill script for XLM, BLND, AQUA
- [ ] Run BigQuery for LP token historical prices (user runs query, script imports)
- [ ] Backfill pegged tokens (USDC) with $1.00 values
- [ ] Validate price coverage with queries above

### Phase 3: Daily Cron
- [ ] Deploy daily price capture cron job
- [ ] Verify cron runs successfully for 2-3 days
- [ ] Monitor for any missing prices or errors

---

## Notes

- **CoinGecko Rate Limits:** Free tier allows 10-30 calls/minute. Backfill script includes 2-second delay between tokens.
- **LP Token:** No CoinGecko listing. Price calculated from Comet pool composition via Hubble (historical) or SDK (daily).
- **New Tokens:** When new tokens are added to the protocol, update the `tokens` table with appropriate `coingecko_id` or `pegged_currency` values.
