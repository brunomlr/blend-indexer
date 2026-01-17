/**
 * BigQuery Configuration for Pool and Asset Backfills
 *
 * NOTE: This manual configuration is now DEPRECATED.
 * Use the dynamic discovery via /api/bigquery/discover instead.
 * This configuration is kept for backward compatibility only.
 */

export interface PoolAssetConfig {
  poolId: string;
  poolName: string;
  assets: {
    address: string;
    name: string;
    reserveIndex: number; // Index in the pool's reserves array (0, 1, 2, etc.)
  }[];
}

/**
 * Pool and Asset Configuration (LEGACY - Use discovery instead!)
 *
 * RECOMMENDED: Use the Blend SDK discovery to automatically get all assets:
 * - Run `npm run dev` and navigate to http://localhost:3000/bigquery.html
 * - Click "Discover Assets from Pools" to see all available assets
 * - The backfill will automatically use discovered assets
 *
 * This manual config is kept for backward compatibility only.
 */
export const POOL_ASSET_CONFIG: PoolAssetConfig[] = [
  {
    poolId: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
    poolName: 'Blend Pool',
    assets: [
      {
        address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
        name: 'USDC',
        reserveIndex: 0,
      },
    ],
  },
  {
    poolId: 'CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS',
    poolName: 'YieldBlox',
    assets: [
      {
        address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
        name: 'USDC',
        reserveIndex: 0,
      },
    ],
  },
];

/**
 * Get all pool IDs from config
 */
export function getAllPoolIds(): string[] {
  return POOL_ASSET_CONFIG.map(config => config.poolId);
}

/**
 * Get all asset addresses from config
 */
export function getAllAssetAddresses(): string[] {
  const addresses = new Set<string>();
  POOL_ASSET_CONFIG.forEach(pool => {
    pool.assets.forEach(asset => {
      addresses.add(asset.address);
    });
  });
  return Array.from(addresses);
}

/**
 * Get pool-asset pairs for query generation
 */
export function getPoolAssetPairs(): Array<{
  poolId: string;
  poolName: string;
  assetAddress: string;
  assetName: string;
  reserveIndex: number;
}> {
  const pairs: Array<{
    poolId: string;
    poolName: string;
    assetAddress: string;
    assetName: string;
    reserveIndex: number;
  }> = [];

  POOL_ASSET_CONFIG.forEach(pool => {
    pool.assets.forEach(asset => {
      pairs.push({
        poolId: pool.poolId,
        poolName: pool.poolName,
        assetAddress: asset.address,
        assetName: asset.name,
        reserveIndex: asset.reserveIndex,
      });
    });
  });

  return pairs;
}

/**
 * Find pool config by pool ID
 */
export function getPoolConfig(poolId: string): PoolAssetConfig | undefined {
  return POOL_ASSET_CONFIG.find(config => config.poolId === poolId);
}

/**
 * Use dynamic discovery to get pool-asset configuration
 * This is the RECOMMENDED approach as it automatically discovers all assets from pools
 */
export async function getPoolAssetPairsFromDiscovery(): Promise<Array<{
  poolId: string;
  poolName: string;
  assetAddress: string;
  assetName: string;
  reserveIndex: number;
}>> {
  try {
    const { discoverAllPoolAssets, convertToLegacyConfig } = await import('../lib/blend/discovery');

    console.log('🔍 Using dynamic asset discovery from Blend SDK...');
    const discovery = await discoverAllPoolAssets();
    const config = convertToLegacyConfig(discovery);

    const pairs: Array<{
      poolId: string;
      poolName: string;
      assetAddress: string;
      assetName: string;
      reserveIndex: number;
    }> = [];

    config.forEach(pool => {
      pool.assets.forEach(asset => {
        pairs.push({
          poolId: pool.poolId,
          poolName: pool.poolName,
          assetAddress: asset.address,
          assetName: asset.name,
          reserveIndex: asset.reserveIndex,
        });
      });
    });

    console.log(`✓ Discovered ${pairs.length} pool-asset pairs from ${config.length} pools\n`);
    return pairs;
  } catch (error) {
    console.warn('⚠️  Failed to use dynamic discovery, falling back to manual config:', (error as Error)?.message);
    return getPoolAssetPairs();
  }
}
