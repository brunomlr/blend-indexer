/**
 * Backfill historical BLND emission APY
 *
 * This script calculates and stores daily BLND emission APY for:
 * 1. Backstop depositors - using backstop_events running totals
 * 2. Lending pool suppliers - using pool_snapshots (from BigQuery) for accurate b_supply
 * 3. Lending pool borrowers - using pool_snapshots (from BigQuery) for accurate d_supply
 *
 * Formula: emission_apy = (eps * 31536000 / total_supply) * blnd_price / asset_price * 100
 *
 * Usage:
 *   npx ts-node src/scripts/backfill-emission-apy.ts              # Backfill all historical
 *   npx ts-node src/scripts/backfill-emission-apy.ts --backstop   # Backstop only (historical)
 *   npx ts-node src/scripts/backfill-emission-apy.ts --lending    # Lending only (historical)
 *   npx ts-node src/scripts/backfill-emission-apy.ts --today      # Capture today's APY using SDK (for daily cron)
 *   npx ts-node src/scripts/backfill-emission-apy.ts --yes        # Skip confirmation prompts
 */

import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { pool as dbPool, closePool } from "../config/database";
import {
  BackstopPoolV2,
  PoolMetadata,
  PoolV2,
  Version,
  type Pool,
  type Reserve,
} from "@blend-capital/blend-sdk";
import { rpc } from "@stellar/stellar-sdk";
import { TRACKED_POOLS } from "../lib/blend/pools";
import { getBlendNetwork } from "../lib/blend/network";
import { PoolSnapshotRow } from "../types";
import { bigQueryClient } from "../services/bigquery-client";
import { poolRepository } from "../repositories/pool-repository";
import { confirm } from "../utils/prompt";
import { discoverAllPoolAssets } from "../lib/blend/discovery";

const BLND_TOKEN = "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY";
const LP_TOKEN = "CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM";
const BACKSTOP_ID = "CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7";
const SECONDS_PER_YEAR = 31_536_000;
const EPS_DECIMALS = 14;
const V2_LAUNCH_DATE = "2025-04-14";

/**
 * Check and backfill pool_snapshots from BigQuery
 *
 * Shows current state and offers to backfill missing data with cost estimation
 */
