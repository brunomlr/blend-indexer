/**
 * Capture Daily Backstop Pool Snapshots
 *
 * Captures current backstop pool balance data (shares, tokens, q4w) from SDK
 * and stores in backstop_pool_snapshots table.
 *
 * Run:
 *   npx ts-node src/scripts/capture-backstop-snapshots.ts
 *
 * For daily automation, schedule via GitHub Actions or cron.
 */

import dotenv from "dotenv";
import path from "path";
import { Pool } from "pg";
import { BackstopPoolV2, Version } from "@blend-capital/blend-sdk";
import { rpc } from "@stellar/stellar-sdk";
import { getBlendNetwork } from "../lib/blend/network";
import { TRACKED_POOLS } from "../lib/blend/pools";
import { BackstopPoolSnapshotRow } from "../types";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const BACKSTOP_ID = "CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("neon") ? { rejectUnauthorized: false } : undefined,
});

interface CaptureResult {
  date: string;
  captured: string[];
  errors: string[];
  snapshotsInserted: number;
}

async function captureBackstopSnapshots(): Promise<CaptureResult> {
  const network = getBlendNetwork();
  const today = new Date().toISOString().split("T")[0];
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const captured: string[] = [];
  const errors: string[] = [];
  let snapshotsInserted = 0;

  console.log(`\n[backstop-snapshot] Starting capture for ${today}`);
  console.log(`[backstop-snapshot] Network: ${network.passphrase}`);
  console.log(`[backstop-snapshot] Backstop: ${BACKSTOP_ID}`);

  // Get current ledger sequence from RPC
  const rpcServer = new rpc.Server(network.rpc);
  const latestLedger = await rpcServer.getLatestLedger();
  const ledgerSequence = latestLedger.sequence;
  console.log(`[backstop-snapshot] Current ledger: ${ledgerSequence}\n`);

  const snapshots: BackstopPoolSnapshotRow[] = [];

  // Process each V2 pool
  for (const trackedPool of TRACKED_POOLS) {
    if (trackedPool.version !== Version.V2) continue;

    try {
      console.log(`[backstop-snapshot] Loading ${trackedPool.name}...`);

      // Load backstop pool data
      const backstopPool = await BackstopPoolV2.load(network, BACKSTOP_ID, trackedPool.id);
      const { shares, tokens, q4w } = backstopPool.poolBalance;

      // Calculate Q4W percentage: (q4w / shares) * 100
      const sharesNum = Number(shares);
      const q4wNum = Number(q4w);
      const q4wPct = sharesNum > 0 ? (q4wNum / sharesNum) * 100 : 0;

      const snapshot: BackstopPoolSnapshotRow = {
        pool_address: trackedPool.id,
        snapshot_date: today,
        snapshot_timestamp: now,
        ledger_sequence: ledgerSequence,
        shares: shares.toString(),
        tokens: tokens.toString(),
        q4w: q4w.toString(),
        q4w_pct: Math.round(q4wPct * 10000) / 10000, // 4 decimal places
        src: "sdk",
      };

      snapshots.push(snapshot);

      const msg = `${trackedPool.name}: Q4W=${q4wPct.toFixed(4)}% (shares=${sharesNum.toLocaleString()}, q4w=${q4wNum.toLocaleString()})`;
      captured.push(msg);
      console.log(`[backstop-snapshot] ${msg}`);

    } catch (error: any) {
      const msg = `${trackedPool.name}: ${error.message}`;
      errors.push(msg);
      console.error(`[backstop-snapshot] ERROR ${msg}`);
    }
  }

  // Insert snapshots into database
  if (snapshots.length > 0) {
    console.log(`\n[backstop-snapshot] Inserting ${snapshots.length} snapshots...`);

    for (const snapshot of snapshots) {
      try {
        await pool.query(`
          INSERT INTO backstop_pool_snapshots (
            pool_address, snapshot_date, snapshot_timestamp,
            ledger_sequence, shares, tokens, q4w, q4w_pct, src
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (pool_address, snapshot_date)
          DO UPDATE SET
            snapshot_timestamp = EXCLUDED.snapshot_timestamp,
            ledger_sequence = EXCLUDED.ledger_sequence,
            shares = EXCLUDED.shares,
            tokens = EXCLUDED.tokens,
            q4w = EXCLUDED.q4w,
            q4w_pct = EXCLUDED.q4w_pct,
            src = EXCLUDED.src
        `, [
          snapshot.pool_address,
          snapshot.snapshot_date,
          snapshot.snapshot_timestamp,
          snapshot.ledger_sequence,
          snapshot.shares,
          snapshot.tokens,
          snapshot.q4w,
          snapshot.q4w_pct,
          snapshot.src,
        ]);

        snapshotsInserted++;
      } catch (error: any) {
        errors.push(`Insert ${snapshot.pool_address.slice(0, 8)}...: ${error.message}`);
        console.error(`[backstop-snapshot] ERROR inserting: ${error.message}`);
      }
    }

    console.log(`[backstop-snapshot] Inserted/updated ${snapshotsInserted} snapshots`);
  }

  console.log(`[backstop-snapshot] Completed: ${snapshotsInserted} snapshots, ${errors.length} errors`);

  return {
    date: today,
    captured,
    errors,
    snapshotsInserted,
  };
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Daily Backstop Pool Snapshot Capture");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Timestamp: ${new Date().toISOString()}`);

  try {
    // Test connection
    await pool.query("SELECT 1");
    console.log("  Database connected\n");

    const result = await captureBackstopSnapshots();

    // Summary
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("  Summary");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  Date:              ${result.date}`);
    console.log(`  Snapshots saved:   ${result.snapshotsInserted}`);
    console.log(`  Errors:            ${result.errors.length}`);

    if (result.captured.length > 0) {
      console.log("\n  Captured:");
      result.captured.forEach(p => console.log(`    - ${p}`));
    }

    if (result.errors.length > 0) {
      console.log("\n  Errors:");
      result.errors.forEach(e => console.log(`    - ${e}`));
    }

    console.log("═══════════════════════════════════════════════════════════\n");

    // Exit with error code if there were failures
    if (result.errors.length > 0 && result.snapshotsInserted === 0) {
      process.exit(1);
    }

  } catch (error) {
    console.error("Backstop snapshot capture failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
