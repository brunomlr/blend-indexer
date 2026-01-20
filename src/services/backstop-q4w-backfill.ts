/**
 * Backstop Q4W Percentage Backfill Service
 *
 * Imports historical backstop pool balance data (shares, tokens, q4w)
 * from Hubble BigQuery contract_data table.
 *
 * Q4W percentage = (q4w / shares) * 100
 */

import { BigQuery } from '@google-cloud/bigquery';
import dotenv from 'dotenv';
import path from 'path';
import { backstopPoolSnapshotRepository } from '../repositories/backstop-pool-snapshot-repository';
import { BackstopPoolSnapshotRow } from '../types';
import { confirm } from '../utils/prompt';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;

// Backstop contract address
const BACKSTOP_CONTRACT = 'CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7';

// Default start date (Blend v2 launch)
const DEFAULT_START_DATE = '2025-04-14';

export interface BackstopQ4wBackfillParams {
  startDate?: string;
  endDate?: string;
  poolAddress?: string;  // Optional: filter to specific pool
  limit?: number;
  skipConfirmation?: boolean;
}

export interface BackstopQ4wBackfillResult {
  success: boolean;
  rows_fetched: number;
  rows_inserted: number;
  rows_updated: number;
  estimated_cost?: string;
  error?: string;
}

export interface CostEstimate {
  bytes: number;
  gb: string;
  cost: string;
  query: string;
}

export class BackstopQ4wBackfillService {
  private client: BigQuery;

  constructor() {
    const options: any = {};

    if (GOOGLE_CLOUD_PROJECT) {
      options.projectId = GOOGLE_CLOUD_PROJECT;
    }

    if (GOOGLE_APPLICATION_CREDENTIALS) {
      options.keyFilename = GOOGLE_APPLICATION_CREDENTIALS;
    }

    this.client = new BigQuery(options);
    console.log('✓ Backstop Q4W Backfill service initialized');
  }

  /**
   * Build the BigQuery query for fetching backstop pool balance data
   */
  getBigQueryQuery(params: BackstopQ4wBackfillParams): string {
    const startDate = params.startDate || DEFAULT_START_DATE;
    const endDate = params.endDate;
    const poolAddress = params.poolAddress;
    const limit = params.limit;

    // Build date filter
    let dateFilter = `AND closed_at >= '${startDate}'`;
    if (endDate) {
      dateFilter += `\n    AND closed_at < '${endDate}'`;
    }

    // Build pool filter
    let poolFilter = '';
    if (poolAddress) {
      poolFilter = `\n    AND JSON_EXTRACT_SCALAR(key_decoded, '$.vec[1].address') = '${poolAddress}'`;
    }

    // Build limit clause
    const limitClause = limit ? `\nLIMIT ${limit}` : '';

    return `
WITH daily_snapshots AS (
  SELECT
    DATE(closed_at) as snapshot_date,
    closed_at,
    ledger_sequence,
    JSON_EXTRACT_SCALAR(key_decoded, '$.vec[1].address') as pool_address,
    -- Map is alphabetically ordered: q4w, shares, tokens
    CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.map[0].val.i128') AS NUMERIC) as q4w,
    CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.map[1].val.i128') AS NUMERIC) as shares,
    CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.map[2].val.i128') AS NUMERIC) as tokens,
    ROW_NUMBER() OVER (
      PARTITION BY
        DATE(closed_at),
        JSON_EXTRACT_SCALAR(key_decoded, '$.vec[1].address')
      ORDER BY ledger_sequence DESC
    ) as rn
  FROM \`crypto-stellar.crypto_stellar.contract_data\`
  WHERE contract_id = '${BACKSTOP_CONTRACT}'
    AND JSON_EXTRACT_SCALAR(key_decoded, '$.vec[0].symbol') = 'PoolBalance'
    ${dateFilter}${poolFilter}
)
SELECT
  pool_address,
  snapshot_date,
  closed_at as snapshot_timestamp,
  ledger_sequence,
  shares,
  tokens,
  q4w,
  CASE
    WHEN shares > 0 THEN ROUND((q4w * 100.0 / shares), 4)
    ELSE 0
  END as q4w_pct
FROM daily_snapshots
WHERE rn = 1
ORDER BY pool_address, snapshot_date${limitClause}
    `.trim();
  }

