/**
 * One-off backfill of Blend V2.1 history from BigQuery (crypto_stellar public dataset).
 *
 * Covers the Fixed v2.1 pool, the V2.1 backstop and the Comet V1.1 LP token from
 * the Comet V1.1 deployment (~2026-09-16, ledger 64,580,449) up to today:
 *   1. parsed_events            (V2.1 pool only)
 *   2. backstop_events          (V2.1 backstop)
 *   3. pool_snapshots           (V2.1 pool, through yesterday)
 *   4. backstop_pool_snapshots  (V2.1 backstop, through yesterday)
 *   5. daily_token_prices       (Comet V1.1 LP, through yesterday)
 *
 * Cost guards:
 *   - Every query is dry-run first; the run aborts before spending anything if a
 *     single query exceeds MAX_GB_PER_QUERY or the total exceeds MAX_GB_TOTAL.
 *   - Every non-dry-run BigQuery job is submitted with maximumBytesBilled, so
 *     BigQuery itself refuses (and does not bill) any job above the cap.
 *   - Bytes actually billed are read back from the BigQuery job list at the end.
 *
 * Usage:
 *   npx ts-node src/scripts/backfill-v2-1.ts            # dry-run estimates only
 *   npx ts-node src/scripts/backfill-v2-1.ts --run      # estimates, then backfill
 *   npx ts-node src/scripts/backfill-v2-1.ts --run --only parsed_events,lp_prices
 *   npx ts-node src/scripts/backfill-v2-1.ts --run --only parsed_events,backstop_events --from 2026-11-06
 */

import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { BigQuery } from "@google-cloud/bigquery";

const GB = 1024 ** 3;
const MAX_GB_PER_QUERY = 55; // contract_data scans 3 monthly partitions (~51 GB upper bound)
const MAX_GB_TOTAL = 165; // worst case ≈ $1.00 at on-demand pricing
const USD_PER_TB = 6.25; // BigQuery on-demand list price

// Inject a hard byte cap on every real (non-dry-run) job, before services load.
const MAX_BYTES_BILLED = String(MAX_GB_PER_QUERY * GB);
function withCap(opts: any): any {
  const o = typeof opts === "string" ? { query: opts } : { ...opts };
  if (!o.dryRun) o.maximumBytesBilled = MAX_BYTES_BILLED;
  return o;
}
const proto = BigQuery.prototype as any;
const origCreateQueryJob = proto.createQueryJob;
const origQuery = proto.query;
proto.createQueryJob = function (opts: any, ...rest: any[]) {
  return origCreateQueryJob.call(this, withCap(opts), ...rest);
};
proto.query = function (opts: any, ...rest: any[]) {
  return origQuery.call(this, withCap(opts), ...rest);
};

/* eslint-disable import/first */
import { pool as dbPool, closePool } from "../config/database";
import { bigQueryActionsBackfillService } from "../services/bigquery-actions-backfill";
import { bigQueryBackstopBackfillService } from "../services/bigquery-backstop-backfill";
import { bigQueryPoolBackfillService } from "../services/bigquery-pool-backfill";
import { bigQueryClient } from "../services/bigquery-client";
import { backstopQ4wBackfillService } from "../services/backstop-q4w-backfill";
import { LpPriceBackfillService } from "../services/lp-price-backfill";
import { BACKSTOP_V2_1, LP_TOKEN_V1_1 } from "../lib/blend/backstops";

const POOL_V2_1 = "CBAKAZUEJBAFA2DCGBRS2WKJT3FNIMJBHTFL76AY7XMAVEINQNNIQWAO";
const DEFAULT_START_DATE = "2026-09-16";

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

