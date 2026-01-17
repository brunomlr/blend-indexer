/**
 * Fetch current emission configurations from all tracked pools
 *
 * This script queries the Blend SDK to get emissions per second (EPS)
 * for each asset in each pool, plus backstop emissions.
 *
 * Usage:
 *   npx ts-node src/scripts/fetch-emission-configs.ts          # Fetch and display only
 *   npx ts-node src/scripts/fetch-emission-configs.ts --save   # Fetch and save to database
 */

import dotenv from "dotenv";
import path from "path";

// Load environment variables from .env file
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import {
  BackstopPoolV2,
  PoolMetadata,
  PoolV2,
  Version,
  type Pool,
  type Reserve,
} from "@blend-capital/blend-sdk";
import { TRACKED_POOLS } from "../lib/blend/pools";
import { getBlendNetwork } from "../lib/blend/network";
import { pool as dbPool, closePool } from "../config/database";

const BACKSTOP_ID = "CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7";
const EPS_DECIMALS = 14; // V2 uses 14 decimals for EPS

interface EmissionConfig {
  poolId: string;
  poolName: string;
  assetAddress: string;
  supplyEps: bigint;
  borrowEps: bigint;
  supplyExpiration: number;
  borrowExpiration: number;
}

interface BackstopEmissionConfig {
  poolId: string;
  poolName: string;
  eps: bigint;
  epsDecimals: number;
  expiration: number;
  shares: bigint;
  tokens: bigint;
  q4w: bigint;
}

async function fetchEmissionConfigs(): Promise<EmissionConfig[]> {
  const network = getBlendNetwork();
  const configs: EmissionConfig[] = [];

  console.log("Fetching emission configs from Blend pools...\n");
  console.log(`Network: ${network.passphrase}`);
  console.log(`RPC: ${network.rpc}\n`);

  for (const trackedPool of TRACKED_POOLS) {
    console.log(`\n=== ${trackedPool.name} ===`);
    console.log(`Pool ID: ${trackedPool.id}`);

    if (trackedPool.version !== Version.V2) {
      console.log("  Skipping V1 pool");
      continue;
    }

    try {
      const metadata = await PoolMetadata.load(network, trackedPool.id);
      const pool: Pool = await PoolV2.loadWithMetadata(network, trackedPool.id, metadata);

      const reserves = Array.from(pool.reserves.values()) as Reserve[];

      let hasEmissions = false;
      for (const reserve of reserves) {
        const supplyEmissions = reserve.supplyEmissions;
        const borrowEmissions = reserve.borrowEmissions;

        const supplyEps = supplyEmissions?.eps ?? 0n;
        const borrowEps = borrowEmissions?.eps ?? 0n;

        if (supplyEps > 0n || borrowEps > 0n) {
          hasEmissions = true;
          console.log(`\n  Asset: ${reserve.assetId}`);

          // V2 uses 14 decimals for EPS
          const EPS_DECIMALS = 14;

          if (supplyEps > 0n) {
            const supplyEpsFloat = Number(supplyEps) / Math.pow(10, EPS_DECIMALS);
            console.log(`    Supply EPS: ${supplyEps.toString()} (${supplyEpsFloat.toFixed(10)} BLND/sec)`);
            console.log(`    Supply Annual: ${(supplyEpsFloat * 31_536_000).toFixed(2)} BLND/year`);
            console.log(`    Supply Expiration: ${supplyEmissions?.expiration}`);
          }

          if (borrowEps > 0n) {
            const borrowEpsFloat = Number(borrowEps) / Math.pow(10, EPS_DECIMALS);
            console.log(`    Borrow EPS: ${borrowEps.toString()} (${borrowEpsFloat.toFixed(10)} BLND/sec)`);
            console.log(`    Borrow Annual: ${(borrowEpsFloat * 31_536_000).toFixed(2)} BLND/year`);
            console.log(`    Borrow Expiration: ${borrowEmissions?.expiration}`);
          }

          configs.push({
            poolId: trackedPool.id,
            poolName: trackedPool.name,
            assetAddress: reserve.assetId,
            supplyEps,
            borrowEps,
            supplyExpiration: supplyEmissions?.expiration ?? 0,
            borrowExpiration: borrowEmissions?.expiration ?? 0,
          });
        }
      }

      if (!hasEmissions) {
        console.log("  No emissions configured for this pool");
      }

    } catch (error) {
      console.error(`  Error loading pool: ${error}`);
    }
  }

  console.log("\n\n=== Summary ===");
  console.log(`Total emission configs found: ${configs.length}`);

  // Calculate annual emissions per pool (V2 eps is in 14 decimal fixed point)
  const SECONDS_PER_YEAR = 31_536_000;
  const EPS_DECIMALS = 14;
  const poolTotals = new Map<string, { supply: number; borrow: number }>();

  for (const config of configs) {
    const current = poolTotals.get(config.poolName) || { supply: 0, borrow: 0 };
    current.supply += (Number(config.supplyEps) / Math.pow(10, EPS_DECIMALS)) * SECONDS_PER_YEAR;
    current.borrow += (Number(config.borrowEps) / Math.pow(10, EPS_DECIMALS)) * SECONDS_PER_YEAR;
    poolTotals.set(config.poolName, current);
  }

  console.log("\nAnnual BLND emissions per pool (lending):");
  for (const [poolName, totals] of poolTotals) {
    console.log(`  ${poolName}:`);
    console.log(`    Supply emissions: ${totals.supply.toLocaleString()} BLND/year`);
    console.log(`    Borrow emissions: ${totals.borrow.toLocaleString()} BLND/year`);
    console.log(`    Total: ${(totals.supply + totals.borrow).toLocaleString()} BLND/year`);
  }

  return configs;
}

