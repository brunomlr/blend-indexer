/**
 * Backfill historical LP token prices from Hubble BigQuery export
 *
 * This script imports LP token prices from a JSON file exported from BigQuery.
 * The user must run the BigQuery query and export results to a JSON file.
 *
 * Usage:
 *   npx ts-node src/scripts/backfill-lp-prices.ts <path-to-json-file>
 *
 * Expected JSON format (array of objects):
 *   [
 *     { "price_date": "2025-04-15", "lp_token_price": 0.302 },
 *     { "price_date": "2025-04-16", "lp_token_price": 0.305 },
 *     ...
 *   ]
 *
 * BigQuery query to run:
 * -----------------------------------------------------------------------------
 * WITH total_shares AS (
 *   SELECT
 *     DATE(closed_at) as price_date,
 *     CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.i128') AS NUMERIC) as total_lp_tokens
 *   FROM `crypto-stellar.crypto_stellar.contract_data`
 *   WHERE contract_id = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM'
 *     AND key_decoded LIKE '%TotalShares%'
 *     AND closed_at >= '2025-04-15'
 *   QUALIFY ROW_NUMBER() OVER (PARTITION BY DATE(closed_at) ORDER BY closed_at DESC) = 1
 * ),
 * record_data AS (
 *   SELECT
 *     DATE(closed_at) as price_date,
 *     CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.map[0].val.map[0].val.i128') AS NUMERIC) as usdc_balance
 *   FROM `crypto-stellar.crypto_stellar.contract_data`
 *   WHERE contract_id = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM'
 *     AND key_decoded LIKE '%AllRecordData%'
 *     AND closed_at >= '2025-04-15'
 *   QUALIFY ROW_NUMBER() OVER (PARTITION BY DATE(closed_at) ORDER BY closed_at DESC) = 1
 * )
 * SELECT
 *   t.price_date,
 *   (5.0 * r.usdc_balance / t.total_lp_tokens) / 1e7 as lp_token_price
 * FROM total_shares t
 * JOIN record_data r ON t.price_date = r.price_date
 * ORDER BY t.price_date
 * -----------------------------------------------------------------------------
 */

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { Pool } from "pg";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("neon") ? { rejectUnauthorized: false } : undefined,
});

const LP_TOKEN_ADDRESS = "CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM";

interface LpPriceRow {
  price_date: string;
  lp_token_price: number;
}

function parseJsonFile(filePath: string): LpPriceRow[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(content);

  // Handle both array format and BigQuery export format
  if (Array.isArray(data)) {
    return data;
  }

  // BigQuery sometimes exports as newline-delimited JSON
  if (typeof data === "object" && data.rows) {
    return data.rows;
  }

  throw new Error("Unexpected JSON format. Expected array of { price_date, lp_token_price }");
}

function parseNdjsonFile(filePath: string): LpPriceRow[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");
  return lines.map(line => JSON.parse(line));
}

async function backfillLpPrices(data: LpPriceRow[]): Promise<number> {
  let inserted = 0;

  for (const row of data) {
    // Handle different date formats
    let priceDate = row.price_date;
    if (priceDate.includes("T")) {
      priceDate = priceDate.split("T")[0];
    }

    const price = Number(row.lp_token_price);
    if (isNaN(price) || price <= 0) {
      console.warn(`  Skipping invalid price for ${priceDate}: ${row.lp_token_price}`);
      continue;
    }

    await pool.query(`
      INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
      VALUES ($1, $2, $3, 'hubble')
      ON CONFLICT (token_address, price_date)
      DO UPDATE SET usd_price = EXCLUDED.usd_price, source = 'hubble'
    `, [LP_TOKEN_ADDRESS, priceDate, price]);

    inserted++;
  }

  return inserted;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage: npx ts-node src/scripts/backfill-lp-prices.ts <path-to-json-file>");
    console.log("");
    console.log("The JSON file should contain BigQuery export with columns:");
    console.log("  - price_date: YYYY-MM-DD");
    console.log("  - lp_token_price: number (USD price per LP token)");
    console.log("");
    console.log("See the BigQuery query in the script comments.");
    process.exit(1);
  }

  const filePath = args[0];

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  LP Token Price Backfill (from Hubble BigQuery)");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Input file: ${filePath}`);
  console.log(`  LP Token:   ${LP_TOKEN_ADDRESS}`);

  try {
    // Test connection
    await pool.query("SELECT 1");
    console.log("  Database connected\n");

    // Parse input file
    let data: LpPriceRow[];
    if (filePath.endsWith(".ndjson") || filePath.endsWith(".jsonl")) {
      data = parseNdjsonFile(filePath);
    } else {
      data = parseJsonFile(filePath);
    }

    console.log(`  Parsed ${data.length} price records from file`);

    if (data.length > 0) {
      console.log(`  Date range: ${data[0].price_date} to ${data[data.length - 1].price_date}`);
      console.log(`  Sample: ${data[0].price_date} = $${Number(data[0].lp_token_price).toFixed(6)}`);
    }

    // Backfill
    console.log("\n  Inserting prices...");
    const inserted = await backfillLpPrices(data);

    // Summary
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("  Summary");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  Records processed: ${data.length}`);
    console.log(`  Prices inserted:   ${inserted}`);
    console.log("═══════════════════════════════════════════════════════════\n");

  } catch (error) {
    console.error("Backfill failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