async function main() {
  const run = process.argv.includes("--run");
  // `--from YYYY-MM-DD` narrows a top-up rerun (default: V2.1 deployment window)
  const fromIdx = process.argv.indexOf("--from");
  const START_DATE = fromIdx !== -1 ? process.argv[fromIdx + 1] : DEFAULT_START_DATE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(START_DATE ?? "")) throw new Error(`Invalid --from date: ${START_DATE}`);
  const startedAt = new Date();
  const today = isoDate(startedAt);
  const yesterday = isoDate(new Date(startedAt.getTime() - 86_400_000));
  const lp = new LpPriceBackfillService(dbPool, LP_TOKEN_V1_1);

  // Date semantics differ per service: actions/backstop/pool snapshots use an
  // inclusive DATE(closed_at) <= endDate; q4w and LP use closed_at < endDate.
  const actionsParams = { poolIds: [POOL_V2_1], startDate: START_DATE, endDate: today, skipConfirmation: true };
  const backstopParams = { backstopContract: BACKSTOP_V2_1, startDate: START_DATE, endDate: today, skipConfirmation: true };
  const poolSnapParams = { poolId: POOL_V2_1, startDate: START_DATE, endDate: yesterday, skipConfirmation: true };
  const q4wParams = { backstopContract: BACKSTOP_V2_1, poolAddress: POOL_V2_1, startDate: START_DATE, endDate: today, skipConfirmation: true };
  const lpParams = { startDate: START_DATE, endDate: today };

  console.log(`\nV2.1 backfill ${START_DATE} → ${today} (snapshots/prices through ${yesterday})`);
  console.log(`Caps: ${MAX_GB_PER_QUERY} GB per job (enforced by BigQuery), ${MAX_GB_TOTAL} GB total\n`);

  // Steps: estimate + run. `--only a,b` limits to the named steps (e.g. a rerun).
  const steps: Array<{ name: string; estimate: () => Promise<number>; run: () => Promise<unknown> }> = [
    { name: "parsed_events",
      estimate: async () => (await bigQueryActionsBackfillService.getCostEstimate(actionsParams)).bytes,
      run: () => bigQueryActionsBackfillService.runBackfill(actionsParams) },
    { name: "backstop_events",
      estimate: async () => (await bigQueryBackstopBackfillService.getCostEstimate(backstopParams)).bytes,
      run: () => bigQueryBackstopBackfillService.runBackfill(backstopParams) },
    { name: "pool_snapshots",
      estimate: async () => (await bigQueryClient.getPoolSnapshotsCostEstimate(poolSnapParams)).bytes,
      run: () => bigQueryPoolBackfillService.runBackfillSingle(poolSnapParams) },
    { name: "backstop_pool_snapshots",
      estimate: async () => (await backstopQ4wBackfillService.getCostEstimate(q4wParams)).bytes,
      run: () => backstopQ4wBackfillService.runBackfill(q4wParams) },
    { name: "lp_prices",
      estimate: async () => (await lp.getCostEstimate(lpParams)).bytes,
      run: () => lp.runFromBigQuery(lpParams) },
  ];
  const onlyIdx = process.argv.indexOf("--only");
  const only = onlyIdx !== -1 ? (process.argv[onlyIdx + 1] ?? "").split(",").filter(Boolean) : null;
  if (only) {
    const unknown = only.filter((n) => !steps.some((st) => st.name === n));
    if (unknown.length > 0) throw new Error(`Unknown step(s): ${unknown.join(", ")}`);
  }
  const selected = only ? steps.filter((st) => only.includes(st.name)) : steps;

  // --- Dry-run estimates ---
  const estimates: Array<[string, number]> = [];
  for (const st of selected) estimates.push([st.name, await st.estimate()]);

  let totalBytes = 0;
  console.log("\nESTIMATES");
  for (const [label, bytes] of estimates) {
    totalBytes += bytes;
    console.log(`  ${label.padEnd(26)} ${(bytes / GB).toFixed(2).padStart(7)} GB  $${((bytes / 1024 ** 4) * USD_PER_TB).toFixed(4)}`);
  }
  console.log(`  ${"TOTAL".padEnd(26)} ${(totalBytes / GB).toFixed(2).padStart(7)} GB  $${((totalBytes / 1024 ** 4) * USD_PER_TB).toFixed(4)}`);
  console.log("  (pool_snapshots also runs a small reserve-index lookup query, capped like all jobs)");

  const tooBig = estimates.filter(([, b]) => b > MAX_GB_PER_QUERY * GB);
  if (tooBig.length > 0 || totalBytes > MAX_GB_TOTAL * GB) {
    console.error("\nABORT: estimate exceeds the configured caps; nothing was run.");
    process.exitCode = 1;
    return;
  }
  if (!run) {
    console.log("\nEstimates only. Re-run with --run to execute.");
    return;
  }

  // --- Execute ---
  const results: Record<string, unknown> = {};
  for (const st of selected) results[st.name] = await st.run();

  console.log("\nRESULTS");
  for (const [k, v] of Object.entries(results)) {
    const { query, ...rest } = (v ?? {}) as Record<string, unknown>;
    console.log(`  ${k}: ${JSON.stringify(rest)}`);
  }

  // --- Bytes actually billed (from BigQuery's own job list) ---
  const bq = new BigQuery({
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  });
  const [jobs] = await bq.getJobs({ minCreationTime: String(startedAt.getTime() - 60_000), allUsers: false } as any);
  let billed = 0;
  let count = 0;
  for (const job of jobs) {
    const stats = (job.metadata as any)?.statistics?.query;
    if (stats && stats.totalBytesBilled) {
      billed += Number(stats.totalBytesBilled);
      count++;
    }
  }
  console.log(`\nBILLED: ${count} jobs, ${(billed / GB).toFixed(2)} GB ≈ $${((billed / 1024 ** 4) * USD_PER_TB).toFixed(4)}`);
}

main()
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  });
