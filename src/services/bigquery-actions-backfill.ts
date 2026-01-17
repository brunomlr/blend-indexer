import { BigQuery } from '@google-cloud/bigquery';
import dotenv from 'dotenv';
import path from 'path';
import { actionsRepository, BlendActionRow } from '../repositories/actions-repository';
import { confirm } from '../utils/prompt';
import { POOL_IDS } from '../lib/blend/pools';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;

// BigQuery Stellar dataset (public)
const BIGQUERY_PROJECT = 'crypto-stellar';
const BIGQUERY_DATASET = 'crypto_stellar';
const BIGQUERY_TABLE = 'history_contract_events';

// Tracked Blend pools (imported from central config)
const BLEND_POOLS = POOL_IDS;

// Action types to capture
const ACTION_TYPES = [
  // User position actions
  'supply',
  'withdraw',
  'supply_collateral',
  'withdraw_collateral',
  'borrow',
  'repay',
  'claim',
  // Auction events (liquidation, bad_debt, interest)
  // auction_type in topics[1]: 0=liquidation, 1=bad_debt, 2=interest
  'new_auction',
  'fill_auction',
];

export interface ActionsBackfillParams {
  startLedger?: number;
  endLedger?: number;
  startDate?: string;
  endDate?: string;
  limit?: number;
  skipConfirmation?: boolean;
}

export interface ActionsBackfillResult {
  success: boolean;
  rows_fetched: number;
  rows_inserted: number;
  rows_updated: number;
  error?: string;
  estimated_cost?: string;
}

