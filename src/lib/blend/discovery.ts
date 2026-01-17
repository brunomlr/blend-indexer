import {
  Pool,
  PoolMetadata,
  PoolV1,
  PoolV2,
  TokenMetadata,
  Version,
  type Network,
  type Reserve,
} from "@blend-capital/blend-sdk";
import { getBlendNetwork } from "./network";
import { TRACKED_POOLS, type TrackedPool } from "./pools";

/**
 * Discovered token/asset information
 */
export interface DiscoveredAsset {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  reserveIndex: number;
}

/**
 * Pool with its discovered assets
 */
export interface DiscoveredPool {
  poolId: string;
  poolName: string;
  version: string;
  assets: DiscoveredAsset[];
  error?: string;
}

/**
 * Complete discovery result
 */
export interface PoolDiscoveryResult {
  pools: DiscoveredPool[];
  totalAssets: number;
  uniqueAssets: number;
  timestamp: string;
}

/**
 * Discover all tokens/assets in a pool using the Blend SDK
 */
export async function discoverPoolAssets(
  trackedPool: TrackedPool,
  network: Network
): Promise<DiscoveredPool> {
  try {
    console.log(`[discovery] Loading pool: ${trackedPool.name} (${trackedPool.id})`);

    // Load pool metadata and instance
    const metadata = await PoolMetadata.load(network, trackedPool.id);
    const pool: Pool =
      trackedPool.version === Version.V2
        ? await PoolV2.loadWithMetadata(network, trackedPool.id, metadata)
        : await PoolV1.loadWithMetadata(network, trackedPool.id, metadata);

    // Get all reserves (tokens) from the pool
    const reserves = Array.from(pool.reserves.values());
    console.log(`[discovery] Found ${reserves.length} reserves in ${trackedPool.name}`);

    // Fetch metadata for each asset
    const assets: DiscoveredAsset[] = [];
    for (let i = 0; i < reserves.length; i++) {
      const reserve = reserves[i];
      try {
        const tokenMetadata = await TokenMetadata.load(network, reserve.assetId);
        assets.push({
          address: reserve.assetId,
          symbol: tokenMetadata.symbol || `Asset-${i}`,
          name: tokenMetadata.name || tokenMetadata.symbol || reserve.assetId.slice(0, 8),
          decimals: tokenMetadata.decimals || 7,
          reserveIndex: i,
        });
        console.log(`[discovery]   - ${tokenMetadata.symbol} (${reserve.assetId})`);
      } catch (error) {
        console.warn(
          `[discovery] Failed to load token metadata for ${reserve.assetId}:`,
          (error as Error)?.message
        );
        // Still add the asset with minimal info
        assets.push({
          address: reserve.assetId,
          symbol: `Asset-${i}`,
          name: reserve.assetId.slice(0, 8),
          decimals: 7,
          reserveIndex: i,
        });
      }
    }

    return {
      poolId: trackedPool.id,
      poolName: trackedPool.name,
      version: trackedPool.version === Version.V2 ? "V2" : "V1",
      assets,
    };
  } catch (error) {
    console.error(
      `[discovery] Failed to discover assets for pool ${trackedPool.id}:`,
      error
    );
    return {
      poolId: trackedPool.id,
      poolName: trackedPool.name,
      version: trackedPool.version === Version.V2 ? "V2" : "V1",
      assets: [],
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Discover all assets across all tracked pools
 */
export async function discoverAllPoolAssets(): Promise<PoolDiscoveryResult> {
  const network = getBlendNetwork();
  console.log(`\n🔍 Starting pool asset discovery on ${network.passphrase}...\n`);

  const pools: DiscoveredPool[] = [];
  let totalAssets = 0;
  const uniqueAssetAddresses = new Set<string>();

  // Discover assets for each pool
  for (const trackedPool of TRACKED_POOLS) {
    const discoveredPool = await discoverPoolAssets(trackedPool, network);
    pools.push(discoveredPool);

    totalAssets += discoveredPool.assets.length;
    discoveredPool.assets.forEach(asset => uniqueAssetAddresses.add(asset.address));
  }

  console.log(`\n✅ Discovery complete!`);
  console.log(`   Pools: ${pools.length}`);
  console.log(`   Total assets: ${totalAssets}`);
  console.log(`   Unique assets: ${uniqueAssetAddresses.size}\n`);

  return {
    pools,
    totalAssets,
    uniqueAssets: uniqueAssetAddresses.size,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Convert discovery result to the legacy PoolAssetConfig format
 * for backward compatibility
 */
export function convertToLegacyConfig(discovery: PoolDiscoveryResult) {
  return discovery.pools.map(pool => ({
    poolId: pool.poolId,
    poolName: pool.poolName,
    assets: pool.assets.map(asset => ({
      address: asset.address,
      name: asset.symbol,
      reserveIndex: asset.reserveIndex,
    })),
  }));
}