  /**
   * Get cost estimate for a BigQuery query
   */
  async getCostEstimate(params: BackstopQ4wBackfillParams): Promise<CostEstimate> {
    const query = this.getBigQueryQuery(params);

    console.log('📊 Getting cost estimate for backstop Q4W backfill...');
    console.log(`   Date range: ${params.startDate || DEFAULT_START_DATE} to ${params.endDate || 'now'}`);
    if (params.poolAddress) {
      console.log(`   Pool filter: ${params.poolAddress}`);
    }

    const [job] = await this.client.createQueryJob({
      query,
      useLegacySql: false,
      dryRun: true,
      location: 'US',
    });

    const estimatedBytes = parseInt(job.metadata?.statistics?.totalBytesProcessed || '0');
    const estimatedGB = (estimatedBytes / (1024 ** 3)).toFixed(2);
    const estimatedCost = (estimatedBytes / (1024 ** 4) * 5).toFixed(4);

    console.log(`✓ Estimated: ${estimatedGB} GB = $${estimatedCost}`);

    return {
      bytes: estimatedBytes,
      gb: estimatedGB,
      cost: estimatedCost,
      query,
    };
  }

  /**
   * Simulate the backfill - fetch data without saving
   */
  async simulate(params: BackstopQ4wBackfillParams): Promise<{
    success: boolean;
    rows: any[];
    estimated_cost: string;
    query: string;
    error?: string;
  }> {
    try {
      console.log('\n🔍 Simulating backstop Q4W backfill (dry run)...');

      // Get cost estimate first
      const estimate = await this.getCostEstimate(params);

      // Apply a limit for simulation if not specified
      const simulationParams = {
        ...params,
        limit: params.limit || 100,
      };

      const query = this.getBigQueryQuery(simulationParams);

      console.log('Executing simulation query...');
      const [rows] = await this.client.query({
        query,
        useLegacySql: false,
        location: 'US',
        jobTimeoutMs: 300000,
      });

      console.log(`✓ Fetched ${rows.length} sample rows\n`);

      // Show sample data
      if (rows.length > 0) {
        console.log('Sample rows:');
        rows.slice(0, 5).forEach((row: any, idx: number) => {
          const poolShort = row.pool_address?.substring(0, 12) || 'unknown';
          console.log(`  [${idx + 1}] ${row.snapshot_date?.value || row.snapshot_date} | ${poolShort}... | Q4W: ${row.q4w_pct}%`);
        });
        if (rows.length > 5) {
          console.log(`  ... and ${rows.length - 5} more rows`);
        }
      }

      return {
        success: true,
        rows: rows as any[],
        estimated_cost: estimate.cost,
        query: estimate.query,
      };

    } catch (error) {
      console.error('❌ Simulation failed:', error);
      return {
        success: false,
        rows: [],
        estimated_cost: '0',
        query: '',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Run the full backfill - fetch and save to database
   */
  async runBackfill(params: BackstopQ4wBackfillParams): Promise<BackstopQ4wBackfillResult> {
    try {
      console.log('\n🔄 Starting backstop Q4W backfill from BigQuery...');

      const startDate = params.startDate || DEFAULT_START_DATE;
      const endDate = params.endDate;

      console.log(`Date range: ${startDate} to ${endDate || 'now'}`);
      if (params.poolAddress) {
        console.log(`Pool filter: ${params.poolAddress}`);
      }
      if (params.limit) {
        console.log(`Limit: ${params.limit} rows`);
      }

      // Step 1: Get cost estimate
      console.log('\nStep 1: Getting cost estimate...');
      const estimate = await this.getCostEstimate(params);
      console.log(`Estimated cost: $${estimate.cost} (${estimate.gb} GB)`);

      // Ask for confirmation unless skipped
      if (!params.skipConfirmation) {
        const costNumber = parseFloat(estimate.cost);
        const gbNumber = parseFloat(estimate.gb);

        if (gbNumber > 100) {
          console.log(`\n⚠️  WARNING: This query will scan ${estimate.gb} GB of data`);
        }
        if (costNumber > 1) {
          console.log(`⚠️  WARNING: Estimated cost is $${estimate.cost}`);
        }

        const proceed = await confirm('Do you want to proceed with this backfill?');
        if (!proceed) {
          console.log('❌ Backfill cancelled by user');
          return {
            success: false,
            rows_fetched: 0,
            rows_inserted: 0,
            rows_updated: 0,
            error: 'Cancelled by user',
          };
        }
      }

      // Step 2: Execute query
      console.log('\nStep 2: Fetching data from BigQuery...');
      const query = this.getBigQueryQuery(params);

      const [rows] = await this.client.query({
        query,
        useLegacySql: false,
        location: 'US',
        jobTimeoutMs: 600000,
      });

      console.log(`✓ Fetched ${rows.length} rows from BigQuery`);

      if (rows.length === 0) {
        console.log('⚠️  No data found matching the criteria');
        return {
          success: true,
          rows_fetched: 0,
          rows_inserted: 0,
          rows_updated: 0,
          estimated_cost: estimate.cost,
        };
      }

      // Step 3: Transform and validate
      console.log('\nStep 3: Validating and transforming data...');
      const validRows = this.transformRows(rows as any[]);
      console.log(`✓ ${validRows.length} valid rows (${rows.length - validRows.length} skipped)`);

      if (validRows.length === 0) {
        return {
          success: false,
          rows_fetched: rows.length,
          rows_inserted: 0,
          rows_updated: 0,
          error: 'No valid rows after transformation',
          estimated_cost: estimate.cost,
        };
      }

      // Step 4: Insert into database in batches
      console.log('\nStep 4: Inserting into database...');
      const BATCH_SIZE = 500;
      let totalInserted = 0;
      let totalUpdated = 0;

      for (let i = 0; i < validRows.length; i += BATCH_SIZE) {
        const batch = validRows.slice(i, i + BATCH_SIZE);
        const result = await backstopPoolSnapshotRepository.insertBatch(batch);
        totalInserted += result.inserted;
        totalUpdated += result.updated;

        if (validRows.length > BATCH_SIZE) {
          console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${result.inserted} inserted, ${result.updated} updated`);
        }
      }

      console.log(`✓ Inserted ${totalInserted} rows, updated ${totalUpdated} rows`);

      // Step 5: Show stats
      const stats = await backstopPoolSnapshotRepository.getStats();
      console.log('\n📊 Database Stats:');
      console.log(`   Total rows: ${stats.total_rows}`);
      console.log(`   Date range: ${stats.earliest_date} to ${stats.latest_date}`);
      console.log(`   Unique pools: ${stats.unique_pools}`);

      console.log('\n✅ Backstop Q4W backfill completed successfully!\n');

      return {
        success: true,
        rows_fetched: rows.length,
        rows_inserted: totalInserted,
        rows_updated: totalUpdated,
        estimated_cost: estimate.cost,
      };

    } catch (error) {
      console.error('❌ Backfill failed:', error);
      return {
        success: false,
        rows_fetched: 0,
        rows_inserted: 0,
        rows_updated: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Transform BigQuery rows to BackstopPoolSnapshotRow format
   */
  private transformRows(rows: any[]): BackstopPoolSnapshotRow[] {
    const validRows: BackstopPoolSnapshotRow[] = [];
    const errors: string[] = [];

    for (const row of rows) {
      try {
        // Basic validation
        if (!row.pool_address) {
          errors.push(`Missing pool_address`);
          continue;
        }

        // Handle BigQuery date/timestamp objects
        const snapshotDate = row.snapshot_date?.value || row.snapshot_date;
        const snapshotTimestamp = row.snapshot_timestamp?.value || row.snapshot_timestamp;

        // Normalize date format
        let dateStr = snapshotDate;
        if (typeof dateStr === 'string' && dateStr.includes('T')) {
          dateStr = dateStr.split('T')[0];
        }

        const transformedRow: BackstopPoolSnapshotRow = {
          pool_address: row.pool_address,
          snapshot_date: dateStr,
          snapshot_timestamp: snapshotTimestamp,
          ledger_sequence: parseInt(row.ledger_sequence),
          shares: row.shares?.toString() || '0',
          tokens: row.tokens?.toString() || '0',
          q4w: row.q4w?.toString() || '0',
          q4w_pct: parseFloat(row.q4w_pct) || 0,
          src: 'bq',
        };

        validRows.push(transformedRow);

      } catch (error) {
        errors.push(`Transform error: ${error}`);
      }
    }

    if (errors.length > 0 && errors.length <= 5) {
      console.log(`⚠️  Validation warnings: ${errors.length} rows skipped`);
      errors.forEach(err => console.log(`   - ${err}`));
    } else if (errors.length > 5) {
      console.log(`⚠️  Validation warnings: ${errors.length} rows skipped (showing first 5)`);
      errors.slice(0, 5).forEach(err => console.log(`   - ${err}`));
    }

    return validRows;
  }

  /**
   * Get current database stats
   */
  async getStats() {
    return backstopPoolSnapshotRepository.getStats();
  }

  /**
   * Get backstop contract address
   */
  getBackstopContract(): string {
    return BACKSTOP_CONTRACT;
  }
}

export const backstopQ4wBackfillService = new BackstopQ4wBackfillService();