export class BigQueryActionsBackfillService {
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
    console.log('✓ BigQuery Actions Backfill service initialized');
  }

  /**
   * Escape a string value for use in SQL query
   */
  private escapeSqlString(value: string): string {
    return value.replace(/'/g, "''");
  }

  /**
   * Build the query for fetching blend actions from history_contract_events
   */
  private buildQuery(params: ActionsBackfillParams): string {
    const {
      startLedger,
      endLedger,
      startDate,
      endDate,
      limit,
    } = params;

    const poolsInClause = BLEND_POOLS.map(p => `'${this.escapeSqlString(p)}'`).join(', ');
    const actionsInClause = ACTION_TYPES.map(a => `'${a}'`).join(', ');

    // Build WHERE filters
    const filters: string[] = [
      `in_successful_contract_call = TRUE`,
      `contract_id IN (${poolsInClause})`,
      `JSON_VALUE(topics_decoded, '$[0].symbol') IN (${actionsInClause})`,
      `operation_id IS NOT NULL`,  // Filter out malformed records with NULL operation_id
    ];

    // Date filters - use both DATE and TIMESTAMP for optimal partition pruning
    // BigQuery partition pruning works best with DATE comparisons on partitioned columns
    if (startDate && endDate) {
      // DATE filter for partition pruning (inclusive)
      filters.push(`DATE(closed_at) >= DATE('${this.escapeSqlString(startDate)}')`);
      filters.push(`DATE(closed_at) <= DATE('${this.escapeSqlString(endDate)}')`);
    } else if (startDate) {
      filters.push(`DATE(closed_at) >= DATE('${this.escapeSqlString(startDate)}')`);
    } else if (endDate) {
      filters.push(`DATE(closed_at) <= DATE('${this.escapeSqlString(endDate)}')`);
    }

    // Ledger filters
    if (startLedger !== undefined) {
      filters.push(`ledger_sequence >= ${startLedger}`);
    }
    if (endLedger !== undefined) {
      filters.push(`ledger_sequence <= ${endLedger}`);
    }

    const whereClause = filters.map(f => `  ${f}`).join('\n  AND ');

    const limitClause = limit ? `LIMIT ${limit}` : '';

    const query = `
-- CTE to extract parsed values first, then hash them
-- This ensures the hash matches what gets stored in the database
WITH parsed AS (
  SELECT
    transaction_hash,
    ledger_sequence,
    closed_at,
    contract_id AS pool_id,
    JSON_VALUE(topics_decoded, '$[0].symbol') AS action_type,
    -- Asset address (NULL for auction events)
    CASE
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') = 'claim'
      THEN JSON_VALUE(topics_decoded, '$[2].address')
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') IN ('new_auction', 'fill_auction')
      THEN NULL
      ELSE JSON_VALUE(topics_decoded, '$[1].address')
    END AS asset_address,
    -- User address extraction
    CASE
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') = 'claim'
      THEN JSON_VALUE(topics_decoded, '$[1].address')
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') IN ('new_auction', 'fill_auction')
      THEN COALESCE(
        JSON_VALUE(topics_decoded, '$[2].address'),
        JSON_VALUE(topics_decoded, '$[1].address')
      )
      ELSE JSON_VALUE(topics_decoded, '$[2].address')
    END AS user_address,
    -- Amount underlying
    CASE
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') IN ('new_auction', 'fill_auction')
      THEN NULL
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') = 'claim'
      THEN CAST(COALESCE(
        JSON_VALUE(data_decoded, '$.vec[1].i128'),
        JSON_VALUE(data_decoded, '$.vec[1].i128.lo')
      ) AS STRING)
      ELSE CAST(COALESCE(
        JSON_VALUE(data_decoded, '$.vec[0].i128'),
        JSON_VALUE(data_decoded, '$.vec[0].i128.lo'),
        JSON_VALUE(data_decoded, '$.i128'),
        JSON_VALUE(data_decoded, '$.i128.lo')
      ) AS STRING)
    END AS amount_underlying,
    -- Token amount
    CASE
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') IN ('new_auction', 'fill_auction', 'claim')
      THEN NULL
      ELSE CAST(COALESCE(
        JSON_VALUE(data_decoded, '$.vec[1].i128'),
        JSON_VALUE(data_decoded, '$.vec[1].i128.lo')
      ) AS STRING)
    END AS amount_tokens,
    -- Implied rate
    CASE
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') IN ('fill_auction', 'new_auction', 'claim')
      THEN NULL
      WHEN SAFE_CAST(COALESCE(
        JSON_VALUE(data_decoded, '$.vec[1].i128'),
        JSON_VALUE(data_decoded, '$.vec[1].i128.lo')
      ) AS NUMERIC) > 0
      THEN CAST(
        SAFE_CAST(COALESCE(
          JSON_VALUE(data_decoded, '$.vec[0].i128'),
          JSON_VALUE(data_decoded, '$.vec[0].i128.lo')
        ) AS NUMERIC) /
        SAFE_CAST(COALESCE(
          JSON_VALUE(data_decoded, '$.vec[1].i128'),
          JSON_VALUE(data_decoded, '$.vec[1].i128.lo')
        ) AS NUMERIC)
        AS STRING
      )
      ELSE NULL
    END AS implied_rate,
    -- Auction type
    CASE
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') IN ('new_auction', 'fill_auction')
      THEN JSON_VALUE(topics_decoded, '$[1].u32')
      ELSE NULL
    END AS auction_type,
    -- Filler address
    CASE
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') = 'fill_auction'
      THEN COALESCE(
        JSON_VALUE(data_decoded, '$.vec[0].address'),
        JSON_VALUE(data_decoded, '$[0].address')
      )
      ELSE NULL
    END AS filler_address,
    -- Liquidation percent
    CASE
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') = 'new_auction'
      THEN COALESCE(
        JSON_VALUE(data_decoded, '$.vec[0].u32'),
        JSON_VALUE(data_decoded, '$[0].u32')
      )
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') = 'fill_auction'
      THEN COALESCE(
        JSON_VALUE(data_decoded, '$.vec[1].i128'),
        JSON_VALUE(data_decoded, '$.vec[1].i128.lo')
      )
      ELSE NULL
    END AS liquidation_percent,
    -- Bid asset
    CASE
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') IN ('new_auction', 'fill_auction')
      THEN COALESCE(
        JSON_VALUE(data_decoded, '$.vec[1].map[0].val.map[0].key.address'),
        JSON_VALUE(data_decoded, '$.vec[2].map[0].val.map[0].key.address')
      )
      ELSE NULL
    END AS bid_asset,
    -- Bid amount
    CASE
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') IN ('new_auction', 'fill_auction')
      THEN COALESCE(
        JSON_VALUE(data_decoded, '$.vec[1].map[0].val.map[0].val.i128'),
        JSON_VALUE(data_decoded, '$.vec[1].map[0].val.map[0].val.i128.lo'),
        JSON_VALUE(data_decoded, '$.vec[2].map[0].val.map[0].val.i128'),
        JSON_VALUE(data_decoded, '$.vec[2].map[0].val.map[0].val.i128.lo')
      )
      ELSE NULL
    END AS bid_amount,
    -- Lot asset
    CASE
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') IN ('new_auction', 'fill_auction')
      THEN COALESCE(
        JSON_VALUE(data_decoded, '$.vec[1].map[2].val.map[0].key.address'),
        JSON_VALUE(data_decoded, '$.vec[2].map[2].val.map[0].key.address')
      )
      ELSE NULL
    END AS lot_asset,
    -- Lot amount
    CASE
      WHEN JSON_VALUE(topics_decoded, '$[0].symbol') IN ('new_auction', 'fill_auction')
      THEN COALESCE(
        JSON_VALUE(data_decoded, '$.vec[1].map[2].val.map[0].val.i128'),
        JSON_VALUE(data_decoded, '$.vec[1].map[2].val.map[0].val.i128.lo'),
        JSON_VALUE(data_decoded, '$.vec[2].map[2].val.map[0].val.i128'),
        JSON_VALUE(data_decoded, '$.vec[2].map[2].val.map[0].val.i128.lo')
      )
      ELSE NULL
    END AS lot_amount
  FROM \`${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.${BIGQUERY_TABLE}\`
  WHERE
  ${whereClause}
),
-- Deduplicate events based on content hash (BigQuery may have duplicates)
deduplicated AS (
  SELECT *,
    -- Generate content hash from PARSED values for ID and deduplication
    SUBSTR(TO_HEX(SHA256(CONCAT(
      COALESCE(transaction_hash, ''),
      COALESCE(pool_id, ''),
      COALESCE(action_type, ''),
      COALESCE(asset_address, ''),
      COALESCE(user_address, ''),
      COALESCE(amount_underlying, ''),
      COALESCE(amount_tokens, ''),
      COALESCE(auction_type, ''),
      COALESCE(filler_address, ''),
      COALESCE(liquidation_percent, ''),
      COALESCE(bid_asset, ''),
      COALESCE(bid_amount, ''),
      COALESCE(lot_asset, ''),
      COALESCE(lot_amount, '')
    ))), 1, 16) AS content_hash,
    ROW_NUMBER() OVER (
      PARTITION BY ledger_sequence, SUBSTR(TO_HEX(SHA256(CONCAT(
        COALESCE(transaction_hash, ''),
        COALESCE(pool_id, ''),
        COALESCE(action_type, ''),
        COALESCE(asset_address, ''),
        COALESCE(user_address, ''),
        COALESCE(amount_underlying, ''),
        COALESCE(amount_tokens, ''),
        COALESCE(auction_type, ''),
        COALESCE(filler_address, ''),
        COALESCE(liquidation_percent, ''),
        COALESCE(bid_asset, ''),
        COALESCE(bid_amount, ''),
        COALESCE(lot_asset, ''),
        COALESCE(lot_amount, '')
      ))), 1, 16)
      ORDER BY closed_at
    ) AS row_num
  FROM parsed
)
SELECT
  -- Construct ID using content hash: {ledger}-{hash16}
  CONCAT(
    CAST(ledger_sequence AS STRING), '-',
    content_hash
  ) AS id,
  pool_id,
  transaction_hash,
  ledger_sequence,
  closed_at AS ledger_closed_at,
  action_type,
  asset_address,
  user_address,
  amount_underlying,
  amount_tokens,
  implied_rate,
  auction_type,
  filler_address,
  liquidation_percent,
  bid_asset,
  bid_amount,
  lot_asset,
  lot_amount
FROM deduplicated
WHERE row_num = 1  -- Keep only first occurrence of each duplicate
ORDER BY ledger_sequence, transaction_hash
${limitClause}
    `.trim();

    return query;
  }

  /**
   * Get query cost estimate (dry run)
   */
  async getCostEstimate(params: ActionsBackfillParams): Promise<{
    bytes: number;
    gb: string;
    cost: string;
    query: string;
  }> {
    console.log('📊 getCostEstimate - params received:', JSON.stringify(params, null, 2));
    const query = this.buildQuery(params);
    console.log('📊 getCostEstimate - Query WHERE clause preview:', query.substring(query.indexOf('WHERE'), query.indexOf('WHERE') + 500));

    console.log('Getting cost estimate for actions backfill...');

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
  async simulate(params: ActionsBackfillParams): Promise<{
    success: boolean;
    rows: any[];
    estimated_cost: string;
    query: string;
  }> {
    try {
      console.log('\n🔍 Simulating actions backfill (dry run)...');

      // Get cost estimate first
      const estimate = await this.getCostEstimate(params);

      console.log(`\nQuery to execute:\n${estimate.query}\n`);

      // Apply a limit for simulation if not specified
      const simulationParams = {
        ...params,
        limit: params.limit || 100, // Default to 100 rows for simulation
      };

      const query = this.buildQuery(simulationParams);

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
          console.log(`  [${idx + 1}] ${row.action_type} by ${row.user_address?.substring(0, 8)}... - ${row.amount_underlying} underlying`);
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
      };
    }
  }

  /**
   * Run the full backfill - fetch and save to database
   */
  async runBackfill(params: ActionsBackfillParams): Promise<ActionsBackfillResult> {
    try {
      console.log('\n🔄 Starting blend actions backfill from BigQuery...');

      // Show parameters
      if (params.startLedger || params.endLedger) {
        const start = params.startLedger ? params.startLedger.toLocaleString() : 'any';
        const end = params.endLedger ? params.endLedger.toLocaleString() : 'any';
        console.log(`Ledger range: ${start} to ${end}`);
      }
      if (params.startDate || params.endDate) {
        console.log(`Date range: ${params.startDate || 'any'} to ${params.endDate || 'any'}`);
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
      const query = this.buildQuery(params);

      const [rows] = await this.client.query({
        query,
        useLegacySql: false,
        location: 'US',
        jobTimeoutMs: 600000, // 10 minute timeout for full backfill
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

      // Step 4: Filter out records that already exist as GS records
      console.log('\nStep 4: Checking for existing GS records...');
      const newRows = await actionsRepository.filterExistingGsRecords(validRows);
      console.log(`✓ ${newRows.length} new rows to insert (${validRows.length - newRows.length} already exist as GS records)`);

      if (newRows.length === 0) {
        console.log('⚠️  All records already exist as GS records, nothing to insert');
        return {
          success: true,
          rows_fetched: rows.length,
          rows_inserted: 0,
          rows_updated: 0,
          estimated_cost: estimate.cost,
        };
      }

      // Step 5: Insert into database
      console.log('\nStep 5: Inserting into database...');
      const result = await actionsRepository.insertBatch(newRows);
      console.log(`✓ Inserted ${result.inserted} rows, updated ${result.updated} rows`);

      // Step 6: Show stats
      const stats = await actionsRepository.getStats();
      console.log('\n📊 Database Stats:');
      console.log(`   Total actions: ${stats.total_rows}`);
      console.log(`   Latest ledger: ${stats.latest_ledger}`);
      console.log(`   Unique users: ${stats.unique_users}`);
      console.log(`   Action breakdown:`);
      Object.entries(stats.action_counts).forEach(([action, count]) => {
        console.log(`     - ${action}: ${count}`);
      });

      console.log('\n✅ Actions backfill completed successfully!\n');

      return {
        success: true,
        rows_fetched: rows.length,
        rows_inserted: result.inserted,
        rows_updated: result.updated,
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
   * Transform BigQuery rows to BlendActionRow format
   */
  private transformRows(rows: any[]): BlendActionRow[] {
    const validRows: BlendActionRow[] = [];
    const errors: string[] = [];

    for (const row of rows) {
      try {
        // Basic validation
        if (!row.id || !row.pool_id || !row.action_type) {
          errors.push('Missing required fields (id, pool_id, or action_type)');
          continue;
        }

        // BigQuery returns timestamps as objects with a 'value' property
        const closedAt = row.ledger_closed_at?.value || row.ledger_closed_at;

        const transformedRow: BlendActionRow = {
          id: row.id,
          pool_id: row.pool_id,
          transaction_hash: row.transaction_hash,
          ledger_sequence: parseInt(row.ledger_sequence),
          ledger_closed_at: closedAt,
          action_type: row.action_type,
          asset_address: row.asset_address || null,
          user_address: row.user_address || null,
          amount_underlying: row.amount_underlying || null,
          amount_tokens: row.amount_tokens || null,
          implied_rate: row.implied_rate || null,
          // Auction-specific fields
          auction_type: row.auction_type || null,
          filler_address: row.filler_address || null,
          liquidation_percent: row.liquidation_percent || null,
          // Auction bid/lot data
          bid_asset: row.bid_asset || null,
          bid_amount: row.bid_amount || null,
          lot_asset: row.lot_asset || null,
          lot_amount: row.lot_amount || null,
          // Data source
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
   * Get tracked pools
   */
  getTrackedPools(): string[] {
    return BLEND_POOLS;
  }

  /**
   * Get action types
   */
  getActionTypes(): string[] {
    return ACTION_TYPES;
  }
}

export const bigQueryActionsBackfillService = new BigQueryActionsBackfillService();