async function checkAndBackfillPoolSnapshots(skipConfirmation: boolean): Promise<boolean> {
  console.log("\n========================================");
  console.log("POOL SNAPSHOTS (BigQuery)");
  console.log("========================================\n");

  // Check current state
  const stats = await dbPool.query(`
    SELECT
      COUNT(*) as total_rows,
      MIN(snapshot_date)::text as earliest,
      MAX(snapshot_date)::text as latest,
      COUNT(DISTINCT pool_id) as pools,
      COUNT(DISTINCT asset_address) as assets
    FROM pool_snapshots
  `);

  const { total_rows, earliest, latest, pools, assets } = stats.rows[0];
  const rowCount = parseInt(total_rows);

  console.log("Current pool_snapshots state:");
  console.log(`  Total rows: ${rowCount.toLocaleString()}`);

  if (rowCount > 0) {
    console.log(`  Date range: ${earliest} to ${latest}`);
    console.log(`  Pools: ${pools}`);
    console.log(`  Assets: ${assets}`);

    // Check if data is complete (covers V2 launch to today)
    const today = new Date().toISOString().split("T")[0];
    const expectedDays = Math.ceil((new Date(today).getTime() - new Date(V2_LAUNCH_DATE).getTime()) / (1000 * 60 * 60 * 24));
    const actualDays = Math.ceil((new Date(latest).getTime() - new Date(earliest).getTime()) / (1000 * 60 * 60 * 24)) + 1;

    console.log(`  Expected days since V2 launch: ~${expectedDays}`);
    console.log(`  Days covered: ${actualDays}`);

    if (earliest <= V2_LAUNCH_DATE && latest >= today) {
      console.log("\n✓ Pool snapshots data looks complete");
      return true;
    } else {
      console.log("\n⚠️  Pool snapshots may be incomplete");
    }
  } else {
    console.log("  (empty - needs backfill from BigQuery)");
  }

  // Discover pools
  console.log("\nDiscovering tracked pools...");
  const discovery = await discoverAllPoolAssets();
  const poolIds = discovery.pools.map(p => p.poolId);
  console.log(`Found ${poolIds.length} pools to backfill`);

  // Get cost estimate from BigQuery
  console.log("\nEstimating BigQuery cost...");
  try {
    const estimate = await bigQueryClient.getAllPoolsSnapshotsCostEstimate({
      poolIds,
      startDate: V2_LAUNCH_DATE,
    });

    console.log(`\n📊 BigQuery Cost Estimate:`);
    console.log(`   Data to scan: ${estimate.gb} GB`);
    console.log(`   Estimated cost: $${estimate.cost}`);
    console.log(`   (First 1TB per month is free)`);

    const costNumber = parseFloat(estimate.cost);
    const gbNumber = parseFloat(estimate.gb);

    if (gbNumber > 100) {
      console.log(`\n⚠️  WARNING: This query will scan ${estimate.gb} GB of data`);
    }
    if (costNumber > 1) {
      console.log(`⚠️  WARNING: Estimated cost is $${estimate.cost}`);
    }

    // Confirm before proceeding
    if (!skipConfirmation) {
      const proceed = await confirm("\nDo you want to backfill pool_snapshots from BigQuery?");
      if (!proceed) {
        console.log("Skipping pool_snapshots backfill");
        return rowCount > 0; // Return true if we have some data
      }
    } else {
      console.log("\nAuto-proceeding (--yes flag)");
    }

    // Execute backfill
    console.log("\nFetching pool snapshots from BigQuery...");
    const rows = await bigQueryClient.fetchAllPoolsSnapshots<any>({
      poolIds,
      startDate: V2_LAUNCH_DATE,
    });

    if (rows.length === 0) {
      console.log("⚠️  No data returned from BigQuery");
      return false;
    }

    console.log(`✓ Fetched ${rows.length.toLocaleString()} rows from BigQuery`);

    // Transform and insert
    console.log("\nInserting into database...");
    const validRows = rows.map((row: any) => ({
      pool_id: row.pool_id,
      asset_address: row.asset_address,
      snapshot_date: typeof row.snapshot_date === 'string'
        ? row.snapshot_date.split('T')[0]
        : row.snapshot_date?.value?.split('T')[0] || row.snapshot_date,
      snapshot_timestamp: row.snapshot_timestamp?.value || row.snapshot_timestamp,
      ledger_sequence: parseInt(row.ledger_sequence),
      b_rate: parseFloat(row.b_rate),
      d_rate: parseFloat(row.d_rate),
      b_supply: parseFloat(row.b_supply) || 0,
      d_supply: parseFloat(row.d_supply) || 0,
      last_time: row.last_time ? parseInt(row.last_time) : undefined,
    })).filter((row: any) => row.pool_id && row.asset_address && row.snapshot_date);

    const result = await poolRepository.insertBatch(validRows);
    console.log(`✓ Inserted ${result.inserted} rows, updated ${result.updated} rows`);

    // Show updated stats
    const newStats = await poolRepository.getStats();
    console.log(`\n📊 Pool Snapshots Summary:`);
    console.log(`   Total rows: ${newStats.total_rows.toLocaleString()}`);
    console.log(`   Latest date: ${newStats.latest_date}`);
    console.log(`   Unique assets: ${newStats.unique_assets}`);

    return true;

  } catch (error) {
    console.error("Error with BigQuery:", error);
    console.log("\n⚠️  Could not complete BigQuery backfill");
    return rowCount > 0;
  }
}

/**
 * Backfill backstop emission APY
 *
 * For each day since V2 launch:
 * 1. Calculate running total of tokens per pool from backstop_events
 * 2. Get EPS from emission_configs
 * 3. Get BLND and LP prices from daily_token_prices
 * 4. Calculate and store emission APY
 */
