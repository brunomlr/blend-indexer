/**
 * Backfill historical token prices from CoinGecko
 *
 * Fetches daily prices for tokens that have a coingecko_id set in the tokens table.
 * Skips tokens with pegged_currency (stablecoins).
 *
 * Run:
 *   npx ts-node src/scripts/backfill-coingecko-prices.ts
 */

import dotenv from "dotenv";
import path from "path";
import { Pool } from "pg";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("neon") ? { rejectUnauthorized: false } : undefined,
});

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const START_DATE = new Date("2025-04-15"); // Start of backstop_events
const RATE_LIMIT_MS = 2500; // 2.5 seconds between requests (conservative for free tier)

interface TokenToBackfill {
  asset_address: string;
  coingecko_id: string;
  symbol: string;
}

async function getTokensToBackfill(): Promise<TokenToBackfill[]> {
  const result = await pool.query(`
    SELECT asset_address, coingecko_id, symbol
    FROM tokens
    WHERE coingecko_id IS NOT NULL
      AND coingecko_id != ''
      AND pegged_currency IS NULL
  `);
  return result.rows;
}

async function fetchCoinGeckoHistory(
  coingeckoId: string,
  from: Date,
  to: Date
): Promise<Array<[number, number]>> {
  const fromTs = Math.floor(from.getTime() / 1000);
  const toTs = Math.floor(to.getTime() / 1000);

  const url = `${COINGECKO_BASE}/coins/${coingeckoId}/market_chart/range?vs_currency=usd&from=${fromTs}&to=${toTs}`;

  console.log(`    Fetching: ${url}`);

  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`CoinGecko API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.prices || [];
}

async function getExistingPriceDates(tokenAddress: string): Promise<Set<string>> {
  const result = await pool.query(`
    SELECT price_date::text
    FROM daily_token_prices
    WHERE token_address = $1
  `, [tokenAddress]);
  return new Set(result.rows.map(r => r.price_date.split('T')[0]));
}

async function backfillToken(token: TokenToBackfill): Promise<number> {
  console.log(`\n  Backfilling ${token.symbol} (${token.coingecko_id})...`);

  // Get existing dates to avoid duplicates
  const existingDates = await getExistingPriceDates(token.asset_address);
  console.log(`    Existing price points: ${existingDates.size}`);

  const prices = await fetchCoinGeckoHistory(
    token.coingecko_id,
    START_DATE,
    new Date()
  );

  console.log(`    CoinGecko returned ${prices.length} price points`);

  let inserted = 0;
  for (const [timestampMs, price] of prices) {
    const priceDate = new Date(timestampMs).toISOString().split("T")[0];

    // Skip if we already have this date
    if (existingDates.has(priceDate)) {
      continue;
    }

    await pool.query(`
      INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
      VALUES ($1, $2, $3, 'coingecko')
      ON CONFLICT (token_address, price_date)
      DO UPDATE SET usd_price = EXCLUDED.usd_price, source = 'coingecko'
    `, [token.asset_address, priceDate, price]);

    inserted++;
  }

  console.log(`    Inserted ${inserted} new price points`);
  return inserted;
}

// Fetch historical USDC prices in a given fiat currency to derive exchange rates
async function fetchHistoricalForexRates(
  currency: string,
  from: Date,
  to: Date
): Promise<Map<string, number>> {
  const rates = new Map<string, number>();
  const currencyLower = currency.toLowerCase();
  const fromTs = Math.floor(from.getTime() / 1000);
  const toTs = Math.floor(to.getTime() / 1000);

  const url = `${COINGECKO_BASE}/coins/usd-coin/market_chart/range?vs_currency=${currencyLower}&from=${fromTs}&to=${toTs}`;

  console.log(`    Fetching USDC/${currency.toUpperCase()} historical rates...`);

  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`CoinGecko API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const prices: Array<[number, number]> = data.prices || [];

  for (const [timestampMs, usdcInCurrency] of prices) {
    const date = new Date(timestampMs).toISOString().split("T")[0];
    // 1 USDC = X currency, so 1 currency = 1/X USD
    if (usdcInCurrency > 0) {
      rates.set(date, 1 / usdcInCurrency);
    }
  }

  console.log(`    Got ${rates.size} ${currency.toUpperCase()}/USD rate points`);
  return rates;
}

