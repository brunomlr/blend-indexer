/**
 * Backfill historical Etherfuse bond token prices (TESOURO, USTRY)
 *
 * Fetches historical prices for Etherfuse bond tokens.
 * API returns tokenPrice (local currency) and usdExchangeRate (currency/USD).
 * USD price = tokenPrice / usdExchangeRate
 *
 * Run:
 *   npx ts-node src/scripts/backfill-etherfuse-prices.ts
 */

import dotenv from "dotenv";
import path from "path";
import { Pool } from "pg";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("neon") ? { rejectUnauthorized: false } : undefined,
});

// Etherfuse bond IDs by token symbol
const ETHERFUSE_BONDS: Record<string, string> = {
  TESOURO: "BRNTNaZeTJANz9PeuD8drNbBHwGgg7ZTjiQYrFgWQ48p",
  USTRY: "USTRYnGgcHAhdWsanv8BG6vHGd4p7UGgoB9NRd8ei7j",
};

interface EtherfusePricePoint {
  date: string;            // ISO 8601 timestamp
  tokenPrice: string;      // Price in local currency (string)
  usdExchangeRate: string; // Currency per USD (string)
  statusType: string;      // "Issuance" or "Daily"
}

interface EtherfuseResponse {
  historyRange: EtherfusePricePoint[];
}

async function getTokenAddress(symbol: string): Promise<string | null> {
  const result = await pool.query(`
    SELECT asset_address
    FROM tokens
    WHERE symbol = $1
  `, [symbol]);
  return result.rows[0]?.asset_address || null;
}

async function fetchEtherfuseHistory(bondId: string): Promise<EtherfusePricePoint[]> {
  const url = `https://api.etherfuse.com/lookup/bonds/history/${bondId}`;
  console.log(`  Fetching: ${url}`);

  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Etherfuse API error ${response.status}: ${text}`);
  }

  const data: EtherfuseResponse = await response.json();

  if (data.historyRange && Array.isArray(data.historyRange)) {
    return data.historyRange;
  }

  return [];
}

async function getExistingPriceDates(tokenAddress: string): Promise<Set<string>> {
  const result = await pool.query(`
    SELECT price_date::text
    FROM daily_token_prices
    WHERE token_address = $1
  `, [tokenAddress]);
  return new Set(result.rows.map(r => r.price_date.split('T')[0]));
}

async function backfillBond(symbol: string, bondId: string): Promise<number> {
  console.log(`\n  Fetching ${symbol} prices from Etherfuse...`);

  const tokenAddress = await getTokenAddress(symbol);
  if (!tokenAddress) {
    console.log(`  ${symbol} token not found in tokens table, skipping`);
    return 0;
  }

  console.log(`  ${symbol} address: ${tokenAddress}`);

  // Get existing dates to avoid duplicates
  const existingDates = await getExistingPriceDates(tokenAddress);
  console.log(`  Existing price points: ${existingDates.size}`);

  const prices = await fetchEtherfuseHistory(bondId);
  console.log(`  Etherfuse returned ${prices.length} price points`);

  // Group by date and take the last entry for each day
  const dailyPrices = new Map<string, EtherfusePricePoint>();
  for (const point of prices) {
    const priceDate = point.date.split("T")[0];
    // Keep the last entry for each date (they're ordered chronologically)
    dailyPrices.set(priceDate, point);
  }

  console.log(`  Unique days: ${dailyPrices.size}`);

  let inserted = 0;
  for (const [priceDate, point] of dailyPrices) {
    // Parse string values to numbers
    const tokenPrice = parseFloat(point.tokenPrice);
    const usdExchangeRate = parseFloat(point.usdExchangeRate);

    // Calculate USD price: tokenPrice (local currency) / usdExchangeRate (currency/USD) = USD
    const usdPrice = tokenPrice / usdExchangeRate;

    // Skip if we already have this date
    if (existingDates.has(priceDate)) {
      continue;
    }

    await pool.query(`
      INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
      VALUES ($1, $2, $3, 'etherfuse')
      ON CONFLICT (token_address, price_date)
      DO UPDATE SET usd_price = EXCLUDED.usd_price, source = 'etherfuse'
    `, [tokenAddress, priceDate, usdPrice]);

    console.log(`    ${priceDate}: $${usdPrice.toFixed(6)} (${tokenPrice.toFixed(4)} / ${usdExchangeRate.toFixed(4)})`);
    inserted++;
  }

  console.log(`  Inserted ${inserted} new price points`);
  return inserted;
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Etherfuse Historical Price Backfill (TESOURO, USTRY)");
  console.log("═══════════════════════════════════════════════════════════");

  try {
    // Test connection
    await pool.query("SELECT 1");
    console.log("  Database connected\n");

    let totalInserted = 0;
    for (const [symbol, bondId] of Object.entries(ETHERFUSE_BONDS)) {
      totalInserted += await backfillBond(symbol, bondId);
    }

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