async function backfillBackstopEmissionApy(): Promise<void> {
  console.log("\n========================================");
  console.log("BACKFILLING BACKSTOP EMISSION APY");
  console.log("========================================\n");

  // This query:
  // 1. Generates a date series from V2 launch to today
  // 2. For each pool, calculates cumulative tokens from backstop_events
  // 3. Joins with emission_configs for EPS
  // 4. Joins with daily_token_prices for BLND and LP prices
  // 5. Calculates emission APY
  const result = await dbPool.query(`
    WITH date_series AS (
      SELECT generate_series(
        '2025-04-14'::date,
        CURRENT_DATE,
        '1 day'::interval
      )::date AS rate_date
    ),
    -- Get all pools with backstop emissions
    backstop_pools AS (
      SELECT DISTINCT pool_address, eps, eps_decimals
      FROM emission_configs
      WHERE config_type = 'backstop'
    ),
    -- Calculate daily token delta per pool
    daily_backstop_delta AS (
      SELECT
        DATE(ledger_closed_at) AS event_date,
        pool_address,
        SUM(
          CASE
            WHEN action_type = 'deposit' THEN COALESCE(lp_tokens, 0)
            WHEN action_type = 'withdraw' THEN -COALESCE(lp_tokens, 0)
            WHEN action_type IN ('donate', 'gulp_emissions') THEN COALESCE(lp_tokens, 0)
            WHEN action_type = 'draw' THEN -COALESCE(lp_tokens, 0)
            ELSE 0
          END
        ) AS daily_token_delta
      FROM backstop_events
      WHERE pool_address IS NOT NULL
      GROUP BY DATE(ledger_closed_at), pool_address
    ),
    -- Calculate cumulative tokens using window function on the delta table
    cumulative_by_event_date AS (
      SELECT
        event_date,
        pool_address,
        SUM(daily_token_delta) OVER (
          PARTITION BY pool_address
          ORDER BY event_date
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS cumulative_tokens
      FROM daily_backstop_delta
    ),
    -- Expand to all dates (forward fill)
    daily_totals AS (
      SELECT
        d.rate_date,
        p.pool_address,
        p.eps,
        p.eps_decimals,
        -- Get the most recent cumulative value on or before this date
        (
          SELECT cumulative_tokens
          FROM cumulative_by_event_date c
          WHERE c.pool_address = p.pool_address
            AND c.event_date <= d.rate_date
          ORDER BY c.event_date DESC
          LIMIT 1
        ) AS total_tokens
      FROM date_series d
      CROSS JOIN backstop_pools p
    ),
    -- Join with prices
    with_prices AS (
      SELECT
        dt.rate_date,
        dt.pool_address,
        dt.eps,
        dt.eps_decimals,
        dt.total_tokens,
        blnd.usd_price AS blnd_price,
        lp.usd_price AS lp_price
      FROM daily_totals dt
      LEFT JOIN daily_token_prices blnd
        ON blnd.price_date = dt.rate_date
        AND blnd.token_address = $1
      LEFT JOIN daily_token_prices lp
        ON lp.price_date = dt.rate_date
        AND lp.token_address = $2
      WHERE dt.total_tokens > 0
    )
    -- Calculate and insert
    INSERT INTO daily_emission_apy (
      rate_date, apy_type, pool_address, asset_address,
      eps, eps_decimals, total_supply,
      blnd_price_usd, asset_price_usd,
      emissions_per_year_per_token, emission_apy, source
    )
    SELECT
      rate_date,
      'backstop' AS apy_type,
      pool_address,
      NULL AS asset_address,
      eps,
      eps_decimals,
      total_tokens AS total_supply,
      blnd_price AS blnd_price_usd,
      lp_price AS asset_price_usd,
      -- emissions_per_year_per_token = (eps / 10^decimals) * 31536000 / (total_tokens / 10^7)
      CASE WHEN total_tokens > 0 THEN
        (eps::numeric / POWER(10, eps_decimals)) * $3 / (total_tokens::numeric / 1e7)
      ELSE 0 END AS emissions_per_year_per_token,
      -- emission_apy = emissions_per_year_per_token * blnd_price / lp_price * 100
      -- Note: For backstop, we express APY as % of LP token value
      CASE WHEN total_tokens > 0 AND lp_price > 0 THEN
        ((eps::numeric / POWER(10, eps_decimals)) * $3 / (total_tokens::numeric / 1e7))
        * blnd_price / lp_price * 100
      ELSE NULL END AS emission_apy,
      'backstop_events' AS source
    FROM with_prices
    ON CONFLICT ON CONSTRAINT daily_emission_apy_unique
    DO UPDATE SET
      eps = EXCLUDED.eps,
      eps_decimals = EXCLUDED.eps_decimals,
      total_supply = EXCLUDED.total_supply,
      blnd_price_usd = EXCLUDED.blnd_price_usd,
      asset_price_usd = EXCLUDED.asset_price_usd,
      emissions_per_year_per_token = EXCLUDED.emissions_per_year_per_token,
      emission_apy = EXCLUDED.emission_apy,
      source = EXCLUDED.source
    RETURNING id
  `, [BLND_TOKEN, LP_TOKEN, SECONDS_PER_YEAR]);

  console.log(`Backstop emission APY: ${result.rowCount} rows inserted/updated`);
}

