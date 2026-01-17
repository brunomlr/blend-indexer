/**
 * Capture Daily Token Prices
 *
 * Captures current prices for all tokens from SDK oracle and backstop.
 * Can be run manually or scheduled via cron.
 *
 * Run:
 *   npx ts-node src/scripts/capture-daily-prices.ts
 *
 * For daily automation, schedule this script via:
 * - Cron job: 0 0 * * * cd /path/to/project && npx ts-node src/scripts/capture-daily-prices.ts
 * - GitHub Actions: scheduled workflow
 * - Vercel cron: API endpoint trigger
 */

import dotenv from "dotenv";
import path from "path";
import { Pool } from "pg";
import { DailyPriceCaptureService } from "../services/daily-price-capture";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("neon") ? { rejectUnauthorized: false } : undefined,
});

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Daily Token Price Capture");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Timestamp: ${new Date().toISOString()}`);

  try {
    // Test connection
    await pool.query("SELECT 1");
    console.log("  Database connected\n");

    const service = new DailyPriceCaptureService(pool);
    const result = await service.captureDailyPrices();

    // Summary
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("  Summary");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  Date:            ${result.date}`);
    console.log(`  Prices captured: ${result.pricesInserted}`);
    console.log(`  Errors:          ${result.errors.length}`);

    if (result.captured.length > 0) {
      console.log("\n  Captured prices:");
      result.captured.forEach(p => console.log(`    - ${p}`));
    }

    if (result.errors.length > 0) {
      console.log("\n  Errors:");
      result.errors.forEach(e => console.log(`    - ${e}`));
    }

    console.log("═══════════════════════════════════════════════════════════\n");

    // Exit with error code if there were failures
    if (result.errors.length > 0 && result.pricesInserted === 0) {
      process.exit(1);
    }

  } catch (error) {
    console.error("Price capture failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
