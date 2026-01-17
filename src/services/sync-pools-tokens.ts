/**
 * Service to sync pools and tokens tables from:
 * - pools: TRACKED_POOLS config
 * - tokens: discovered assets in events tables + Blend SDK metadata
 */

import { Pool } from "pg";
import { TokenMetadata, Version } from "@blend-capital/blend-sdk";
import { TRACKED_POOLS } from "../lib/blend/pools";
import { getBlendNetwork } from "../lib/blend/network";

// XLM native asset address (special case)
const XLM_ADDRESS = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2EZ4YXL";

export interface SyncResult {
  success: boolean;
  pools: {
    synced: number;
    errors: string[];
  };
  tokens: {
    inserted: number;
    updated: number;
    errors: string[];
  };
  error?: string;
}

export class SyncPoolsTokensService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async tableExists(tableName: string): Promise<boolean> {
    const result = await this.pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      )
    `, [tableName]);
    return result.rows[0].exists;
  }

  async syncPools(): Promise<{ synced: number; errors: string[] }> {
    let synced = 0;
    const errors: string[] = [];

    for (const trackedPool of TRACKED_POOLS) {
      const shortName = trackedPool.name.substring(0, 20);
      const version = trackedPool.version === Version.V1 ? "v1" : "v2";

      try {
        await this.pool.query(
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
        synced++;
      } catch (error) {
        const msg = `Failed to sync pool ${trackedPool.name}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(msg);
        console.error(msg);
      }
    }

    return { synced, errors };
  }

  async discoverTokensFromDatabase(): Promise<Set<string>> {
    const addresses = new Set<string>();

    // Check parsed_events (Goldsky pipeline)
    if (await this.tableExists("parsed_events")) {
      const result = await this.pool.query(`
        SELECT DISTINCT asset_address
        FROM parsed_events
        WHERE asset_address IS NOT NULL
      `);
      result.rows.forEach((r) => addresses.add(r.asset_address));
    }

    // Check blend_actions
    if (await this.tableExists("blend_actions")) {
      const result = await this.pool.query(`
        SELECT DISTINCT asset_address
        FROM blend_actions
        WHERE asset_address IS NOT NULL
      `);
      result.rows.forEach((r) => addresses.add(r.asset_address));
    }

    // Check user_positions
    if (await this.tableExists("user_positions")) {
      const result = await this.pool.query(`
        SELECT DISTINCT asset_address
        FROM user_positions
        WHERE asset_address IS NOT NULL
      `);
      result.rows.forEach((r) => addresses.add(r.asset_address));
    }

    // Check pool_snapshots
    if (await this.tableExists("pool_snapshots")) {
      const result = await this.pool.query(`
        SELECT DISTINCT asset_address
        FROM pool_snapshots
        WHERE asset_address IS NOT NULL
      `);
      result.rows.forEach((r) => addresses.add(r.asset_address));
    }

    return addresses;
  }

  async getExistingTokens(): Promise<Set<string>> {
    const result = await this.pool.query(`SELECT asset_address FROM tokens`);
    return new Set(result.rows.map((r) => r.asset_address));
  }

  async syncTokens(): Promise<{ inserted: number; updated: number; errors: string[] }> {
    const network = getBlendNetwork();
    const discoveredAddresses = await this.discoverTokensFromDatabase();
    const existingTokens = await this.getExistingTokens();

    let inserted = 0;
    let updated = 0;
    const errors: string[] = [];

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
            // Token metadata not available, use defaults
          }
        }

        const isNew = !existingTokens.has(address);

        await this.pool.query(
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
          inserted++;
        } else {
          updated++;
        }
      } catch (error) {
        const msg = `Failed to sync token ${address.slice(0, 8)}...: ${error instanceof Error ? error.message : 'Unknown error'}`;
        errors.push(msg);
        console.error(msg);
      }
    }

    return { inserted, updated, errors };
  }

  async runSync(): Promise<SyncResult> {
    try {
      // Test connection
      await this.pool.query("SELECT 1");

      // Sync pools
      console.log("Syncing pools table...");
      const poolsResult = await this.syncPools();

      // Sync tokens
      console.log("Syncing tokens table...");
      const tokensResult = await this.syncTokens();

      return {
        success: true,
        pools: poolsResult,
        tokens: tokensResult,
      };
    } catch (error) {
      console.error("Sync failed:", error);
      return {
        success: false,
        pools: { synced: 0, errors: [] },
        tokens: { inserted: 0, updated: 0, errors: [] },
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get current counts from pools and tokens tables
   */
  async getStats(): Promise<{
    poolsCount: number;
    tokensCount: number;
    trackedPoolsCount: number;
  }> {
    let poolsCount = 0;
    let tokensCount = 0;

    if (await this.tableExists("pools")) {
      const result = await this.pool.query("SELECT COUNT(*) FROM pools");
      poolsCount = parseInt(result.rows[0].count, 10);
    }

    if (await this.tableExists("tokens")) {
      const result = await this.pool.query("SELECT COUNT(*) FROM tokens");
      tokensCount = parseInt(result.rows[0].count, 10);
    }

    return {
      poolsCount,
      tokensCount,
      trackedPoolsCount: TRACKED_POOLS.length,
    };
  }
}