async function backfillPeggedTokens(): Promise<number> {
  console.log("\n  Backfilling pegged tokens (stablecoins)...");

  const result = await pool.query(`
    SELECT asset_address, symbol, pegged_currency
    FROM tokens
    WHERE pegged_currency IS NOT NULL
  `);

  if (result.rows.length === 0) {
    console.log("    No pegged tokens found");
    return 0;
  }

  // Get unique currencies that need forex rates (excluding USD)
  const currenciesNeeded = new Set<string>();
  for (const token of result.rows) {
    if (token.pegged_currency.toUpperCase() !== "USD") {
      currenciesNeeded.add(token.pegged_currency.toUpperCase());
    }
  }

  // Fetch historical forex rates for each currency
  const forexRates: Map<string, Map<string, number>> = new Map();
  const endDate = new Date();

  for (const currency of currenciesNeeded) {
    try {
      await sleep(RATE_LIMIT_MS);
      const rates = await fetchHistoricalForexRates(currency, START_DATE, endDate);
      forexRates.set(currency, rates);
    } catch (error) {
      console.error(`    ERROR fetching ${currency} rates:`, error);
    }
  }

  // Get date range for USD tokens
  const minDate = START_DATE.toISOString().split("T")[0];
  const maxDate = endDate.toISOString().split("T")[0];

  let totalInserted = 0;

  for (const token of result.rows) {
    const currency = token.pegged_currency.toUpperCase();
    console.log(`    ${token.symbol} (pegged to ${currency})...`);

    if (currency === "USD") {
      // USD-pegged tokens are always $1.00
      const insertResult = await pool.query(`
        INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
        SELECT $1, d::date, 1.0, 'pegged'
        FROM generate_series($2::date, $3::date, '1 day'::interval) d
        ON CONFLICT (token_address, price_date)
        DO UPDATE SET usd_price = EXCLUDED.usd_price, source = EXCLUDED.source
      `, [token.asset_address, minDate, maxDate]);

      console.log(`      Updated ${insertResult.rowCount} price points`);
      totalInserted += insertResult.rowCount || 0;
    } else {
      // Non-USD pegged tokens use historical forex rates
      const rates = forexRates.get(currency);
      if (!rates || rates.size === 0) {
        console.error(`      No forex rates available for ${currency}`);
        continue;
      }

      let updated = 0;
      for (const [date, usdValue] of rates) {
        await pool.query(`
          INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
          VALUES ($1, $2, $3, 'pegged')
          ON CONFLICT (token_address, price_date)
          DO UPDATE SET usd_price = EXCLUDED.usd_price, source = EXCLUDED.source
        `, [token.asset_address, date, usdValue]);
        updated++;
      }

      console.log(`      Updated ${updated} price points from ${currency}/USD rates`);
      totalInserted += updated;
    }
  }

  return totalInserted;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  CoinGecko Historical Price Backfill");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Start date: ${START_DATE.toISOString().split("T")[0]}`);
  console.log(`  End date:   ${new Date().toISOString().split("T")[0]}`);

  try {
    // Test connection
    await pool.query("SELECT 1");
    console.log("  Database connected\n");

    // Get tokens to backfill
    const tokens = await getTokensToBackfill();
    console.log(`Found ${tokens.length} tokens with coingecko_id:`);
    tokens.forEach(t => console.log(`  - ${t.symbol}: ${t.coingecko_id}`));

    // Backfill each token
    let totalInserted = 0;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      try {
        const inserted = await backfillToken(token);
        totalInserted += inserted;

        // Rate limit between requests (except for last one)
        if (i < tokens.length - 1) {
          console.log(`    Waiting ${RATE_LIMIT_MS}ms for rate limit...`);
          await sleep(RATE_LIMIT_MS);
        }
      } catch (error) {
        console.error(`    ERROR backfilling ${token.symbol}:`, error);
      }
    }

    // Backfill pegged tokens
    const peggedInserted = await backfillPeggedTokens();
    totalInserted += peggedInserted;

    // Summary
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("  Summary");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  Total price points inserted: ${totalInserted}`);
    console.log("═══════════════════════════════════════════════════════════\n");

  } catch (error) {
    console.error("Backfill failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
