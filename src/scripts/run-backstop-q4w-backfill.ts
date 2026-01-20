/**
 * Backstop Q4W Percentage Backfill Runner
 *
 * Imports historical backstop pool balance data (shares, tokens, q4w)
 * from Hubble BigQuery contract_data table.
 *
 * Usage:
 *   npm run backfill:backstop-q4w [options]
 *
 * Options:
 *   --start-date, -s   Start date (YYYY-MM-DD), default: 2025-04-14
 *   --end-date, -e     End date (YYYY-MM-DD), default: today
 *   --pool, -p         Filter to specific pool address
 *   --limit, -l        Limit number of rows (for testing)
 *   --dry-run, -d      Simulate without writing to database
 *   --yes, -y          Skip confirmation prompts
 *   --query            Print the BigQuery query and exit
 *   --help, -h         Show help
 *
 * Examples:
 *   npm run backfill:backstop-q4w                           # Full backfill
 *   npm run backfill:backstop-q4w -- --dry-run              # Simulate
 *   npm run backfill:backstop-q4w -- --start-date 2025-05-01
 *   npm run backfill:backstop-q4w -- --pool CCCC...         # Single pool
 *   npm run backfill:backstop-q4w -- --query                # Show query
 */

import dotenv from "dotenv";
import path from "path";
import { backstopQ4wBackfillService } from "../services/backstop-q4w-backfill";
import { backstopPoolSnapshotRepository } from "../repositories/backstop-pool-snapshot-repository";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function printHelp() {
  console.log(`
Backstop Q4W Percentage Backfill Tool

USAGE:
  npm run backfill:backstop-q4w [OPTIONS]

OPTIONS:
  --start-date, -s   Start date (YYYY-MM-DD), default: 2025-04-14
  --end-date, -e     End date (YYYY-MM-DD), default: today
  --pool, -p         Filter to specific pool address
  --limit, -l        Limit number of rows (for testing)
  --dry-run, -d      Simulate without writing to database
  --yes, -y          Skip confirmation prompts
  --query            Print the BigQuery query and exit
  --help, -h         Show this help message

DESCRIPTION:
  This tool imports historical backstop pool balance data from Hubble BigQuery.
  It captures daily snapshots of shares, tokens, and q4w (queued for withdrawal)
  for each backstop pool, calculating the Q4W percentage.

  Q4W Percentage = (q4w / shares) * 100

  This metric shows what percentage of backstop deposits are currently queued
  for withdrawal.

EXAMPLES:

  1. Full backfill from Blend v2 launch:
     npm run backfill:backstop-q4w -- --yes

  2. Dry run to preview data:
     npm run backfill:backstop-q4w -- --dry-run

  3. Backfill from specific date:
     npm run backfill:backstop-q4w -- --start-date 2025-05-01

  4. Backfill specific pool:
     npm run backfill:backstop-q4w -- --pool CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS

  5. Test with limit:
     npm run backfill:backstop-q4w -- --limit 10 --dry-run

  6. Show the BigQuery query:
     npm run backfill:backstop-q4w -- --query

DATA SOURCE:
  BigQuery table: crypto-stellar.crypto_stellar.contract_data
  Storage key: PoolBalance
  Backstop contract: CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7

TARGET TABLE:
  backstop_pool_snapshots (pool_address, snapshot_date, shares, tokens, q4w, q4w_pct)
`);
}

