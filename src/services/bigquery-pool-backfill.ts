import { bigQueryClient, PoolSnapshotQueryParams } from './bigquery-client';
import { poolRepository } from '../repositories/pool-repository';
import { PoolSnapshotRow, BackfillResult } from '../types';
import { confirm } from '../utils/prompt';
import { discoverAllPoolAssets } from '../lib/blend/discovery';

export interface PoolBackfillOptions {
  poolId: string;
  daysBack?: number;
  startDate?: string;
  endDate?: string;
  skipConfirmation?: boolean;
}

export class BigQueryPoolBackfillService {
  /**
   * Run pool snapshots backfill from BigQuery for a single pool
   */
  async runBackfillSingle(options: PoolBackfillOptions): Promise<BackfillResult> {
    try {
      console.log('\n🔄 Starting pool snapshots backfill from BigQuery...');
      console.log(`Pool ID: ${options.poolId}`);

      if (options.startDate && options.endDate) {
        console.log(`Date Range: ${options.startDate} to ${options.endDate}`);
      } else if (options.startDate) {
        console.log(`Start Date: ${options.startDate}`);
      } else if (options.endDate) {
        console.log(`End Date: ${options.endDate}`);
      } else {
        console.log(`Days Back: ${options.daysBack || 90}`);
      }
      console.log('');

      const params: PoolSnapshotQueryParams = {
        poolId: options.poolId,
        daysBack: options.daysBack,
        startDate: options.startDate,
        endDate: options.endDate,
        skipConfirmation: options.skipConfirmation,
      };

      // Step 1: Check query cost
      console.log('Step 1: Checking query cost...');
      let estimate;
      try {
        estimate = await bigQueryClient.getPoolSnapshotsCostEstimate(params);
        console.log(`✓ Estimated cost: $${estimate.cost} (${estimate.gb} GB)`);
        console.log('  (First 1TB per month is free)\n');
      } catch (error) {
        console.log('⚠️  Could not estimate cost, continuing anyway...\n');
      }

      // Ask for confirmation before proceeding (unless skipConfirmation is true)
      if (estimate && !options.skipConfirmation) {
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
      } else if (estimate && options.skipConfirmation) {
        console.log('Auto-proceeding (confirmation skipped via --yes flag)\n');
      }

      // Step 2: Fetch from BigQuery
      console.log('Step 2: Fetching pool snapshots from BigQuery...');
      const rows = await bigQueryClient.fetchPoolSnapshots<any>(params);

      if (rows.length === 0) {
        console.log('⚠️  No data returned from BigQuery');
        console.log('   This could mean:');
        console.log('   • No data exists for this pool');
        console.log('   • The date range has no data');
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
      const result = await poolRepository.insertBatch(validRows);
      console.log(`✓ Inserted ${result.inserted} rows, updated ${result.updated} rows`);

      // Step 5: Show summary
      const stats = await poolRepository.getStats();
      console.log('\n📊 Pool Snapshots Stats:');
      console.log(`   Total rows: ${stats.total_rows}`);
      console.log(`   Latest date: ${stats.latest_date}`);
      console.log(`   Unique assets: ${stats.unique_assets}`);

      console.log('\n✅ Pool snapshots backfill completed successfully!\n');

      return {
        success: true,
        rows_inserted: result.inserted,
        rows_updated: result.updated,
        query_id: 0,
      };

    } catch (error) {
      console.error('❌ Pool snapshots backfill failed:', error);
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
   * Maps BigQuery column names to expected PoolSnapshotRow format
   */
  private validateAndTransform(rows: any[]): PoolSnapshotRow[] {
    const validRows: PoolSnapshotRow[] = [];
    const errors: string[] = [];

    for (const row of rows) {
      try {
        // Basic validation
        if (!row.pool_id || !row.asset_address) {
          errors.push('Missing pool_id or asset_address');
          continue;
        }

        if (!row.snapshot_date) {
          errors.push('Missing snapshot_date');
          continue;
        }

        // Transform BigQuery row to PoolSnapshotRow
        const transformedRow: PoolSnapshotRow = {
          pool_id: row.pool_id,
          asset_address: row.asset_address,
          snapshot_date: this.formatDate(row.snapshot_date),
          snapshot_timestamp: this.formatTimestamp(row.snapshot_timestamp),
          ledger_sequence: parseInt(row.ledger_sequence),
          b_rate: parseFloat(row.b_rate),
          d_rate: parseFloat(row.d_rate),
          b_supply: parseFloat(row.b_supply) || 0,
          d_supply: parseFloat(row.d_supply) || 0,
          last_time: row.last_time ? parseInt(row.last_time) : undefined,
        };

        // Ensure numeric fields are valid
        if (
          typeof transformedRow.b_rate !== 'number' ||
          typeof transformedRow.d_rate !== 'number' ||
          isNaN(transformedRow.b_rate) ||
          isNaN(transformedRow.d_rate)
        ) {
          errors.push('Invalid rate values');
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
      // Handle BigQuery Date object
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

  /**
   * Run pool snapshots backfill for all discovered pools (using single combined query)
   */
  async runBackfillAll(options: {
    daysBack?: number;
    startDate?: string;
    endDate?: string;
    skipConfirmation?: boolean;
  }): Promise<BackfillResult> {
    try {
      console.log('\n🔄 Starting pool snapshots backfill for ALL pools...');
      console.log('Discovering pools...\n');

      // Step 1: Discover all pools
      const discovery = await discoverAllPoolAssets();
      const poolIds = discovery.pools.map(p => p.poolId);

      // Create a map for quick pool name lookups
      const poolNameMap = new Map(discovery.pools.map(p => [p.poolId, p.poolName]));

      console.log(`✓ Found ${poolIds.length} pools`);
      discovery.pools.forEach(pool => {
        console.log(`  - ${pool.poolName}: ${pool.poolId.substring(0, 8)}...`);
      });
      console.log('');

      if (poolIds.length === 0) {
        console.log('⚠️  No pools found');
        return {
          success: false,
          rows_inserted: 0,
          rows_updated: 0,
          query_id: 0,
          error: 'No pools found',
        };
      }

      // Step 2: Check query cost
      console.log('Step 1: Checking query cost...');
      let estimate;
      try {
        estimate = await bigQueryClient.getAllPoolsSnapshotsCostEstimate({
          poolIds,
          daysBack: options.daysBack,
          startDate: options.startDate,
          endDate: options.endDate,
        });
        console.log(`✓ Estimated cost: $${estimate.cost} (${estimate.gb} GB)`);
        console.log('  (First 1TB per month is free)\n');
      } catch (error) {
        console.log('⚠️  Could not estimate cost, continuing anyway...\n');
      }

      // Ask for confirmation before proceeding (unless skipConfirmation is true)
      if (estimate && !options.skipConfirmation) {
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
      } else if (estimate && options.skipConfirmation) {
        console.log('Auto-proceeding (confirmation skipped via --yes flag)\n');
      }

      // Step 3: Fetch from BigQuery (SINGLE QUERY FOR ALL POOLS)
      console.log('Step 2: Fetching pool snapshots from BigQuery (all pools in one query)...');
      const rows = await bigQueryClient.fetchAllPoolsSnapshots<any>({
        poolIds,
        daysBack: options.daysBack,
        startDate: options.startDate,
        endDate: options.endDate,
      });

      if (rows.length === 0) {
        console.log('⚠️  No data returned from BigQuery');
        console.log('   This could mean:');
        console.log('   • No data exists for these pools');
        console.log('   • The date range has no data');
        return {
          success: true,
          rows_inserted: 0,
          rows_updated: 0,
          query_id: 0,
        };
      }

      console.log(`✓ Fetched ${rows.length} rows from BigQuery (all pools)\n`);

      // Step 4: Validate and transform data
      console.log('Step 3: Validating data...');
      console.log(`   Sample raw row:`, rows[0] ? JSON.stringify(rows[0], null, 2) : 'N/A');
      const validRows = this.validateAndTransform(rows);
      console.log(`✓ ${validRows.length} valid rows (${rows.length - validRows.length} skipped)`)
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

      // Step 5: Group rows by pool for per-pool breakdown
      const rowsByPool = new Map<string, PoolSnapshotRow[]>();
      for (const row of validRows) {
        if (!rowsByPool.has(row.pool_id)) {
          rowsByPool.set(row.pool_id, []);
        }
        rowsByPool.get(row.pool_id)!.push(row);
      }

      // Step 6: Insert into database
      console.log('Step 4: Inserting into database...');
      const result = await poolRepository.insertBatch(validRows);
      console.log(`✓ Inserted ${result.inserted} rows, updated ${result.updated} rows`);

      // Step 7: Show per-pool breakdown
      const poolResults: Array<{ poolId: string; poolName: string; inserted: number; updated: number }> = [];
      console.log('\n📊 Per-Pool Breakdown:');
      for (const [poolId, poolRows] of rowsByPool) {
        const poolName = poolNameMap.get(poolId) || 'Unknown';
        console.log(`  ${poolName}: ${poolRows.length} rows`);
        poolResults.push({
          poolId,
          poolName,
          inserted: poolRows.length, // Approximate, actual insert/update split not tracked per pool
          updated: 0,
        });
      }

      // Step 8: Show overall summary
      const stats = await poolRepository.getStats();
      console.log('\n📊 Pool Snapshots Stats:');
      console.log(`   Total rows: ${stats.total_rows}`);
      console.log(`   Latest date: ${stats.latest_date}`);
      console.log(`   Unique assets: ${stats.unique_assets}`);

      console.log('\n✅ All pools backfill completed successfully!\n');

      return {
        success: true,
        rows_inserted: result.inserted,
        rows_updated: result.updated,
        query_id: 0,
        poolResults, // Additional info about each pool
      } as any;

    } catch (error) {
      console.error('❌ All pools backfill failed:', error);
      return {
        success: false,
        rows_inserted: 0,
        rows_updated: 0,
        query_id: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

export const bigQueryPoolBackfillService = new BigQueryPoolBackfillService();