/**
 * Backfill lending emission APY
 *
 * Uses pool_snapshots from BigQuery for accurate b_supply and d_supply values
 * Much simpler and more accurate than deriving from parsed_events
 */
async function backfillLendingEmissionApy(): Promise<void> {
  console.log("\n========================================");
  console.log("BACKFILLING LENDING EMISSION APY");
  console.log("========================================\n");

  // Check if pool_snapshots has data
  const check = await dbPool.query("SELECT COUNT(*) FROM pool_snapshots WHERE b_supply > 0 OR d_supply > 0");
  if (parseInt(check.rows[0].count) === 0) {
    console.log("pool_snapshots is empty - run with BigQuery backfill first");
    return;
  }
  console.log(`Found ${check.rows[0].count} pool snapshots with supply data`);

  // Backfill supply emissions using pool_snapshots.b_supply
  console.log("\nCalculating supply BLND emission APY from pool_snapshots...");
  const supplyResult = await dbPool.query(`
    INSERT INTO daily_emission_apy (
      rate_date, apy_type, pool_address, asset_address,
      eps, eps_decimals, total_supply,
      blnd_price_usd, asset_price_usd,
      emissions_per_year_per_token, emission_apy, source
    )
    SELECT
      ps.snapshot_date AS rate_date,
      'lending_supply' AS apy_type,
      ps.pool_id AS pool_address,
      ps.asset_address,
      c.eps,
      c.eps_decimals,
      ps.b_supply AS total_supply,
      blnd.usd_price AS blnd_price_usd,
      asset.usd_price AS asset_price_usd,
      -- emissions_per_year_per_token = (eps / 10^decimals) * 31536000 / b_supply
      CASE WHEN ps.b_supply > 0 THEN
        (c.eps::numeric / POWER(10, c.eps_decimals)) * $2 / ps.b_supply::numeric
      ELSE 0 END AS emissions_per_year_per_token,
      -- emission_apy = emissions_per_year_per_token * blnd_price / asset_price * 100
      CASE WHEN ps.b_supply > 0 AND asset.usd_price > 0 THEN
        ((c.eps::numeric / POWER(10, c.eps_decimals)) * $2 / ps.b_supply::numeric)
        * blnd.usd_price / asset.usd_price * 100
      ELSE NULL END AS emission_apy,
      'bigquery' AS source
    FROM pool_snapshots ps
    JOIN emission_configs c
      ON c.pool_address = ps.pool_id
      AND c.asset_address = ps.asset_address
      AND c.config_type = 'lending_supply'
      AND (c.expiration IS NULL OR ps.snapshot_date < TO_TIMESTAMP(c.expiration))
    LEFT JOIN daily_token_prices blnd
      ON blnd.price_date = ps.snapshot_date
      AND blnd.token_address = $1
    LEFT JOIN daily_token_prices asset
      ON asset.price_date = ps.snapshot_date
      AND asset.token_address = ps.asset_address
    WHERE ps.b_supply > 0
      AND ps.snapshot_date >= $3
    ON CONFLICT ON CONSTRAINT daily_emission_apy_unique
    DO UPDATE SET
      eps = EXCLUDED.eps,
      eps_decimals = EXCLUDED.eps_decimals,
      total_supply = EXCLUDED.total_supply,
      blnd_price_usd = EXCLUDED.blnd_price_usd,
      asset_price_usd = EXCLUDED.asset_price_usd,
      emissions_per_year_per_token = EXCLUDED.emissions_per_year_per_token,
      emission_apy = EXCLUDED.emission_apy,
      source = EXCLUDED.source
    RETURNING id
  `, [BLND_TOKEN, SECONDS_PER_YEAR, V2_LAUNCH_DATE]);

  console.log(`Lending supply BLND emission APY: ${supplyResult.rowCount} rows inserted/updated`);

  // Backfill borrow emissions using pool_snapshots.d_supply
  console.log("\nCalculating borrow BLND emission APY from pool_snapshots...");
  const borrowResult = await dbPool.query(`
    INSERT INTO daily_emission_apy (
      rate_date, apy_type, pool_address, asset_address,
      eps, eps_decimals, total_supply,
      blnd_price_usd, asset_price_usd,
      emissions_per_year_per_token, emission_apy, source
    )
    SELECT
      ps.snapshot_date AS rate_date,
      'lending_borrow' AS apy_type,
      ps.pool_id AS pool_address,
      ps.asset_address,
      c.eps,
      c.eps_decimals,
      ps.d_supply AS total_supply,
      blnd.usd_price AS blnd_price_usd,
      asset.usd_price AS asset_price_usd,
      -- emissions_per_year_per_token = (eps / 10^decimals) * 31536000 / d_supply
      CASE WHEN ps.d_supply > 0 THEN
        (c.eps::numeric / POWER(10, c.eps_decimals)) * $2 / ps.d_supply::numeric
      ELSE 0 END AS emissions_per_year_per_token,
      -- emission_apy = emissions_per_year_per_token * blnd_price / asset_price * 100
      CASE WHEN ps.d_supply > 0 AND asset.usd_price > 0 THEN
        ((c.eps::numeric / POWER(10, c.eps_decimals)) * $2 / ps.d_supply::numeric)
        * blnd.usd_price / asset.usd_price * 100
      ELSE NULL END AS emission_apy,
      'bigquery' AS source
    FROM pool_snapshots ps
    JOIN emission_configs c
      ON c.pool_address = ps.pool_id
      AND c.asset_address = ps.asset_address
      AND c.config_type = 'lending_borrow'
      AND (c.expiration IS NULL OR ps.snapshot_date < TO_TIMESTAMP(c.expiration))
    LEFT JOIN daily_token_prices blnd
      ON blnd.price_date = ps.snapshot_date
      AND blnd.token_address = $1
    LEFT JOIN daily_token_prices asset
      ON asset.price_date = ps.snapshot_date
      AND asset.token_address = ps.asset_address
    WHERE ps.d_supply > 0
      AND ps.snapshot_date >= $3
    ON CONFLICT ON CONSTRAINT daily_emission_apy_unique
    DO UPDATE SET
      eps = EXCLUDED.eps,
      eps_decimals = EXCLUDED.eps_decimals,
      total_supply = EXCLUDED.total_supply,
      blnd_price_usd = EXCLUDED.blnd_price_usd,
      asset_price_usd = EXCLUDED.asset_price_usd,
      emissions_per_year_per_token = EXCLUDED.emissions_per_year_per_token,
      emission_apy = EXCLUDED.emission_apy,
      source = EXCLUDED.source
    RETURNING id
  `, [BLND_TOKEN, SECONDS_PER_YEAR, V2_LAUNCH_DATE]);

  console.log(`Lending borrow BLND emission APY: ${borrowResult.rowCount} rows inserted/updated`);
}