function parseArgs(args: string[]): {
  startDate?: string;
  endDate?: string;
  poolAddress?: string;
  limit?: number;
  dryRun: boolean;
  skipConfirmation: boolean;
  showQuery: boolean;
  showHelp: boolean;
} {
  const result = {
    startDate: undefined as string | undefined,
    endDate: undefined as string | undefined,
    poolAddress: undefined as string | undefined,
    limit: undefined as number | undefined,
    dryRun: false,
    skipConfirmation: false,
    showQuery: false,
    showHelp: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.showHelp = true;
    } else if (arg === "--query") {
      result.showQuery = true;
    } else if (arg === "--dry-run" || arg === "-d") {
      result.dryRun = true;
    } else if (arg === "--yes" || arg === "-y") {
      result.skipConfirmation = true;
    } else if (arg === "--start-date" || arg === "-s") {
      result.startDate = args[++i];
    } else if (arg === "--end-date" || arg === "-e") {
      result.endDate = args[++i];
    } else if (arg === "--pool" || arg === "-p") {
      result.poolAddress = args[++i];
    } else if (arg === "--limit" || arg === "-l") {
      result.limit = parseInt(args[++i], 10);
    }
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const options = parseArgs(args);

  // Check for help flag
  if (options.showHelp) {
    printHelp();
    process.exit(0);
  }

  // Check for query flag
  if (options.showQuery) {
    console.log("═".repeat(70));
    console.log("  BigQuery Query for Backstop Q4W Percentage");
    console.log("═".repeat(70));
    console.log("\nRun this query in BigQuery Console:\n");
    console.log(backstopQ4wBackfillService.getBigQueryQuery({
      startDate: options.startDate,
      endDate: options.endDate,
      poolAddress: options.poolAddress,
    }));
    console.log("\n" + "═".repeat(70));
    process.exit(0);
  }

  console.log("═".repeat(70));
  console.log("  Backstop Q4W Percentage Backfill");
  console.log("═".repeat(70));
  console.log(`  Start date:  ${options.startDate || "2025-04-14 (default)"}`);
  console.log(`  End date:    ${options.endDate || "today"}`);
  console.log(`  Pool filter: ${options.poolAddress || "all pools"}`);
  console.log(`  Mode:        ${options.dryRun ? "DRY RUN (simulation)" : "LIVE"}`);
  if (options.limit) {
    console.log(`  Limit:       ${options.limit} rows`);
  }
  console.log(`  Backstop:    ${backstopQ4wBackfillService.getBackstopContract()}`);

  try {
    // Get current stats
    const stats = await backstopPoolSnapshotRepository.getStats();
    console.log("\n📊 Current Database Stats:");
    console.log(`   Total rows:    ${stats.total_rows}`);
    console.log(`   Date range:    ${stats.earliest_date || "N/A"} to ${stats.latest_date || "N/A"}`);
    console.log(`   Unique pools:  ${stats.unique_pools}`);

    if (options.dryRun) {
      // Run simulation
      console.log("\n🔍 Running simulation...");
      const result = await backstopQ4wBackfillService.simulate({
        startDate: options.startDate,
        endDate: options.endDate,
        poolAddress: options.poolAddress,
        limit: options.limit || 20,
      });

      console.log("\n" + "═".repeat(70));
      console.log("  Simulation Results");
      console.log("═".repeat(70));
      console.log(`  Status:         ${result.success ? "✅ Success" : "❌ Failed"}`);
      console.log(`  Rows fetched:   ${result.rows.length}`);
      console.log(`  Estimated cost: $${result.estimated_cost}`);

      if (result.error) {
        console.log(`  Error:          ${result.error}`);
      }

      console.log("\n  ⚠️  DRY RUN - No data was written to database");
      console.log("  Run without --dry-run to perform actual backfill");
      console.log("═".repeat(70) + "\n");

      process.exit(result.success ? 0 : 1);
    } else {
      // Run actual backfill
      const result = await backstopQ4wBackfillService.runBackfill({
        startDate: options.startDate,
        endDate: options.endDate,
        poolAddress: options.poolAddress,
        limit: options.limit,
        skipConfirmation: options.skipConfirmation,
      });

      console.log("\n" + "═".repeat(70));
      console.log("  Backfill Results");
      console.log("═".repeat(70));
      console.log(`  Status:         ${result.success ? "✅ Success" : "❌ Failed"}`);
      console.log(`  Rows fetched:   ${result.rows_fetched}`);
      console.log(`  Rows inserted:  ${result.rows_inserted}`);
      console.log(`  Rows updated:   ${result.rows_updated}`);
      console.log(`  Estimated cost: $${result.estimated_cost || "N/A"}`);

      if (result.error) {
        console.log(`  Error:          ${result.error}`);
      }

      // Show updated stats
      if (result.rows_inserted > 0 || result.rows_updated > 0) {
        const newStats = await backstopPoolSnapshotRepository.getStats();
        console.log("\n📊 Updated Database Stats:");
        console.log(`   Total rows:    ${newStats.total_rows}`);
        console.log(`   Date range:    ${newStats.earliest_date || "N/A"} to ${newStats.latest_date || "N/A"}`);
        console.log(`   Unique pools:  ${newStats.unique_pools}`);
      }

      console.log("═".repeat(70) + "\n");

      process.exit(result.success ? 0 : 1);
    }
  } catch (error) {
    console.error("\n❌ Fatal error:", error);
    process.exit(1);
  }
}

main();
