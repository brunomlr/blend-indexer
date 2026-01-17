/**
 * LP Token Price Backfill Runner
 *
 * Imports historical LP token prices from Hubble BigQuery exports.
 *
 * Usage:
 *   npm run backfill:lp-prices -- <path-to-json-file> [options]
 *
 * Options:
 *   --dry-run, -d    Simulate the import without writing to database
 *   --yes, -y        Skip confirmation prompts
 *   --query          Print the BigQuery query and exit
 *   --help, -h       Show help
 *
 * Examples:
 *   npm run backfill:lp-prices -- --query
 *   npm run backfill:lp-prices -- ./data/lp-prices.json --dry-run
 *   npm run backfill:lp-prices -- ./data/lp-prices.json --yes
 */

import dotenv from "dotenv";
import path from "path";
import { Pool } from "pg";
import { LpPriceBackfillService } from "../services/lp-price-backfill";
import { confirm } from "../utils/prompt";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("neon")
    ? { rejectUnauthorized: false }
    : undefined,
});

function printHelp() {
  console.log(`
LP Token Price Backfill Tool

USAGE:
  npm run backfill:lp-prices -- <path-to-json-file> [OPTIONS]
  npm run backfill:lp-prices -- --query

OPTIONS:
  --dry-run, -d    Simulate the import without writing to database
  --yes, -y        Skip confirmation prompts
  --query          Print the BigQuery query to run and exit
  --help, -h       Show this help message

WORKFLOW:
  1. Run with --query to get the BigQuery query
  2. Run the query in BigQuery Console
  3. Export results as JSON (newline-delimited or regular JSON)
  4. Run this script with the exported JSON file

EXAMPLES:

  1. Get the BigQuery query:
     npm run backfill:lp-prices -- --query

  2. Dry run to see what would be imported:
     npm run backfill:lp-prices -- ./data/lp-prices.json --dry-run

  3. Run the actual import:
     npm run backfill:lp-prices -- ./data/lp-prices.json

  4. Run with auto-confirmation:
     npm run backfill:lp-prices -- ./data/lp-prices.json --yes

EXPECTED JSON FORMAT:
  Array of objects with:
    - price_date: string (YYYY-MM-DD)
    - lp_token_price: number (USD price per LP token)
    - ledger_sequence: number (optional)

  Example:
    [
      { "price_date": "2025-04-15", "lp_token_price": 0.302, "ledger_sequence": 12345 },
      { "price_date": "2025-04-16", "lp_token_price": 0.305, "ledger_sequence": 12400 }
    ]

  Or newline-delimited JSON (.ndjson):
    {"price_date":"2025-04-15","lp_token_price":0.302}
    {"price_date":"2025-04-16","lp_token_price":0.305}
`);
}

async function main() {
  const args = process.argv.slice(2);

  // Check for help flag
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const service = new LpPriceBackfillService(pool);

  // Check for query flag
  if (args.includes("--query")) {
    console.log("═".repeat(60));
    console.log("  BigQuery Query for LP Token Prices");
    console.log("═".repeat(60));
    console.log("\nRun this query in BigQuery Console:\n");
    console.log(service.getBigQueryQuery());
    console.log("\n" + "═".repeat(60));
    console.log("  Instructions");
    console.log("═".repeat(60));
    console.log(`
1. Go to https://console.cloud.google.com/bigquery
2. Run the query above
3. Click "Save Results" → "JSON (newline delimited)" or "JSON"
4. Save the file locally
5. Run: npm run backfill:lp-prices -- <path-to-file>
`);
    process.exit(0);
  }

  // Parse options
  const dryRun = args.includes("--dry-run") || args.includes("-d");
  const skipConfirmation = args.includes("--yes") || args.includes("-y");

  // Get file path (first non-flag argument)
  const filePath = args.find((arg) => !arg.startsWith("-"));

  if (!filePath) {
    console.error("❌ Error: No input file specified");
    console.error("\nUsage: npm run backfill:lp-prices -- <path-to-json-file>");
    console.error("       npm run backfill:lp-prices -- --query");
    console.error("\nRun with --help for more information");
    process.exit(1);
  }

  console.log("═".repeat(60));
  console.log("  LP Token Price Backfill");
  console.log("═".repeat(60));
  console.log(`  Input file: ${filePath}`);
  console.log(`  Mode:       ${dryRun ? "DRY RUN (simulation)" : "LIVE"}`);
  console.log(`  LP Token:   CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM`);

  try {
    // Test connection
    await pool.query("SELECT 1");
    console.log("  Database:   Connected\n");

    // Get current stats
    const stats = await service.getStats();
    console.log("📊 Current LP Price Data:");
    console.log(`   Total prices:   ${stats.totalPrices}`);
    console.log(`   Earliest date:  ${stats.earliestDate || "N/A"}`);
    console.log(`   Latest date:    ${stats.latestDate || "N/A"}`);

    // Confirmation
    if (!skipConfirmation && !dryRun) {
      console.log("");
      const proceed = await confirm("Proceed with import?");
      if (!proceed) {
        console.log("\n❌ Import cancelled by user");
        process.exit(0);
      }
    } else if (skipConfirmation && !dryRun) {
      console.log("\n  Auto-proceeding (--yes flag)\n");
    }

    // Run backfill
    const result = await service.runBackfill({
      filePath,
      dryRun,
      skipConfirmation,
    });

    // Summary
    console.log("\n" + "═".repeat(60));
    console.log("  Summary");
    console.log("═".repeat(60));
    console.log(`  Status:          ${result.success ? "✅ Success" : "❌ Failed"}`);
    console.log(`  Rows processed:  ${result.rowsProcessed}`);
    console.log(`  Rows inserted:   ${result.rowsInserted}`);
    console.log(`  Rows skipped:    ${result.rowsSkipped}`);

    if (dryRun) {
      console.log("\n  ⚠️  DRY RUN - No data was written to database");
      console.log("  Run without --dry-run to perform actual import");
    }

    if (result.error) {
      console.log(`\n  Error: ${result.error}`);
    }

    // Show updated stats
    if (result.rowsInserted > 0) {
      const newStats = await service.getStats();
      console.log("\n📊 Updated LP Price Data:");
      console.log(`   Total prices:   ${newStats.totalPrices}`);
      console.log(`   Earliest date:  ${newStats.earliestDate || "N/A"}`);
      console.log(`   Latest date:    ${newStats.latestDate || "N/A"}`);
    }

    console.log("═".repeat(60) + "\n");

    process.exit(result.success ? 0 : 1);
  } catch (error) {
    console.error("\n❌ Fatal error:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
