/**
 * Sync pools and tokens tables from:
 * - pools: TRACKED_POOLS config
 * - tokens: discovered assets in blend_actions + Blend SDK metadata
 *
 * Run after backfill to ensure reference tables are up to date:
 *   npx ts-node src/scripts/sync-pools-tokens.ts
 */

import dotenv from "dotenv";
import path from "path";
import { Pool } from "pg";
import { TokenMetadata, Version } from "@blend-capital/blend-sdk";
import { TRACKED_POOLS } from "../lib/blend/pools";
import { getBlendNetwork } from "../lib/blend/network";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("neon") ? { rejectUnauthorized: false } : undefined,
});

interface PoolRow {
  pool_id: string;
  name: string;
  short_name: string | null;
  version: string;
  is_active: boolean;
}

interface TokenRow {
  asset_address: string;
  symbol: string;
  name: string;
  decimals: number;
  is_native: boolean;
}

async function syncPools(): Promise<number> {
  console.log("\n📦 Syncing pools table...");

  let synced = 0;

  for (const trackedPool of TRACKED_POOLS) {
    const shortName = trackedPool.name.substring(0, 20);
    const version = trackedPool.version === Version.V1 ? "v1" : "v2";

    try {
      await pool.query(
        `
        INSERT INTO pools (pool_id, name, short_name, version, is_active)
        VALUES ($1, $2, $3, $4, true)
        ON CONFLICT (pool_id) DO UPDATE SET
          name = EXCLUDED.name,
          short_name = EXCLUDED.short_name,
          version = EXCLUDED.version,
          updated_at = NOW()
        `,
        [trackedPool.id, trackedPool.name, shortName, version]
      );
      console.log(`  ✓ ${trackedPool.name} (${trackedPool.id.slice(0, 8)}...)`);
      synced++;
    } catch (error) {
      console.error(`  ✗ Failed to sync pool ${trackedPool.name}:`, error);
    }
  }

  return synced;
}

async function tableExists(tableName: string): Promise<boolean> {
  const result = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    )
  `, [tableName]);
  return result.rows[0].exists;
}

async function discoverTokensFromDatabase(): Promise<Set<string>> {
  console.log("\n🔍 Discovering tokens from database...");
  const addresses = new Set<string>();

  // Check parsed_events (Goldsky pipeline)
  if (await tableExists("parsed_events")) {
    console.log("  Checking parsed_events...");
    const result = await pool.query(`
      SELECT DISTINCT asset_address
      FROM parsed_events
      WHERE asset_address IS NOT NULL
    `);
    result.rows.forEach((r) => addresses.add(r.asset_address));
    console.log(`    Found ${result.rows.length} tokens`);
  }

  // Check blend_actions
  if (await tableExists("blend_actions")) {
    console.log("  Checking blend_actions...");
    const result = await pool.query(`
      SELECT DISTINCT asset_address
      FROM blend_actions
      WHERE asset_address IS NOT NULL
    `);
    result.rows.forEach((r) => addresses.add(r.asset_address));
    console.log(`    Found ${result.rows.length} tokens`);
  }

  // Check user_positions
  if (await tableExists("user_positions")) {
    console.log("  Checking user_positions...");
    const result = await pool.query(`
      SELECT DISTINCT asset_address
      FROM user_positions
      WHERE asset_address IS NOT NULL
    `);
    result.rows.forEach((r) => addresses.add(r.asset_address));
    console.log(`    Found ${result.rows.length} tokens`);
  }

  // Check pool_snapshots
  if (await tableExists("pool_snapshots")) {
    console.log("  Checking pool_snapshots...");
    const result = await pool.query(`
      SELECT DISTINCT asset_address
      FROM pool_snapshots
      WHERE asset_address IS NOT NULL
    `);
    result.rows.forEach((r) => addresses.add(r.asset_address));
    console.log(`    Found ${result.rows.length} tokens`);
  }

  console.log(`  Total unique tokens: ${addresses.size}`);
  return addresses;
}

async function getExistingTokens(): Promise<Set<string>> {
  const result = await pool.query(`SELECT asset_address FROM tokens`);
  return new Set(result.rows.map((r) => r.asset_address));
}

async function syncTokens(): Promise<{ inserted: number; updated: number }> {
  console.log("\n🪙 Syncing tokens table...");

  const network = getBlendNetwork();
  const discoveredAddresses = await discoverTokensFromDatabase();
  const existingTokens = await getExistingTokens();

  let inserted = 0;
  let updated = 0;

  // XLM native asset address (special case)
  const XLM_ADDRESS = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2EZ4YXL";

  for (const address of discoveredAddresses) {
    try {
      let symbol = "UNKNOWN";
      let name = address.slice(0, 8);
      let decimals = 7;
      let isNative = false;

      // Check if this is the native XLM token
      if (address === XLM_ADDRESS) {
        symbol = "XLM";
        name = "Stellar Lumens";
        decimals = 7;
        isNative = true;
      } else {
        // Fetch metadata from Blend SDK
        try {
          const metadata = await TokenMetadata.load(network, address);
          symbol = metadata.symbol || symbol;
          name = metadata.name || metadata.symbol || name;
          decimals = metadata.decimals ?? decimals;
        } catch (metadataError) {
          console.warn(`    Could not fetch metadata for ${address.slice(0, 8)}...`);
        }
      }

      const isNew = !existingTokens.has(address);

      await pool.query(
        `
        INSERT INTO tokens (asset_address, symbol, name, decimals, is_native)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (asset_address) DO UPDATE SET
          symbol = CASE WHEN EXCLUDED.symbol != 'UNKNOWN' THEN EXCLUDED.symbol ELSE tokens.symbol END,
          name = CASE WHEN EXCLUDED.name != LEFT(EXCLUDED.asset_address, 8) THEN EXCLUDED.name ELSE tokens.name END,
          decimals = EXCLUDED.decimals,
          is_native = EXCLUDED.is_native,
          updated_at = NOW()
        `,
        [address, symbol, name, decimals, isNative]
      );

      if (isNew) {
        console.log(`  + ${symbol} (${address.slice(0, 8)}...) - NEW`);
        inserted++;
      } else {
        console.log(`  ~ ${symbol} (${address.slice(0, 8)}...) - updated`);
        updated++;
      }
    } catch (error) {
      console.error(`  ✗ Failed to sync token ${address}:`, error);
    }
  }

  return { inserted, updated };
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Pools & Tokens Sync");
  console.log("═══════════════════════════════════════════════════════════");

  try {
    // Test connection
    await pool.query("SELECT 1");
    console.log("✓ Database connected");

    // Sync pools
    const poolsSynced = await syncPools();

    // Sync tokens
    const tokenResults = await syncTokens();

    // Summary
    console.log("\n═══════════════════════════════════════════════════════════");
    console.log("  Summary");
    console.log("═══════════════════════════════════════════════════════════");
    console.log(`  Pools synced:    ${poolsSynced}`);
    console.log(`  Tokens inserted: ${tokenResults.inserted}`);
    console.log(`  Tokens updated:  ${tokenResults.updated}`);
    console.log("═══════════════════════════════════════════════════════════\n");
  } catch (error) {
    console.error("Sync failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