async function fetchBackstopEmissions(): Promise<BackstopEmissionConfig[]> {
  const network = getBlendNetwork();
  const backstopConfigs: BackstopEmissionConfig[] = [];

  console.log("\n\n========================================");
  console.log("BACKSTOP EMISSIONS");
  console.log("========================================\n");
  console.log(`Backstop ID: ${BACKSTOP_ID}\n`);

  for (const trackedPool of TRACKED_POOLS) {
    console.log(`\n=== ${trackedPool.name} ===`);
    console.log(`Pool ID: ${trackedPool.id}`);

    try {
      // Load backstop pool data for this pool
      const backstopPool = await BackstopPoolV2.load(network, BACKSTOP_ID, trackedPool.id);

      const emissions = backstopPool.emissions;
      if (emissions) {
        const eps = emissions.eps;
        const expiration = emissions.expiration;
        const { shares, tokens, q4w } = backstopPool.poolBalance;

        // eps is in 7 decimals for V1, 14 decimals for V2
        const epsDecimals = emissions.epsDecimals;
        const epsFloat = Number(eps) / Math.pow(10, epsDecimals);

        console.log(`  EPS: ${eps.toString()} (${epsFloat} BLND/sec)`);
        console.log(`  EPS Decimals: ${epsDecimals}`);
        console.log(`  Expiration: ${expiration} (${new Date(expiration * 1000).toISOString()})`);
        console.log(`  Shares: ${shares.toString()}`);
        console.log(`  Tokens: ${tokens.toString()}`);
        console.log(`  Q4W: ${q4w.toString()}`);

        // Calculate annual emissions
        const annualEmissions = epsFloat * 31_536_000;
        console.log(`  Annual BLND: ${annualEmissions.toLocaleString()}`);

        // Calculate current APY (emissions per year per token)
        const emissionPerYear = backstopPool.emissionPerYearPerBackstopToken();
        console.log(`  Emissions/Year/Token: ${emissionPerYear}`);

        backstopConfigs.push({
          poolId: trackedPool.id,
          poolName: trackedPool.name,
          eps,
          epsDecimals,
          expiration,
          shares,
          tokens,
          q4w,
        });
      } else {
        console.log("  No emissions configured");
      }
    } catch (error) {
      console.error(`  Error loading backstop pool: ${error}`);
    }
  }

  // Summary
  console.log("\n\n=== Backstop Summary ===");
  const SECONDS_PER_YEAR = 31_536_000;
  let totalBackstopEmissions = 0;

  for (const config of backstopConfigs) {
    // Use actual epsDecimals from config (14 for V2)
    const epsFloat = Number(config.eps) / Math.pow(10, config.epsDecimals);
    const annual = epsFloat * SECONDS_PER_YEAR;
    totalBackstopEmissions += annual;
    console.log(`  ${config.poolName}: ${annual.toFixed(2)} BLND/year`);
  }
  console.log(`  TOTAL: ${totalBackstopEmissions.toFixed(2)} BLND/year`);

  return backstopConfigs;
}