/**
 * Capture today's BLND emission APY using Blend SDK
 *
 * This is more efficient for daily cron - queries current state directly
 * instead of recalculating from historical events.
 * Also captures pool_snapshots for each reserve.
 */
async function captureTodayEmissionApy(): Promise<void> {
  console.log("\n========================================");
  console.log("CAPTURING TODAY'S BLND EMISSION APY & POOL SNAPSHOTS");
  console.log("========================================\n");

  const network = getBlendNetwork();
  const today = new Date().toISOString().split("T")[0];
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`Date: ${today}`);
  console.log(`Network: ${network.passphrase}\n`);

  // Get current ledger sequence from RPC
  const rpcServer = new rpc.Server(network.rpc);
  const latestLedger = await rpcServer.getLatestLedger();
  const ledgerSequence = latestLedger.sequence;
  console.log(`Current ledger: ${ledgerSequence}\n`);

  // Get today's prices
  const pricesResult = await dbPool.query(`
    SELECT token_address, usd_price
    FROM daily_token_prices
    WHERE price_date = $1
  `, [today]);

  const prices = new Map<string, number>();
  for (const row of pricesResult.rows) {
    prices.set(row.token_address, parseFloat(row.usd_price));
  }

  const blndPrice = prices.get(BLND_TOKEN);
  const lpPrice = prices.get(LP_TOKEN);

  if (!blndPrice) {
    console.log("Warning: BLND price not found for today. Run capture-daily-prices.ts first.");
  }
  if (!lpPrice) {
    console.log("Warning: LP token price not found for today.");
  }

  let totalInserted = 0;
  let snapshotsInserted = 0;
  const poolSnapshots: PoolSnapshotRow[] = [];

  // Process each V2 pool
  for (const trackedPool of TRACKED_POOLS) {
    if (trackedPool.version !== Version.V2) continue;

    console.log(`\n=== ${trackedPool.name} ===`);

    try {
      // Load pool data
      const metadata = await PoolMetadata.load(network, trackedPool.id);
      const pool: Pool = await PoolV2.loadWithMetadata(network, trackedPool.id, metadata);

      // Load backstop data
      const backstopPool = await BackstopPoolV2.load(network, BACKSTOP_ID, trackedPool.id);

      // --- BACKSTOP EMISSION APY ---
      const backstopEmissions = backstopPool.emissions;
      if (backstopEmissions && backstopEmissions.eps > 0n) {
        const { tokens } = backstopPool.poolBalance;
        const eps = backstopEmissions.eps;
        const epsDecimals = backstopEmissions.epsDecimals;

        // Calculate APY
        const epsFloat = Number(eps) / Math.pow(10, epsDecimals);
        const tokensFloat = Number(tokens) / 1e7; // LP tokens have 7 decimals
        const emissionsPerYearPerToken = tokensFloat > 0 ? (epsFloat * SECONDS_PER_YEAR) / tokensFloat : 0;
        const emissionApy = emissionsPerYearPerToken && blndPrice && lpPrice
          ? emissionsPerYearPerToken * blndPrice / lpPrice * 100
          : null;

        // Insert/update
        await dbPool.query(`
          INSERT INTO daily_emission_apy (
            rate_date, apy_type, pool_address, asset_address,
            eps, eps_decimals, total_supply,
            blnd_price_usd, asset_price_usd,
            emissions_per_year_per_token, emission_apy, source
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT ON CONSTRAINT daily_emission_apy_unique
          DO UPDATE SET
            eps = EXCLUDED.eps,
            eps_decimals = EXCLUDED.eps_decimals,
            total_supply = EXCLUDED.total_supply,
            blnd_price_usd = EXCLUDED.blnd_price_usd,
            asset_price_usd = EXCLUDED.asset_price_usd,
            emissions_per_year_per_token = EXCLUDED.emissions_per_year_per_token,
            emission_apy = EXCLUDED.emission_apy,
            source = EXCLUDED.source
        `, [
          today,
          'backstop',
          trackedPool.id,
          null,
          eps.toString(),
          epsDecimals,
          tokens.toString(),
          blndPrice || null,
          lpPrice || null,
          emissionsPerYearPerToken,
          emissionApy,
          'sdk',
        ]);

        console.log(`  Backstop: ${emissionApy ? emissionApy.toFixed(2) + '%' : 'N/A'} (${tokensFloat.toLocaleString()} LP tokens)`);
        totalInserted++;
      }

      // --- LENDING EMISSION APY (supply & borrow) ---
      const reserves = Array.from(pool.reserves.values()) as Reserve[];

      for (const reserve of reserves) {
        const assetAddress = reserve.assetId;
        const assetPrice = prices.get(assetAddress);

        // Supply emissions
        const supplyEmissions = reserve.supplyEmissions;
        if (supplyEmissions && supplyEmissions.eps > 0n) {
          const bSupply = reserve.totalSupply(); // returns bigint
          const eps = supplyEmissions.eps;

          const epsFloat = Number(eps) / Math.pow(10, EPS_DECIMALS);
          const supplyFloat = Number(bSupply) / Math.pow(10, reserve.config.decimals);
          const emissionsPerYearPerToken = supplyFloat > 0 ? (epsFloat * SECONDS_PER_YEAR) / supplyFloat : 0;
          const emissionApy = emissionsPerYearPerToken && blndPrice && assetPrice
            ? emissionsPerYearPerToken * blndPrice / assetPrice * 100
            : null;

          await dbPool.query(`
            INSERT INTO daily_emission_apy (
              rate_date, apy_type, pool_address, asset_address,
              eps, eps_decimals, total_supply,
              blnd_price_usd, asset_price_usd,
              emissions_per_year_per_token, emission_apy, source
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT ON CONSTRAINT daily_emission_apy_unique
            DO UPDATE SET
              eps = EXCLUDED.eps,
              eps_decimals = EXCLUDED.eps_decimals,
              total_supply = EXCLUDED.total_supply,
              blnd_price_usd = EXCLUDED.blnd_price_usd,
              asset_price_usd = EXCLUDED.asset_price_usd,
              emissions_per_year_per_token = EXCLUDED.emissions_per_year_per_token,
              emission_apy = EXCLUDED.emission_apy,
              source = EXCLUDED.source
          `, [
            today,
            'lending_supply',
            trackedPool.id,
            assetAddress,
            eps.toString(),
            EPS_DECIMALS,
            bSupply.toString(),
            blndPrice || null,
            assetPrice || null,
            emissionsPerYearPerToken,
            emissionApy,
            'sdk',
          ]);

          console.log(`  Supply ${assetAddress.slice(0, 8)}...: ${emissionApy ? emissionApy.toFixed(2) + '%' : 'N/A'}`);
          totalInserted++;
        }

        // Borrow emissions
        const borrowEmissions = reserve.borrowEmissions;
        if (borrowEmissions && borrowEmissions.eps > 0n) {
          const dSupply = reserve.totalLiabilities(); // returns bigint
          const eps = borrowEmissions.eps;

          const epsFloat = Number(eps) / Math.pow(10, EPS_DECIMALS);
          const supplyFloat = Number(dSupply) / Math.pow(10, reserve.config.decimals);
          const emissionsPerYearPerToken = supplyFloat > 0 ? (epsFloat * SECONDS_PER_YEAR) / supplyFloat : 0;
          const emissionApy = emissionsPerYearPerToken && blndPrice && assetPrice
            ? emissionsPerYearPerToken * blndPrice / assetPrice * 100
            : null;

          await dbPool.query(`
            INSERT INTO daily_emission_apy (
              rate_date, apy_type, pool_address, asset_address,
              eps, eps_decimals, total_supply,
              blnd_price_usd, asset_price_usd,
              emissions_per_year_per_token, emission_apy, source
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT ON CONSTRAINT daily_emission_apy_unique
            DO UPDATE SET
              eps = EXCLUDED.eps,
              eps_decimals = EXCLUDED.eps_decimals,
              total_supply = EXCLUDED.total_supply,
              blnd_price_usd = EXCLUDED.blnd_price_usd,
              asset_price_usd = EXCLUDED.asset_price_usd,
              emissions_per_year_per_token = EXCLUDED.emissions_per_year_per_token,
              emission_apy = EXCLUDED.emission_apy,
              source = EXCLUDED.source
          `, [
            today,
            'lending_borrow',
            trackedPool.id,
            assetAddress,
            eps.toString(),
            EPS_DECIMALS,
            dSupply.toString(),
            blndPrice || null,
            assetPrice || null,
            emissionsPerYearPerToken,
            emissionApy,
            'sdk',
          ]);

          console.log(`  Borrow ${assetAddress.slice(0, 8)}...: ${emissionApy ? emissionApy.toFixed(2) + '%' : 'N/A'}`);
          totalInserted++;
        }

        // --- POOL SNAPSHOT ---
        // Capture current reserve state for pool_snapshots table
        // Rates use 12 decimals, b/d tokens always use 7 decimals (regardless of underlying asset)
        const RATE_DECIMALS = 12;
        const TOKEN_DECIMALS = 7; // b-tokens and d-tokens always have 7 decimals
        const bRateFloat = Number(reserve.data.bRate) / Math.pow(10, RATE_DECIMALS);
        const dRateFloat = Number(reserve.data.dRate) / Math.pow(10, RATE_DECIMALS);
        const bSupplyFloat = Number(reserve.data.bSupply) / Math.pow(10, TOKEN_DECIMALS);
        const dSupplyFloat = Number(reserve.data.dSupply) / Math.pow(10, TOKEN_DECIMALS);

        poolSnapshots.push({
          pool_id: trackedPool.id,
          asset_address: assetAddress,
          snapshot_date: today,
          snapshot_timestamp: now,
          ledger_sequence: ledgerSequence,
          b_rate: bRateFloat,
          d_rate: dRateFloat,
          b_supply: bSupplyFloat,
          d_supply: dSupplyFloat,
          last_time: reserve.data.lastTime,
        });
      }

    } catch (error) {
      console.error(`  Error processing pool: ${error}`);
    }
  }

  // Batch insert pool snapshots
  if (poolSnapshots.length > 0) {
    console.log(`\nSaving ${poolSnapshots.length} pool snapshots...`);
    const snapshotResult = await poolRepository.insertBatch(poolSnapshots);
    snapshotsInserted = snapshotResult.inserted + snapshotResult.updated;
    console.log(`✅ Pool snapshots: ${snapshotResult.inserted} inserted, ${snapshotResult.updated} updated`);
  }

  console.log(`\n✅ Captured ${totalInserted} BLND emission APY records for ${today}`);
  console.log(`✅ Captured ${snapshotsInserted} pool snapshots for ${today}`);
}

