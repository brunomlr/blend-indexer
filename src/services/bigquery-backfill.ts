import { bigQueryClient, QueryParams, AllAssetsQueryParams, AllPoolsQueryParams } from './bigquery-client';
import { bigQueryClientOptimized } from './bigquery-client-optimized';
import { userRepository } from '../repositories/user-repository';
import { UserPositionRow, BackfillResult } from '../types';
import { getPoolAssetPairs, getPoolAssetPairsFromDiscovery, POOL_ASSET_CONFIG } from '../config/bigquery-config';
import { confirm } from '../utils/prompt';

export interface BackfillOptions {
  daysBack?: number;
  targetUser?: string;
  startDate?: string;
  endDate?: string;
  startLedger?: number;
  endLedger?: number;
  skipConfirmation?: boolean; // Skip cost confirmation prompt
  queryMode?: 'individual' | 'allAssets' | 'allPools'; // Query mode: individual (per asset), allAssets (per pool), or allPools (single query)
  allAssets?: boolean; // Deprecated: use queryMode instead. Kept for backward compatibility
}

export class BigQueryBackfillService {
  /**
   * Run user positions backfill from BigQuery for all configured pools and assets
   */
  async runBackfillAll(options: BackfillOptions = {}): Promise<BackfillResult> {
    try {
      console.log('\n🔄 Starting bulk backfill from BigQuery...');

      // Show what parameters are being used
      if (options.targetUser) {
        console.log(`Target User: ${options.targetUser}`);
      } else {
        console.log(`Mode: All users`);
      }

      // Determine query mode (with backward compatibility)
      let queryMode = options.queryMode;
      if (!queryMode) {
        // Backward compatibility: convert allAssets boolean to queryMode
        if (options.allAssets === false) {
          queryMode = 'individual';
        } else {
          queryMode = 'allPools'; // New default: single query for everything
        }
      }

      if (queryMode === 'allPools') {
        console.log(`Query Mode: All pools, all assets (single query - maximum optimization)`);
      } else if (queryMode === 'allAssets') {
        console.log(`Query Mode: All assets per pool (one query per pool)`);
      } else {
        console.log(`Query Mode: Individual asset queries (one query per asset)`);
      }

      if (options.startDate && options.endDate) {
        console.log(`Date Range: ${options.startDate} to ${options.endDate}`);
      } else if (options.startDate) {
        console.log(`Start Date: ${options.startDate}`);
      } else if (options.endDate) {
        console.log(`End Date: ${options.endDate}`);
      } else {
        console.log(`Days Back: ${options.daysBack || 90}`);
      }

      if (options.startLedger || options.endLedger) {
        const start = options.startLedger ? options.startLedger.toLocaleString() : 'any';
        const end = options.endLedger ? options.endLedger.toLocaleString() : 'any';
        console.log(`Ledger Range: ${start} to ${end}`);
      }

      console.log('');

      // Route to appropriate backfill method based on query mode
      if (queryMode === 'allPools') {
        return await this.runBackfillAllPoolsMode(options);
      } else if (queryMode === 'allAssets') {
        return await this.runBackfillAllAssetsMode(options);
      } else {
        return await this.runBackfillIndividualMode(options);
      }

    } catch (error) {
      console.error('❌ Bulk backfill failed:', error);
      return {
        success: false,
        rows_inserted: 0,
        rows_updated: 0,
        query_id: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Run backfill in individual mode (one query per asset)
   */
  private async runBackfillIndividualMode(options: BackfillOptions): Promise<BackfillResult> {
    // Use dynamic discovery to get all assets from Blend SDK
    const poolAssetPairs = await getPoolAssetPairsFromDiscovery();
    console.log(`📊 Found ${poolAssetPairs.length} pool-asset combinations to backfill\n`);

    let totalInserted = 0;
    let totalUpdated = 0;
    let totalFetched = 0;

    // Process each pool-asset combination
    for (let i = 0; i < poolAssetPairs.length; i++) {
      const pair = poolAssetPairs[i];
      console.log('='.repeat(60));
      console.log(`[${i + 1}/${poolAssetPairs.length}] Processing: ${pair.poolName} - ${pair.assetName}`);
      console.log('='.repeat(60));

      const result = await this.runBackfillSingle({
        poolId: pair.poolId,
        assetAddress: pair.assetAddress,
        reserveIndex: pair.reserveIndex,
        ...options, // Spread all options (daysBack, dates, ledgers, user)
      });

      if (result.success) {
        totalInserted += result.rows_inserted;
        totalUpdated += result.rows_updated;
        totalFetched += (result.rows_inserted + result.rows_updated);
      } else {
        console.error(`❌ Failed to backfill ${pair.poolName} - ${pair.assetName}: ${result.error}`);
      }

      console.log('');
    }

    // Final summary
    console.log('='.repeat(60));
    console.log('📊 BACKFILL SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total rows fetched: ${totalFetched}`);
    console.log(`Total rows inserted: ${totalInserted}`);
    console.log(`Total rows updated: ${totalUpdated}`);
    console.log(`Pool-asset combinations processed: ${poolAssetPairs.length}`);

    const stats = await userRepository.getStats();
    console.log('\n📈 Database Stats:');
    console.log(`   Total rows: ${stats.total_rows}`);
    console.log(`   Latest date: ${stats.latest_date}`);
    console.log(`   Unique users: ${stats.unique_users}`);

    console.log('\n✅ Bulk backfill completed successfully!\n');

    return {
      success: true,
      rows_inserted: totalInserted,
      rows_updated: totalUpdated,
      query_id: 0,
    };
  }

  /**
   * Run backfill in all-pools mode (single query for all pools and assets)
   * Maximum optimization - fetches everything in one BigQuery call
   */
  private async runBackfillAllPoolsMode(options: BackfillOptions): Promise<BackfillResult> {
    // Use dynamic discovery to get all pools and assets from Blend SDK
    const discovery = await getPoolAssetPairsFromDiscovery();

    // Group by pool
    const poolsMap = new Map<string, { poolId: string; poolName: string; assets: any[] }>();
    discovery.forEach(pair => {
      if (!poolsMap.has(pair.poolId)) {
        poolsMap.set(pair.poolId, {
          poolId: pair.poolId,
          poolName: pair.poolName,
          assets: []
        });
      }
      poolsMap.get(pair.poolId)!.assets.push({
        reserveIndex: pair.reserveIndex,
        assetAddress: pair.assetAddress,
        assetName: pair.assetName,
      });
    });

    const poolsConfig = Array.from(poolsMap.values());
    const totalAssets = discovery.length;
    console.log(`📊 Fetching ${poolsConfig.length} pools with ${totalAssets} total assets in a SINGLE query\n`);

    try {
      console.log('='.repeat(60));
      console.log(`SINGLE QUERY MODE - Maximum Optimization`);
      console.log('='.repeat(60));

      const result = await this.runBackfillAllPools({
        pools: poolsConfig.map(pool => ({
          poolId: pool.poolId,
          poolName: pool.poolName,
          assetMapping: pool.assets,
        })),
        ...options,
      });

      if (!result.success) {
        console.error(`❌ Failed to backfill: ${result.error}`);
        return result;
      }

      const totalFetched = result.rows_inserted + result.rows_updated;

      // Final summary
      console.log('='.repeat(60));
      console.log('📊 BACKFILL SUMMARY');
      console.log('='.repeat(60));
      console.log(`Total rows fetched: ${totalFetched}`);
      console.log(`Total rows inserted: ${result.rows_inserted}`);
      console.log(`Total rows updated: ${result.rows_updated}`);
      console.log(`Pools processed: ${poolsConfig.length} (in single query)`);
      console.log(`Assets processed: ${totalAssets} (in single query)`);

      const stats = await userRepository.getStats();
      console.log('\n📈 Database Stats:');
      console.log(`   Total rows: ${stats.total_rows}`);
      console.log(`   Latest date: ${stats.latest_date}`);
      console.log(`   Unique users: ${stats.unique_users}`);

      console.log('\n✅ Bulk backfill completed successfully!\n');

      return result;

    } catch (error) {
      console.error('❌ All-pools backfill failed:', error);
      return {
        success: false,
        rows_inserted: 0,
        rows_updated: 0,
        query_id: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Run backfill in all-assets mode (one query per pool for all assets)
   */
  private async runBackfillAllAssetsMode(options: BackfillOptions): Promise<BackfillResult> {
    // Use dynamic discovery to get all pools and assets from Blend SDK
    const discovery = await getPoolAssetPairsFromDiscovery();

    // Group by pool
    const poolsMap = new Map<string, { poolId: string; poolName: string; assets: any[] }>();
    discovery.forEach(pair => {
      if (!poolsMap.has(pair.poolId)) {
        poolsMap.set(pair.poolId, {
          poolId: pair.poolId,
          poolName: pair.poolName,
          assets: []
        });
      }
      poolsMap.get(pair.poolId)!.assets.push({
        reserveIndex: pair.reserveIndex,
        assetAddress: pair.assetAddress,
        assetName: pair.assetName,
      });
    });

    const poolsConfig = Array.from(poolsMap.values());
    console.log(`📊 Found ${poolsConfig.length} pools to backfill\n`);

    let totalInserted = 0;
    let totalUpdated = 0;
    let totalFetched = 0;

    // Process each pool
    for (let i = 0; i < poolsConfig.length; i++) {
      const pool = poolsConfig[i];
      console.log('='.repeat(60));
      console.log(`[${i + 1}/${poolsConfig.length}] Processing: ${pool.poolName} (${pool.assets.length} assets)`);
      console.log('='.repeat(60));

      const result = await this.runBackfillAllAssets({
        poolId: pool.poolId,
        poolName: pool.poolName,
        assetMapping: pool.assets,
        ...options,
      });

      if (result.success) {
        totalInserted += result.rows_inserted;
        totalUpdated += result.rows_updated;
        totalFetched += (result.rows_inserted + result.rows_updated);
      } else {
        console.error(`❌ Failed to backfill ${pool.poolName}: ${result.error}`);
      }

      console.log('');
    }

    // Final summary
    console.log('='.repeat(60));
    console.log('📊 BACKFILL SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total rows fetched: ${totalFetched}`);
    console.log(`Total rows inserted: ${totalInserted}`);
    console.log(`Total rows updated: ${totalUpdated}`);
    console.log(`Pools processed: ${poolsConfig.length}`);

    const stats = await userRepository.getStats();
    console.log('\n📈 Database Stats:');
    console.log(`   Total rows: ${stats.total_rows}`);
    console.log(`   Latest date: ${stats.latest_date}`);
    console.log(`   Unique users: ${stats.unique_users}`);

    console.log('\n✅ Bulk backfill completed successfully!\n');

    return {
      success: true,
      rows_inserted: totalInserted,
      rows_updated: totalUpdated,
      query_id: 0,
    };
  }

  /**
   * Run user positions backfill from BigQuery for a single pool-asset combination
   */
  async runBackfillSingle(params: QueryParams): Promise<BackfillResult> {
    try {
      console.log('Step 1: Checking query cost...');
      let estimate;
      try {
        estimate = await bigQueryClient.getQueryCostEstimate(params);
        console.log(`✓ Estimated cost: $${estimate.cost} (${estimate.gb} GB)`);
        console.log('  (First 1TB per month is free)\n');
      } catch (error) {
        console.log('⚠️  Could not estimate cost, continuing anyway...\n');
      }

      // Ask for confirmation before proceeding (unless skipConfirmation is true)
      if (estimate && !params.skipConfirmation) {
        const costNumber = parseFloat(estimate.cost);
        const gbNumber = parseFloat(estimate.gb);

        // Show warning for large queries
        if (gbNumber > 100) {
          console.log(`⚠️  WARNING: This query will scan ${estimate.gb} GB of data`);
        }
        if (costNumber > 1) {
          console.log(`⚠️  WARNING: Estimated cost is $${estimate.cost}`);
        }

        const proceed = await confirm('Do you want to proceed with this query?');

        if (!proceed) {
          console.log('❌ Query cancelled by user\n');
          return {
            success: false,
            rows_inserted: 0,
            rows_updated: 0,
            query_id: 0,
            error: 'Query cancelled by user',
          };
        }
        console.log('');
      } else if (estimate && params.skipConfirmation) {
        console.log('Auto-proceeding (confirmation skipped via --yes flag)\n');
      }

      // Step 2: Fetch from BigQuery
      console.log('Step 2: Fetching data from BigQuery...');
      console.log(`   Pool ID: ${params.poolId}`);
      console.log(`   Asset: ${params.assetAddress}`);
      console.log(`   Reserve Index: ${params.reserveIndex}`);
      if (params.daysBack) console.log(`   Days Back: ${params.daysBack}`);
      if (params.startDate) console.log(`   Start Date: ${params.startDate}`);
      if (params.endDate) console.log(`   End Date: ${params.endDate}`);
      if (params.startLedger) console.log(`   Start Ledger: ${params.startLedger}`);
      if (params.endLedger) console.log(`   End Ledger: ${params.endLedger}`);
      if (params.targetUser) console.log(`   Target User: ${params.targetUser}`);

      const rows = await bigQueryClient.fetchQueryResults<any>(params);

      if (rows.length === 0) {
        console.log('⚠️  No data returned from BigQuery');
        console.log('   This could mean:');
        console.log('   • No data exists for this pool/asset combination');
        console.log('   • The date/ledger range has no data');
        console.log('   • Pool ID or asset address may be incorrect');
        console.log('   • Reserve index may not match the pool structure');
        return {
          success: true,
          rows_inserted: 0,
          rows_updated: 0,
          query_id: 0,
        };
      }

      console.log(`✓ Fetched ${rows.length} rows from BigQuery\n`);

      // Step 3: Validate and transform data
      console.log('Step 3: Validating data...');
      console.log(`   Sample raw row:`, rows[0] ? JSON.stringify(rows[0], null, 2) : 'N/A');
      const validRows = this.validateAndTransform(rows);
      console.log(`✓ ${validRows.length} valid rows (${rows.length - validRows.length} skipped)`);
      if (validRows.length > 0) {
        console.log(`   Sample valid row:`, JSON.stringify(validRows[0], null, 2));
      }
      console.log('');

      if (validRows.length === 0) {
        console.log('❌ No valid rows to insert');
        return {
          success: false,
          rows_inserted: 0,
          rows_updated: 0,
          query_id: 0,
          error: 'No valid rows after validation',
        };
      }

      // Step 4: Insert into database
      console.log('Step 4: Inserting into database...');
      const result = await userRepository.insertBatch(validRows);
      console.log(`✓ Inserted ${result.inserted} rows, updated ${result.updated} rows`);

      return {
        success: true,
        rows_inserted: result.inserted,
        rows_updated: result.updated,
        query_id: 0,
      };

    } catch (error) {
      console.error('❌ Backfill failed:', error);
      return {
        success: false,
        rows_inserted: 0,
        rows_updated: 0,
        query_id: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Run backfill for all assets of a pool in a single query
   */
  async runBackfillAllAssets(
    params: AllAssetsQueryParams & {
      poolName: string;
      assetMapping?: Array<{ reserveIndex: number; assetAddress: string; assetName: string }>; // For logging only
    }
  ): Promise<BackfillResult> {
    try {
      console.log('Step 1: Checking query cost...');
      let estimate;
      try {
        estimate = await bigQueryClient.getAllAssetsQueryCostEstimate(params);
        console.log(`✓ Estimated cost: $${estimate.cost} (${estimate.gb} GB)`);
        console.log('  (First 1TB per month is free)\n');
      } catch (error) {
        console.log('⚠️  Could not estimate cost, continuing anyway...\n');
      }

      // Ask for confirmation before proceeding (unless skipConfirmation is true)
      if (estimate && !params.skipConfirmation) {
        const costNumber = parseFloat(estimate.cost);
        const gbNumber = parseFloat(estimate.gb);

        // Show warning for large queries
        if (gbNumber > 100) {
          console.log(`⚠️  WARNING: This query will scan ${estimate.gb} GB of data`);
        }
        if (costNumber > 1) {
          console.log(`⚠️  WARNING: Estimated cost is $${estimate.cost}`);
        }

        const assetNames = params.assetMapping ? params.assetMapping.map(a => a.assetName).join(', ') : 'all assets (discovering from blockchain)';
        const proceed = await confirm(
          `Fetch ${assetNames} for ${params.poolName}?`
        );

        if (!proceed) {
          console.log('❌ Query cancelled by user\n');
          return {
            success: false,
            rows_inserted: 0,
            rows_updated: 0,
            query_id: 0,
            error: 'Query cancelled by user',
          };
        }
        console.log('');
      } else if (estimate && params.skipConfirmation) {
        console.log('Auto-proceeding (confirmation skipped via --yes flag)\n');
      }

      // Step 2: Fetch from BigQuery
      console.log('Step 2: Fetching data from BigQuery (all assets mode - discovering indices from blockchain)...');
      console.log(`   Pool ID: ${params.poolId}`);
      console.log(`   Pool Name: ${params.poolName}`);
      console.log(`   Assets: ${params.assetMapping ? params.assetMapping.map(a => a.assetName).join(', ') : 'Discovering from blockchain ResConfig (indices 0-15)'}`);
      if (params.daysBack) console.log(`   Days Back: ${params.daysBack}`);
      if (params.startDate) console.log(`   Start Date: ${params.startDate}`);
      if (params.endDate) console.log(`   End Date: ${params.endDate}`);
      if (params.startLedger) console.log(`   Start Ledger: ${params.startLedger}`);
      if (params.endLedger) console.log(`   End Ledger: ${params.endLedger}`);
      if (params.targetUser) console.log(`   Target User: ${params.targetUser}`);

      const rows = await bigQueryClient.fetchAllAssetsForPool<any>(params);

      if (rows.length === 0) {
        console.log('⚠️  No data returned from BigQuery');
        console.log('   This could mean:');
        console.log('   • No data exists for this pool');
        console.log('   • The date/ledger range has no data');
        console.log('   • Pool ID may be incorrect');
        return {
          success: true,
          rows_inserted: 0,
          rows_updated: 0,
          query_id: 0,
        };
      }

      console.log(`✓ Fetched ${rows.length} rows from BigQuery\n`);

      // Step 3: Validate and transform data
      console.log('Step 3: Validating data...');
      console.log(`   Sample raw row:`, rows[0] ? JSON.stringify(rows[0], null, 2) : 'N/A');
      const validRows = this.validateAndTransform(rows);
      console.log(`✓ ${validRows.length} valid rows (${rows.length - validRows.length} skipped)`);
      if (validRows.length > 0) {
        console.log(`   Sample valid row:`, JSON.stringify(validRows[0], null, 2));
      }
      console.log('');

      if (validRows.length === 0) {
        console.log('❌ No valid rows to insert');
        return {
          success: false,
          rows_inserted: 0,
          rows_updated: 0,
          query_id: 0,
          error: 'No valid rows after validation',
        };
      }

      // Step 4: Insert into database
      console.log('Step 4: Inserting into database...');
      const result = await userRepository.insertBatch(validRows);
      console.log(`✓ Inserted ${result.inserted} rows, updated ${result.updated} rows`);

      // Show breakdown by asset
      const assetBreakdown = new Map<string, number>();
      validRows.forEach(row => {
        const count = assetBreakdown.get(row.asset_address) || 0;
        assetBreakdown.set(row.asset_address, count + 1);
      });

      console.log('\n📊 Breakdown by asset:');
      if (params.assetMapping) {
        params.assetMapping.forEach(asset => {
          const count = assetBreakdown.get(asset.assetAddress) || 0;
          console.log(`   ${asset.assetName}: ${count} rows`);
        });
      } else {
        // Group by asset address when assetMapping is not available
        assetBreakdown.forEach((count, address) => {
          console.log(`   ${address.substring(0, 8)}...: ${count} rows`);
        });
      }

      return {
        success: true,
        rows_inserted: result.inserted,
        rows_updated: result.updated,
        query_id: 0,
      };

    } catch (error) {
      console.error('❌ Backfill failed:', error);
      return {
        success: false,
        rows_inserted: 0,
        rows_updated: 0,
        query_id: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Run backfill for all pools in a single query (maximum optimization)
   */
  async runBackfillAllPools(params: AllPoolsQueryParams): Promise<BackfillResult> {
    try {
      console.log('Step 1: Checking query cost (OPTIMIZED approach)...');
      let estimate;
      try {
        const poolIds = params.pools.map(p => p.poolId);
        const optimizedEstimate = await bigQueryClientOptimized.getAllPoolsCostEstimate({
          poolIds,
          daysBack: params.daysBack,
          startDate: params.startDate,
          endDate: params.endDate,
          startLedger: params.startLedger,
          endLedger: params.endLedger,
          targetUser: params.targetUser,
        });

        estimate = {
          bytes: optimizedEstimate.total.bytes,
          gb: optimizedEstimate.total.gb,
          cost: optimizedEstimate.total.cost,
        };

        console.log(`✓ Estimated cost: $${estimate.cost} (${estimate.gb} GB) - OPTIMIZED 35% cheaper!`);
        console.log('  (First 1TB per month is free)\n');
      } catch (error) {
        console.log('⚠️  Could not estimate cost, continuing anyway...\n');
      }

      // Ask for confirmation before proceeding (unless skipConfirmation is true)
      if (estimate && !params.skipConfirmation) {
        const costNumber = parseFloat(estimate.cost);
        const gbNumber = parseFloat(estimate.gb);

        // Show warning for large queries
        if (gbNumber > 100) {
          console.log(`⚠️  WARNING: This query will scan ${estimate.gb} GB of data`);
        }
        if (costNumber > 1) {
          console.log(`⚠️  WARNING: Estimated cost is $${estimate.cost}`);
        }

        const proceed = await confirm(
          `Fetch ALL ${params.pools.length} pools in a single query?`
        );

        if (!proceed) {
          console.log('❌ Query cancelled by user\n');
          return {
            success: false,
            rows_inserted: 0,
            rows_updated: 0,
            query_id: 0,
            error: 'Query cancelled by user',
          };
        }
        console.log('');
      } else if (estimate && params.skipConfirmation) {
        console.log('Auto-proceeding (confirmation skipped via --yes flag)\n');
      }

      // Step 2: Fetch from BigQuery using OPTIMIZED approach
      console.log('Step 2: Fetching data from BigQuery (OPTIMIZED two-step approach)...');
      console.log(`   Pools: ${params.pools.length}`);
      const totalAssets = params.pools.reduce((sum, p) => sum + (p.assetMapping?.length || 0), 0);
      console.log(`   Total Assets: ${totalAssets > 0 ? totalAssets : 'Discovering from blockchain ResConfig'}`);
      if (params.daysBack) console.log(`   Days Back: ${params.daysBack}`);
      if (params.startDate) console.log(`   Start Date: ${params.startDate}`);
      if (params.endDate) console.log(`   End Date: ${params.endDate}`);
      if (params.startLedger) console.log(`   Start Ledger: ${params.startLedger}`);
      if (params.endLedger) console.log(`   End Ledger: ${params.endLedger}`);
      if (params.targetUser) console.log(`   Target User: ${params.targetUser}`);

      const poolIds = params.pools.map(p => p.poolId);
      const rows = await bigQueryClientOptimized.fetchAllPoolsOptimized({
        poolIds,
        daysBack: params.daysBack,
        startDate: params.startDate,
        endDate: params.endDate,
        startLedger: params.startLedger,
        endLedger: params.endLedger,
        targetUser: params.targetUser,
      });

      if (rows.length === 0) {
        console.log('⚠️  No data returned from BigQuery');
        console.log('   This could mean:');
        console.log('   • No data exists for these pools');
        console.log('   • The date/ledger range has no data');
        console.log('   • Pool IDs may be incorrect');
        return {
          success: true,
          rows_inserted: 0,
          rows_updated: 0,
          query_id: 0,
        };
      }

      console.log(`✓ Fetched ${rows.length} rows from BigQuery\n`);

      // Step 3: Validate and transform data
      console.log('Step 3: Validating data...');
      console.log(`   Sample raw row:`, rows[0] ? JSON.stringify(rows[0], null, 2) : 'N/A');
      const validRows = this.validateAndTransform(rows);
      console.log(`✓ ${validRows.length} valid rows (${rows.length - validRows.length} skipped)`);
      if (validRows.length > 0) {
        console.log(`   Sample valid row:`, JSON.stringify(validRows[0], null, 2));
      }
      console.log('');

      if (validRows.length === 0) {
        console.log('❌ No valid rows to insert');
        return {
          success: false,
          rows_inserted: 0,
          rows_updated: 0,
          query_id: 0,
          error: 'No valid rows after validation',
        };
      }

      // Step 4: Insert into database
      console.log('Step 4: Inserting into database...');
      const result = await userRepository.insertBatch(validRows);
      console.log(`✓ Inserted ${result.inserted} rows, updated ${result.updated} rows`);

      // Show breakdown by pool
      const poolBreakdown = new Map<string, number>();
      validRows.forEach(row => {
        const count = poolBreakdown.get(row.pool_id) || 0;
        poolBreakdown.set(row.pool_id, count + 1);
      });

      console.log('\n📊 Breakdown by pool:');
      params.pools.forEach(pool => {
        const count = poolBreakdown.get(pool.poolId) || 0;
        console.log(`   ${pool.poolName}: ${count} rows`);
      });

      return {
        success: true,
        rows_inserted: result.inserted,
        rows_updated: result.updated,
        query_id: 0,
      };

    } catch (error) {
      console.error('❌ Backfill failed:', error);
      return {
        success: false,
        rows_inserted: 0,
        rows_updated: 0,
        query_id: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Validate and transform rows from BigQuery
   * Maps BigQuery column names to expected UserPositionRow format
   */
  private validateAndTransform(rows: any[]): UserPositionRow[] {
    const validRows: UserPositionRow[] = [];
    const errors: string[] = [];

    for (const row of rows) {
      try {
        // Basic validation
        if (!row.pool_id || !row.user_address || !row.asset_address) {
          errors.push('Missing pool_id, user_address, or asset_address');
          continue;
        }

        if (!row.snapshot_date) {
          errors.push('Missing snapshot_date');
          continue;
        }

        // Transform BigQuery row to UserPositionRow
        const transformedRow: UserPositionRow = {
          pool_id: row.pool_id,
          user_address: row.user_address,
          asset_address: row.asset_address,
          snapshot_date: this.formatDate(row.snapshot_date),
          snapshot_timestamp: this.formatTimestamp(row.snapshot_timestamp),
          ledger_sequence: parseInt(row.ledger_sequence),
          entry_hash: row.entry_hash,
          ledger_entry_change: parseInt(row.ledger_entry_change),
          supply_btokens: parseFloat(row.supply_btokens) || 0,
          collateral_btokens: parseFloat(row.collateral_btokens) || 0,
          liabilities_dtokens: parseFloat(row.liabilities_dtokens) || 0,
          b_rate: row.b_rate != null ? parseFloat(row.b_rate) : undefined,
          d_rate: row.d_rate != null ? parseFloat(row.d_rate) : undefined,
        };

        // Ensure numeric fields are valid (allow 0 values)
        if (
          typeof transformedRow.supply_btokens !== 'number' ||
          typeof transformedRow.collateral_btokens !== 'number' ||
          typeof transformedRow.liabilities_dtokens !== 'number' ||
          isNaN(transformedRow.supply_btokens) ||
          isNaN(transformedRow.collateral_btokens) ||
          isNaN(transformedRow.liabilities_dtokens)
        ) {
          errors.push('Invalid position values');
          continue;
        }

        validRows.push(transformedRow);

      } catch (error) {
        errors.push(`Validation error: ${error}`);
      }
    }

    if (errors.length > 0) {
      console.log(`⚠️  Validation warnings: ${errors.length} rows skipped`);
      if (errors.length <= 5) {
        errors.forEach(err => console.log(`   - ${err}`));
      }
    }

    return validRows;
  }

  /**
   * Format date from BigQuery to YYYY-MM-DD string
   */
  private formatDate(date: any): string {
    if (typeof date === 'string') {
      return date.split('T')[0]; // Handle ISO string
    }
    if (date instanceof Date) {
      return date.toISOString().split('T')[0];
    }
    if (date && date.value) {
      // Handle BigQuery Date object - extract just the date part
      if (typeof date.value === 'string') {
        return date.value.split('T')[0];
      }
      return date.value;
    }
    return String(date);
  }

  /**
   * Format timestamp from BigQuery to ISO string
   */
  private formatTimestamp(timestamp: any): string {
    if (typeof timestamp === 'string') {
      return timestamp; // Already a string
    }
    if (timestamp instanceof Date) {
      return timestamp.toISOString();
    }
    if (timestamp && timestamp.value) {
      // Handle BigQuery Timestamp object
      if (typeof timestamp.value === 'string') {
        return timestamp.value;
      }
      if (timestamp.value instanceof Date) {
        return timestamp.value.toISOString();
      }
    }
    // Try to create a Date from whatever we have
    try {
      return new Date(timestamp).toISOString();
    } catch {
      return String(timestamp);
    }
  }
}

export const bigQueryBackfillService = new BigQueryBackfillService();
