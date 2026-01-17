/**
 * Backfill historical TESOURO token prices from Etherfuse API
 *
 * Fetches historical prices for the TESOURO bond token.
 * API returns tokenPrice (BRL) and usdExchangeRate (BRL/USD).
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

// Etherfuse bond address for TESOURO
const ETHERFUSE_BOND_ID = "BRNTNaZeTJANz9PeuD8drNbBHwGgg7ZTjiQYrFgWQ48p";
const ETHERFUSE_API_URL = `https://api.etherfuse.com/lookup/bonds/history/${ETHERFUSE_BOND_ID}`;

interface EtherfusePricePoint {
  date: string;            // ISO 8601 timestamp
  tokenPrice: string;      // Price in BRL (string)
  usdExchangeRate: string; // BRL per USD (string)
  statusType: string;      // "Issuance" or "Daily"
}

interface EtherfuseResponse {
  historyRange: EtherfusePricePoint[];
}

async function getTesouroTokenAddress(): Promise<string | null> {
  const result = await pool.query(`
    SELECT asset_address
    FROM tokens
    WHERE symbol = 'TESOURO'
  `);
  return result.rows[0]?.asset_address || null;
}

async function fetchEtherfuseHistory(): Promise<EtherfusePricePoint[]> {
  console.log(`  Fetching: ${ETHERFUSE_API_URL}`);

  const response = await fetch(ETHERFUSE_API_URL);

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

async function backfillTesouro(): Promise<number> {
  console.log("\n  Fetching TESOURO prices from Etherfuse...");

  const tokenAddress = await getTesouroTokenAddress();
  if (!tokenAddress) {
    throw new Error("TESOURO token not found in tokens table");
  }

  console.log(`  TESOURO address: ${tokenAddress}`);

  // Get existing dates to avoid duplicates
  const existingDates = await getExistingPriceDates(tokenAddress);
  console.log(`  Existing price points: ${existingDates.size}`);

  const prices = await fetchEtherfuseHistory();
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

    // Calculate USD price: tokenPrice (BRL) / usdExchangeRate (BRL/USD) = USD
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

    console.log(`    ${priceDate}: $${usdPrice.toFixed(6)} (BRL ${tokenPrice.toFixed(4)} / ${usdExchangeRate.toFixed(4)})`);
    inserted++;
  }

  console.log(`  Inserted ${inserted} new price points`);
  return inserted;
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Etherfuse Historical Price Backfill (TESOURO)");
  console.log("═══════════════════════════════════════════════════════════");

  try {
    // Test connection
    await pool.query("SELECT 1");
    console.log("  Database connected\n");

    const inserted = await backfillTesouro();

    // Summary
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("  Summary");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  Total price points inserted: ${inserted}`);
    console.log("═══════════════════════════════════════════════════════════\n");

  } catch (error) {
    console.error("Backfill failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