async function main() {
  const args = process.argv.slice(2);
  const backstopOnly = args.includes("--backstop");
  const lendingOnly = args.includes("--lending");
  const todayOnly = args.includes("--today");
  const skipConfirmation = args.includes("--yes") || args.includes("-y");

  console.log("=".repeat(50));
  console.log("BLND EMISSION APY BACKFILL");
  console.log("=".repeat(50));

  try {
    if (todayOnly) {
      // Use SDK to capture just today's values (efficient for daily cron)
      console.log("Mode: Capture today's APY using Blend SDK");
      await captureTodayEmissionApy();
    } else {
      // Full historical backfill
      console.log("Mode: Historical backfill");

      // Step 1: Check/backfill pool_snapshots from BigQuery (for lending APY)
      if (!backstopOnly) {
        const hasPoolSnapshots = await checkAndBackfillPoolSnapshots(skipConfirmation);
        if (!hasPoolSnapshots) {
          console.log("\n⚠️  Cannot calculate lending emission APY without pool_snapshots data");
          console.log("   Run again and confirm BigQuery backfill, or use --backstop for backstop only");
        }
      }

      // Step 2: Backfill backstop emission APY (from backstop_events)
      if (!lendingOnly) {
        await backfillBackstopEmissionApy();
      }

      // Step 3: Backfill lending emission APY (from pool_snapshots)
      if (!backstopOnly) {
        await backfillLendingEmissionApy();
      }
    }

    // Show summary
    const summary = await dbPool.query(`
      SELECT
        apy_type,
        COUNT(*) as row_count,
        MIN(rate_date) as min_date,
        MAX(rate_date) as max_date,
        AVG(emission_apy) as avg_apy
      FROM daily_emission_apy
      GROUP BY apy_type
      ORDER BY apy_type
    `);

    console.log("\n========================================");
    console.log("SUMMARY");
    console.log("========================================");
    for (const row of summary.rows) {
      console.log(`\n${row.apy_type}:`);
      console.log(`  Rows: ${row.row_count}`);
      console.log(`  Date range: ${row.min_date?.toISOString().split("T")[0]} to ${row.max_date?.toISOString().split("T")[0]}`);
      console.log(`  Avg APY: ${row.avg_apy ? parseFloat(row.avg_apy).toFixed(2) : "N/A"}%`);
    }

    const total = await dbPool.query("SELECT COUNT(*) FROM daily_emission_apy");
    console.log(`\nTotal rows in daily_emission_apy: ${total.rows[0].count}`);

  } finally {
    await closePool();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