/**
 * Save lending emission configs to database
 */
async function saveLendingConfigs(configs: EmissionConfig[]): Promise<void> {
  console.log("\n\n========================================");
  console.log("SAVING LENDING CONFIGS TO DATABASE");
  console.log("========================================\n");

  let inserted = 0;
  let updated = 0;

  for (const config of configs) {
    // Save supply emissions if > 0
    if (config.supplyEps > 0n) {
      const result = await dbPool.query(
        `INSERT INTO emission_configs (config_type, pool_address, asset_address, eps, eps_decimals, expiration)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ON CONSTRAINT emission_configs_unique
         DO UPDATE SET eps = $4, eps_decimals = $5, expiration = $6
         RETURNING (xmax = 0) AS inserted`,
        [
          "lending_supply",
          config.poolId,
          config.assetAddress,
          config.supplyEps.toString(),
          EPS_DECIMALS,
          config.supplyExpiration || null,
        ]
      );
      if (result.rows[0]?.inserted) {
        inserted++;
      } else {
        updated++;
      }
      console.log(`  ✓ ${config.poolName} / supply / ${config.assetAddress.slice(0, 8)}...`);
    }

    // Save borrow emissions if > 0
    if (config.borrowEps > 0n) {
      const result = await dbPool.query(
        `INSERT INTO emission_configs (config_type, pool_address, asset_address, eps, eps_decimals, expiration)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ON CONSTRAINT emission_configs_unique
         DO UPDATE SET eps = $4, eps_decimals = $5, expiration = $6
         RETURNING (xmax = 0) AS inserted`,
        [
          "lending_borrow",
          config.poolId,
          config.assetAddress,
          config.borrowEps.toString(),
          EPS_DECIMALS,
          config.borrowExpiration || null,
        ]
      );
      if (result.rows[0]?.inserted) {
        inserted++;
      } else {
        updated++;
      }
      console.log(`  ✓ ${config.poolName} / borrow / ${config.assetAddress.slice(0, 8)}...`);
    }
  }

  console.log(`\nLending configs: ${inserted} inserted, ${updated} updated`);
}

/**
 * Save backstop emission configs to database
 */
async function saveBackstopConfigs(configs: BackstopEmissionConfig[]): Promise<void> {
  console.log("\n\n========================================");
  console.log("SAVING BACKSTOP CONFIGS TO DATABASE");
  console.log("========================================\n");

  let inserted = 0;
  let updated = 0;

  for (const config of configs) {
    const result = await dbPool.query(
      `INSERT INTO emission_configs (config_type, pool_address, asset_address, eps, eps_decimals, expiration)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ON CONSTRAINT emission_configs_unique
       DO UPDATE SET eps = $4, eps_decimals = $5, expiration = $6
       RETURNING (xmax = 0) AS inserted`,
      [
        "backstop",
        config.poolId,
        null, // asset_address is NULL for backstop
        config.eps.toString(),
        config.epsDecimals,
        config.expiration || null,
      ]
    );
    if (result.rows[0]?.inserted) {
      inserted++;
    } else {
      updated++;
    }
    console.log(`  ✓ ${config.poolName} backstop`);
  }

  console.log(`\nBackstop configs: ${inserted} inserted, ${updated} updated`);
}

// Run if called directly
async function main() {
  const shouldSave = process.argv.includes("--save");

  console.log("=".repeat(50));
  console.log("BLEND EMISSION CONFIGURATION FETCHER");
  console.log("=".repeat(50));
  if (shouldSave) {
    console.log("Mode: FETCH AND SAVE TO DATABASE");
  } else {
    console.log("Mode: FETCH ONLY (use --save to persist to database)");
  }

  const lendingConfigs = await fetchEmissionConfigs();
  const backstopConfigs = await fetchBackstopEmissions();

  if (shouldSave) {
    await saveLendingConfigs(lendingConfigs);
    await saveBackstopConfigs(backstopConfigs);

    // Show final count
    const countResult = await dbPool.query("SELECT COUNT(*) FROM emission_configs");
    console.log(`\n✅ Total configs in database: ${countResult.rows[0].count}`);

    await closePool();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
