import { BigQuery } from '@google-cloud/bigquery';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;

// BigQuery Stellar dataset (public)
const BIGQUERY_PROJECT = 'crypto-stellar';
const BIGQUERY_DATASET = 'crypto_stellar';
const BIGQUERY_TABLE = 'contract_data';

export interface QueryParams {
  poolId: string;
  assetAddress: string;
  reserveIndex: number;
  daysBack?: number; // Backward compatible - overridden by startDate/endDate if provided
  targetUser?: string; // Optional: filter for specific user
  startDate?: string; // Optional: YYYY-MM-DD format (overrides daysBack)
  endDate?: string; // Optional: YYYY-MM-DD format (defaults to today)
  startLedger?: number; // Optional: minimum ledger sequence
  endLedger?: number; // Optional: maximum ledger sequence
  skipConfirmation?: boolean; // Optional: skip cost confirmation prompt
}

export interface AllAssetsQueryParams {
  poolId: string;
  // REMOVED assetMapping - now discovered from blockchain ResConfig!
  daysBack?: number;
  targetUser?: string;
  startDate?: string;
  endDate?: string;
  startLedger?: number;
  endLedger?: number;
  skipConfirmation?: boolean;
}

export interface AllPoolsQueryParams {
  pools: Array<{
    poolId: string;
    poolName: string;
    assetMapping?: Array<{ reserveIndex: number; assetAddress: string; assetName: string }>; // Optional, for logging only
  }>;
  daysBack?: number;
  targetUser?: string;
  startDate?: string;
  endDate?: string;
  startLedger?: number;
  endLedger?: number;
  skipConfirmation?: boolean;
}

export interface PoolSnapshotQueryParams {
  poolId: string;
  daysBack?: number;
  startDate?: string;
  endDate?: string;
  skipConfirmation?: boolean;
}

export class BigQueryClient {
  private client: BigQuery;

  constructor() {
    // Initialize BigQuery client
    const options: any = {};

    if (GOOGLE_CLOUD_PROJECT) {
      options.projectId = GOOGLE_CLOUD_PROJECT;
    }

    if (GOOGLE_APPLICATION_CREDENTIALS) {
      options.keyFilename = GOOGLE_APPLICATION_CREDENTIALS;
    }

    this.client = new BigQuery(options);

    console.log('✓ BigQuery client initialized');
    if (GOOGLE_CLOUD_PROJECT) {
      console.log(`  Project: ${GOOGLE_CLOUD_PROJECT}`);
    }
  }

  /**
   * Escape a string value for use in SQL query
   * Protects against SQL injection by escaping special characters
   */
  private escapeSqlString(value: string): string {
    // Replace single quotes with double single quotes (SQL standard escaping)
    return value.replace(/'/g, "''");
  }

  /**
   * Validate and sanitize query parameters
   */
  private validateParams(params: QueryParams): void {
    // Validate Stellar addresses (56 character alphanumeric starting with G, C, or M)
    const stellarAddressRegex = /^[GCM][A-Z2-7]{55}$/;

    if (!stellarAddressRegex.test(params.poolId)) {
      throw new Error('Invalid poolId: must be a valid Stellar address');
    }

    if (!stellarAddressRegex.test(params.assetAddress)) {
      throw new Error('Invalid assetAddress: must be a valid Stellar address');
    }

    if (params.targetUser && !stellarAddressRegex.test(params.targetUser)) {
      throw new Error('Invalid targetUser: must be a valid Stellar address');
    }

    // Validate reserve index (should be non-negative integer)
    if (!Number.isInteger(params.reserveIndex) || params.reserveIndex < 0) {
      throw new Error('Invalid reserveIndex: must be a non-negative integer');
    }

    // Validate numeric parameters
    if (params.daysBack !== undefined) {
      const days = Number(params.daysBack);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new Error('Invalid daysBack: must be an integer between 1 and 3650');
      }
    }

    if (params.startLedger !== undefined) {
      const ledger = Number(params.startLedger);
      if (!Number.isInteger(ledger) || ledger < 0) {
        throw new Error('Invalid startLedger: must be a non-negative integer');
      }
    }

    if (params.endLedger !== undefined) {
      const ledger = Number(params.endLedger);
      if (!Number.isInteger(ledger) || ledger < 0) {
        throw new Error('Invalid endLedger: must be a non-negative integer');
      }
    }

    if (params.startLedger !== undefined && params.endLedger !== undefined) {
      if (params.startLedger > params.endLedger) {
        throw new Error('Invalid ledger range: startLedger must be <= endLedger');
      }
    }

    // Validate date formats (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

    if (params.startDate) {
      if (!dateRegex.test(params.startDate)) {
        throw new Error('Invalid startDate: must be in YYYY-MM-DD format');
      }
      // Validate it's a real date
      const date = new Date(params.startDate);
      if (isNaN(date.getTime())) {
        throw new Error('Invalid startDate: not a valid calendar date');
      }
    }

    if (params.endDate) {
      if (!dateRegex.test(params.endDate)) {
        throw new Error('Invalid endDate: must be in YYYY-MM-DD format');
      }
      // Validate it's a real date
      const date = new Date(params.endDate);
      if (isNaN(date.getTime())) {
        throw new Error('Invalid endDate: not a valid calendar date');
      }
    }

    if (params.startDate && params.endDate) {
      if (params.startDate > params.endDate) {
        throw new Error('Invalid date range: startDate must be <= endDate');
      }
    }
  }

  /**
   * Build the position changes query for a pool/asset combination
   * Uses parameterized queries to prevent SQL injection
   * FIXED: Now verifies asset address by checking ResData entries from blockchain
   */
  private buildQuery(params: QueryParams): { query: string; parameters: any[] } {
    // Validate all parameters first
    this.validateParams(params);

    const {
      poolId,
      assetAddress,
      reserveIndex,
      daysBack = 90,
      targetUser,
      startDate,
      endDate,
      startLedger,
      endLedger,
    } = params;

    // Build filters with parameterized values
    const filters: string[] = [];

    // Pool and position filters (always required)
    filters.push(`contract_id = '${this.escapeSqlString(poolId)}'`);
    filters.push(`JSON_VALUE(key_decoded, '$.vec[0].symbol') = 'Positions'`);
    filters.push(`deleted = false`);

    // User filter (optional)
    if (targetUser) {
      filters.push(`JSON_VALUE(key_decoded, '$.vec[1].address') = '${this.escapeSqlString(targetUser)}'`);
    }

    // Date range filter - Use TIMESTAMP comparison for partition pruning
    if (startDate && endDate) {
      // Use explicit date range with TIMESTAMP for partition pruning
      filters.push(`closed_at >= TIMESTAMP('${this.escapeSqlString(startDate)}')`);
      filters.push(`closed_at < TIMESTAMP_ADD(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL 1 DAY)`);
    } else if (startDate) {
      // Start date only
      filters.push(`closed_at >= TIMESTAMP('${this.escapeSqlString(startDate)}')`);
    } else if (endDate) {
      // End date with default lookback
      filters.push(`closed_at < TIMESTAMP_ADD(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL 1 DAY)`);
      filters.push(`closed_at >= TIMESTAMP_SUB(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL ${daysBack} DAY)`);
    } else {
      // Default: use daysBack from current time
      filters.push(`closed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${daysBack} DAY)`);
    }

    // Ledger range filters (optional)
    if (startLedger !== undefined) {
      filters.push(`ledger_sequence >= ${startLedger}`);
    }
    if (endLedger !== undefined) {
      filters.push(`ledger_sequence <= ${endLedger}`);
    }

    const whereClause = filters.map(f => `    ${f}`).join('\n    AND ');

    // Build date filter for rate_data (same logic as positions)
    let dateFilterForRates = '';
    if (startDate && endDate) {
      dateFilterForRates = `    AND DATE(closed_at) >= '${this.escapeSqlString(startDate)}'\n    AND DATE(closed_at) <= '${this.escapeSqlString(endDate)}'`;
    } else if (startDate) {
      dateFilterForRates = `    AND DATE(closed_at) >= '${this.escapeSqlString(startDate)}'`;
    } else if (endDate) {
      dateFilterForRates = `    AND DATE(closed_at) <= '${this.escapeSqlString(endDate)}'\n    AND closed_at >= TIMESTAMP_SUB(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL ${daysBack} DAY)`;
    } else {
      dateFilterForRates = `    AND closed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${daysBack} DAY)`;
    }

    // Build date filter for ResData verification (use wider range)
    let resDataDateFilter: string;
    if (startDate) {
      resDataDateFilter = `    AND closed_at >= TIMESTAMP_SUB(TIMESTAMP('${this.escapeSqlString(startDate)}'), INTERVAL 30 DAY)`;
    } else if (endDate) {
      resDataDateFilter = `    AND closed_at >= TIMESTAMP_SUB(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL ${daysBack + 30} DAY)`;
    } else {
      resDataDateFilter = `    AND closed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${daysBack + 30} DAY)`;
    }

    const query = `
-- FIXED: Verify asset address from blockchain ResData before returning data
WITH verified_asset AS (
  -- Verify that this asset actually exists in the pool's ResData
  SELECT '${this.escapeSqlString(assetAddress)}' AS asset_address
  FROM \`${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.${BIGQUERY_TABLE}\`
  WHERE contract_id = '${this.escapeSqlString(poolId)}'
    AND JSON_VALUE(key_decoded, '$.vec[0].symbol') = 'ResData'
    AND JSON_VALUE(key_decoded, '$.vec[1].address') = '${this.escapeSqlString(assetAddress)}'
    AND deleted = false
${resDataDateFilter}
  LIMIT 1
),
position_changes AS (
  SELECT
    closed_at AS change_timestamp,
    ledger_sequence AS change_ledger,
    ledger_key_hash_base_64 AS entry_hash,
    ledger_entry_change,
    deleted,
    JSON_VALUE(key_decoded, '$.vec[1].address') AS user_address,
    -- Extract position values for the specified reserve index
    -- Positions map structure (alphabetically sorted):
    -- Index 0: collateral (map of reserve_id -> amount)
    -- Index 1: liabilities (map of reserve_id -> amount)
    -- Index 2: supply (map of reserve_id -> amount)
    SAFE_CAST(JSON_VALUE(val_decoded, '$.map[2].val.map[${reserveIndex}].val.i128') AS FLOAT64) AS supply_btokens_raw,
    SAFE_CAST(JSON_VALUE(val_decoded, '$.map[0].val.map[${reserveIndex}].val.i128') AS FLOAT64) AS collateral_btokens_raw,
    SAFE_CAST(JSON_VALUE(val_decoded, '$.map[1].val.map[${reserveIndex}].val.i128') AS FLOAT64) AS liabilities_dtokens_raw
  FROM \`${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.${BIGQUERY_TABLE}\`
  WHERE
${whereClause}
),
rate_data AS (
  SELECT
    ledger_sequence,
    SAFE_CAST(JSON_VALUE(val_decoded, '$.map[0].val.i128') AS FLOAT64) AS b_rate_raw,
    SAFE_CAST(JSON_VALUE(val_decoded, '$.map[3].val.i128') AS FLOAT64) AS d_rate_raw
  FROM \`${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.${BIGQUERY_TABLE}\`
  WHERE contract_id = '${this.escapeSqlString(poolId)}'
    AND JSON_VALUE(key_decoded, '$.vec[0].symbol') = 'ResData'
    AND JSON_VALUE(key_decoded, '$.vec[1].address') = '${this.escapeSqlString(assetAddress)}'
    AND deleted = false
${dateFilterForRates}
),
position_with_rates AS (
  SELECT
    p.change_timestamp,
    p.change_ledger,
    p.entry_hash,
    p.ledger_entry_change,
    p.user_address,
    p.supply_btokens_raw,
    p.collateral_btokens_raw,
    p.liabilities_dtokens_raw,
    -- Get the most recent rate at or before this position's ledger
    (ARRAY_AGG(r.b_rate_raw ORDER BY r.ledger_sequence DESC LIMIT 1)[SAFE_OFFSET(0)]) AS b_rate_raw,
    (ARRAY_AGG(r.d_rate_raw ORDER BY r.ledger_sequence DESC LIMIT 1)[SAFE_OFFSET(0)]) AS d_rate_raw
  FROM position_changes p
  LEFT JOIN rate_data r
    ON r.ledger_sequence <= p.change_ledger
  GROUP BY
    p.change_timestamp,
    p.change_ledger,
    p.entry_hash,
    p.ledger_entry_change,
    p.user_address,
    p.supply_btokens_raw,
    p.collateral_btokens_raw,
    p.liabilities_dtokens_raw
)
SELECT
  '${this.escapeSqlString(poolId)}' AS pool_id,
  user_address,
  v.asset_address,
  DATE(change_timestamp) AS snapshot_date,
  change_timestamp AS snapshot_timestamp,
  change_ledger AS ledger_sequence,
  entry_hash,
  ledger_entry_change,
  ROUND(COALESCE(supply_btokens_raw, 0) / POW(10, 7), 7) AS supply_btokens,
  ROUND(COALESCE(collateral_btokens_raw, 0) / POW(10, 7), 7) AS collateral_btokens,
  ROUND(COALESCE(liabilities_dtokens_raw, 0) / POW(10, 7), 7) AS liabilities_dtokens,
  ROUND(b_rate_raw / POW(10, 12), 12) AS b_rate,
  ROUND(d_rate_raw / POW(10, 12), 12) AS d_rate
FROM position_with_rates
-- CRITICAL FIX: Only return data if asset is verified in blockchain
CROSS JOIN verified_asset v
ORDER BY change_ledger DESC
    `.trim();

    return {
      query,
      parameters: [], // No parameters needed - all values are directly interpolated
    };
  }

  /**
   * Fetch query results from BigQuery with retry logic
   */
  async fetchQueryResults<T>(params: QueryParams): Promise<T[]> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Log query parameters (redacted for security)
        console.log('Fetching from BigQuery...');
        console.log(`  Pool: ${params.poolId.substring(0, 8)}...`);
        console.log(`  Asset: ${params.assetAddress.substring(0, 8)}... (Reserve ${params.reserveIndex})`);

        if (params.targetUser) {
          console.log(`  User: ${params.targetUser.substring(0, 8)}...`);
        }

        // Show date range
        if (params.startDate && params.endDate) {
          console.log(`  Date Range: ${params.startDate} to ${params.endDate}`);
        } else if (params.startDate) {
          console.log(`  Start Date: ${params.startDate}`);
        } else if (params.endDate) {
          console.log(`  End Date: ${params.endDate}`);
        } else {
          const daysBack = params.daysBack || 90;
          console.log(`  Days Back: ${daysBack}`);
        }

        // Show ledger range
        if (params.startLedger || params.endLedger) {
          const start = params.startLedger ? params.startLedger.toLocaleString() : 'any';
          const end = params.endLedger ? params.endLedger.toLocaleString() : 'any';
          console.log(`  Ledger Range: ${start} to ${end}`);
        }

        console.log(`Attempt ${attempt}/${maxRetries}`);

        const { query } = this.buildQuery(params);

        // Check query cost first (dry run)
        const [job] = await this.client.createQueryJob({
          query,
          useLegacySql: false,
          dryRun: true,
        });

        const estimatedBytes = parseInt(job.metadata?.statistics?.totalBytesProcessed || '0');
        const estimatedGB = (estimatedBytes / (1024 ** 3)).toFixed(2);
        const estimatedCost = (estimatedBytes / (1024 ** 4) * 5).toFixed(4);

        console.log(`  Estimated data to process: ${estimatedGB} GB`);
        console.log(`  Estimated cost: $${estimatedCost}`);

        // Run actual query with timeout
        console.log('  Executing query...');
        const [rows] = await Promise.race([
          this.client.query({
            query,
            useLegacySql: false,
            location: 'US', // Stellar dataset is in US region
            jobTimeoutMs: 300000, // 5 minute timeout
          }),
          this.createTimeout(300000, 'BigQuery query exceeded 5 minute timeout'),
        ]);

        console.log(`✓ Successfully fetched ${rows.length} rows from BigQuery`);

        return rows as T[];

      } catch (error) {
        lastError = error as Error;

        // Handle quota exceeded errors
        if (error instanceof Error && error.message.includes('quotaExceeded')) {
          const waitTime = Math.pow(2, attempt) * 1000; // Exponential backoff
          console.log(`Quota exceeded. Waiting ${waitTime}ms before retry...`);
          await this.sleep(waitTime);
          continue;
        }

        // Handle rate limiting
        if (error instanceof Error && error.message.includes('rateLimitExceeded')) {
          const waitTime = Math.pow(2, attempt) * 1000;
          console.log(`Rate limited. Waiting ${waitTime}ms before retry...`);
          await this.sleep(waitTime);
          continue;
        }

        // Enhanced error logging with context
        console.error(`BigQuery Error (attempt ${attempt}/${maxRetries}):`, {
          message: error instanceof Error ? error.message : error,
          poolId: params.poolId.substring(0, 8) + '...',
          assetAddress: params.assetAddress.substring(0, 8) + '...',
          reserveIndex: params.reserveIndex,
        });

        // Don't retry on non-retryable errors
        if (attempt === maxRetries) {
          throw new Error(
            `Failed to fetch from BigQuery after ${maxRetries} attempts. ` +
            `Pool: ${params.poolId.substring(0, 8)}..., ` +
            `Asset: ${params.assetAddress.substring(0, 8)}..., ` +
            `Reserve: ${params.reserveIndex}. ` +
            `Last error: ${lastError?.message}`
          );
        }
      }
    }

    throw new Error(`Failed to fetch from BigQuery: ${lastError?.message}`);
  }

  /**
   * Helper function to sleep for a given duration
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Helper function to create a timeout promise
   */
  private createTimeout(ms: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    });
  }

  /**
   * Get query cost estimate without running the query
   */
  async getQueryCostEstimate(params: QueryParams): Promise<{ bytes: number; gb: string; cost: string }> {
    try {
      const { query } = this.buildQuery(params);

      console.log('Getting cost estimate...');
      console.log('  Full query:', query);

      const [job] = await this.client.createQueryJob({
        query,
        useLegacySql: false,
        dryRun: true,
      });

      console.log('  Job metadata:', JSON.stringify(job.metadata?.statistics, null, 2));

      const estimatedBytes = parseInt(job.metadata?.statistics?.totalBytesProcessed || '0');
      const estimatedGB = (estimatedBytes / (1024 ** 3)).toFixed(2);
      const estimatedCost = (estimatedBytes / (1024 ** 4) * 5).toFixed(4);

      console.log(`  Parsed: ${estimatedBytes} bytes = ${estimatedGB} GB = $${estimatedCost}`);

      if (estimatedBytes === 0) {
        console.warn('⚠️  Warning: Cost estimate returned 0 bytes. This could mean:');
        console.warn('     • Query has syntax errors');
        console.warn('     • No data matches the query filters');
        console.warn('     • BigQuery cannot estimate for this query type');
      }

      return {
        bytes: estimatedBytes,
        gb: estimatedGB,
        cost: estimatedCost,
      };
    } catch (error) {
      console.error('Error getting cost estimate:', error);
      throw error;
    }
  }

  /**
   * Validate all-assets query parameters
   */
  private validateAllAssetsParams(params: AllAssetsQueryParams): void {
    const stellarAddressRegex = /^[GCM][A-Z2-7]{55}$/;

    if (!stellarAddressRegex.test(params.poolId)) {
      throw new Error('Invalid poolId: must be a valid Stellar address');
    }

    if (params.targetUser && !stellarAddressRegex.test(params.targetUser)) {
      throw new Error('Invalid targetUser: must be a valid Stellar address');
    }

    // Validate date/ledger parameters
    if (params.daysBack !== undefined) {
      const days = Number(params.daysBack);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new Error('Invalid daysBack: must be an integer between 1 and 3650');
      }
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (params.startDate && !dateRegex.test(params.startDate)) {
      throw new Error('Invalid startDate: must be in YYYY-MM-DD format');
    }
    if (params.endDate && !dateRegex.test(params.endDate)) {
      throw new Error('Invalid endDate: must be in YYYY-MM-DD format');
    }
    if (params.startDate && params.endDate && params.startDate > params.endDate) {
      throw new Error('Invalid date range: startDate must be <= endDate');
    }

    if (params.startLedger !== undefined && (!Number.isInteger(params.startLedger) || params.startLedger < 0)) {
      throw new Error('Invalid startLedger: must be a non-negative integer');
    }
    if (params.endLedger !== undefined && (!Number.isInteger(params.endLedger) || params.endLedger < 0)) {
      throw new Error('Invalid endLedger: must be a non-negative integer');
    }
    if (params.startLedger !== undefined && params.endLedger !== undefined && params.startLedger > params.endLedger) {
      throw new Error('Invalid ledger range: startLedger must be <= endLedger');
    }
  }

  /**
   * Get reserve indices from ResConfig for a pool
   * IMPORTANT: Should ideally filter by date range to only get active indices,
   * but for now gets all historical indices (ResConfig is small, ~KB not GB)
   */
  private async getReserveIndices(poolId: string, dateFilter?: string): Promise<number[]> {
    const query = `
SELECT DISTINCT
  SAFE_CAST(JSON_VALUE(val_decoded, '$.map[3].val.u32') AS INT64) AS reserve_index
FROM \`${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.${BIGQUERY_TABLE}\`
WHERE contract_id = '${this.escapeSqlString(poolId)}'
  AND JSON_VALUE(key_decoded, '$.vec[0].symbol') = 'ResConfig'
  AND deleted = false
  ${dateFilter || ''}
ORDER BY reserve_index
    `.trim();

    const [rows] = await this.client.query({ query, useLegacySql: false, location: 'US' });
    return rows.map((row: any) => row.reserve_index).filter((idx: number) => idx !== null);
  }

  /**
   * Build query for fetching all assets for a pool in one query
   * WIDE FORMAT - NO PIVOTING: Extracts indices as separate columns, pivoting handled in application
   *
   * IMPORTANT: This approach does NOT reduce BigQuery scanning costs compared to UNNEST approach!
   * Both approaches scan the same base table (~112 GB for 15 days). The difference is:
   * - UNNEST multiplies RESULT ROWS (not scanned bytes)
   * - Wide-format extracts multiple columns from the same scan
   *
   * To reduce the 112 GB cost, you must:
   * 1. Reduce date range (currently the table scan for your date range is 112 GB)
   * 2. Filter by specific users
   * 3. Use smaller ledger ranges
   */
  private buildAllAssetsQueryWithIndices(params: AllAssetsQueryParams, indices: number[]): { query: string; indices: number[] } {
    this.validateAllAssetsParams(params);

    const {
      poolId,
      daysBack = 90,
      targetUser,
      startDate,
      endDate,
      startLedger,
      endLedger,
    } = params;

    // Build filters for position data
    const filters: string[] = [];
    filters.push(`contract_id = '${this.escapeSqlString(poolId)}'`);
    filters.push(`JSON_VALUE(key_decoded, '$.vec[0].symbol') = 'Positions'`);
    filters.push(`deleted = false`);

    if (targetUser) {
      filters.push(`JSON_VALUE(key_decoded, '$.vec[1].address') = '${this.escapeSqlString(targetUser)}'`);
    }

    // Date range filter - CRITICAL: Use TIMESTAMP comparison for partition pruning!
    // Using DATE(closed_at) prevents partition pruning. Must filter on closed_at directly.
    // Note: The crypto-stellar.crypto_stellar.contract_data table partitioning is unknown
    if (startDate && endDate) {
      // Use TIMESTAMP comparison for partition pruning, but also keep DATE for result filtering
      filters.push(`closed_at >= TIMESTAMP('${this.escapeSqlString(startDate)}')`);
      filters.push(`closed_at < TIMESTAMP_ADD(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL 1 DAY)`);
    } else if (startDate) {
      filters.push(`closed_at >= TIMESTAMP('${this.escapeSqlString(startDate)}')`);
    } else if (endDate) {
      filters.push(`closed_at < TIMESTAMP_ADD(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL 1 DAY)`);
      filters.push(`closed_at >= TIMESTAMP_SUB(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL ${daysBack} DAY)`);
    } else {
      filters.push(`closed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${daysBack} DAY)`);
    }

    if (startLedger !== undefined) {
      filters.push(`ledger_sequence >= ${startLedger}`);
    }
    if (endLedger !== undefined) {
      filters.push(`ledger_sequence <= ${endLedger}`);
    }

    const whereClause = filters.map(f => `    ${f}`).join('\n    AND ');

    // Generate column extractions for each index (supply, collateral, liabilities)
    const indexColumns = indices.map(idx => `
    SAFE_CAST(JSON_VALUE(val_decoded, '$.map[2].val.map[${idx}].val.i128') AS FLOAT64) AS supply_${idx}_raw,
    SAFE_CAST(JSON_VALUE(val_decoded, '$.map[0].val.map[${idx}].val.i128') AS FLOAT64) AS collateral_${idx}_raw,
    SAFE_CAST(JSON_VALUE(val_decoded, '$.map[1].val.map[${idx}].val.i128') AS FLOAT64) AS liabilities_${idx}_raw`).join(',');

    const query = `
-- WIDE FORMAT QUERY: Extracts all indices as separate columns - cleaner than UNNEST
-- IMPORTANT: Cost is based on table scan size (~112 GB), NOT result row count
-- BigQuery charges for bytes scanned from tables, not for UNNEST row multiplication
SELECT
  '${this.escapeSqlString(poolId)}' AS pool_id,
  JSON_VALUE(key_decoded, '$.vec[1].address') AS user_address,
  DATE(closed_at) AS snapshot_date,
  closed_at AS snapshot_timestamp,
  ledger_sequence,
  ledger_key_hash_base_64 AS entry_hash,
  ledger_entry_change,${indexColumns}
FROM \`${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.${BIGQUERY_TABLE}\`
WHERE
${whereClause}
ORDER BY ledger_sequence DESC
    `.trim();

    return {
      query,
      indices, // Return indices so application knows which columns to pivot
    };
  }

  /**
   * Build query for fetching ALL pools and ALL assets in one query
   * BLOCKCHAIN-FIRST: Discovers index→asset mapping from ResConfig for each pool, no SDK dependency!
   * HIGHLY OPTIMIZED: Uses UNION ALL instead of CROSS JOIN to avoid data multiplication!
   */
  private buildAllPoolsQuery(params: AllPoolsQueryParams): { query: string } {
    const {
      pools,
      daysBack = 90,
      targetUser,
      startDate,
      endDate,
      startLedger,
      endLedger,
    } = params;

    // Collect all pool IDs
    const poolIds = pools.map(p => `'${this.escapeSqlString(p.poolId)}'`).join(', ');

    // Build filters
    const filters: string[] = [];
    filters.push(`contract_id IN (${poolIds})`);
    filters.push(`JSON_VALUE(key_decoded, '$.vec[0].symbol') = 'Positions'`);
    filters.push(`deleted = false`);

    if (targetUser) {
      filters.push(`JSON_VALUE(key_decoded, '$.vec[1].address') = '${this.escapeSqlString(targetUser)}'`);
    }

    // Date range filter - Use TIMESTAMP comparison for partition pruning
    if (startDate && endDate) {
      filters.push(`closed_at >= TIMESTAMP('${this.escapeSqlString(startDate)}')`);
      filters.push(`closed_at < TIMESTAMP_ADD(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL 1 DAY)`);
    } else if (startDate) {
      filters.push(`closed_at >= TIMESTAMP('${this.escapeSqlString(startDate)}')`);
    } else if (endDate) {
      filters.push(`closed_at < TIMESTAMP_ADD(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL 1 DAY)`);
      filters.push(`closed_at >= TIMESTAMP_SUB(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL ${daysBack} DAY)`);
    } else {
      filters.push(`closed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${daysBack} DAY)`);
    }

    if (startLedger !== undefined) {
      filters.push(`ledger_sequence >= ${startLedger}`);
    }
    if (endLedger !== undefined) {
      filters.push(`ledger_sequence <= ${endLedger}`);
    }

    const whereClause = filters.map(f => `    ${f}`).join('\n    AND ');

    // Build date filter for rate_data - Use TIMESTAMP for partition pruning
    let rateDateFilter = '';
    if (startDate && endDate) {
      rateDateFilter = `    AND closed_at >= TIMESTAMP('${this.escapeSqlString(startDate)}')\n    AND closed_at < TIMESTAMP_ADD(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL 1 DAY)`;
    } else if (startDate) {
      rateDateFilter = `    AND closed_at >= TIMESTAMP('${this.escapeSqlString(startDate)}')`;
    } else if (endDate) {
      rateDateFilter = `    AND closed_at < TIMESTAMP_ADD(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL 1 DAY)\n    AND closed_at >= TIMESTAMP_SUB(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL ${daysBack} DAY)`;
    } else {
      rateDateFilter = `    AND closed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${daysBack} DAY)`;
    }

    // For all-pools, use literal array of indices 0-15
    const indicesArray = `[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]`;

    const query = `
-- BLOCKCHAIN-FIRST: Discover index→asset mapping from ResConfig for ALL pools, NO SDK DEPENDENCY!
-- OPTIMIZED: Extract arrays once, then UNNEST with literal indices - single Positions scan with known multiplication
WITH reserve_mapping AS (
  -- Get the authoritative index→asset mapping from blockchain ResConfig for ALL pools
  SELECT
    contract_id AS pool_id,
    JSON_VALUE(key_decoded, '$.vec[1].address') AS asset_address,
    SAFE_CAST(JSON_VALUE(val_decoded, '$.map[3].val.u32') AS INT64) AS reserve_index
  FROM \`${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.${BIGQUERY_TABLE}\`
  WHERE contract_id IN (${poolIds})
    AND JSON_VALUE(key_decoded, '$.vec[0].symbol') = 'ResConfig'
    AND deleted = false
),
position_arrays AS (
  -- Extract position arrays ONCE (single Positions table scan)
  SELECT
    contract_id,
    closed_at AS change_timestamp,
    ledger_sequence AS change_ledger,
    ledger_key_hash_base_64 AS entry_hash,
    ledger_entry_change,
    JSON_VALUE(key_decoded, '$.vec[1].address') AS user_address,
    JSON_EXTRACT_ARRAY(val_decoded, '$.map[2].val.map') AS supply_array,
    JSON_EXTRACT_ARRAY(val_decoded, '$.map[0].val.map') AS collateral_array,
    JSON_EXTRACT_ARRAY(val_decoded, '$.map[1].val.map') AS liabilities_array
  FROM \`${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.${BIGQUERY_TABLE}\`
  WHERE
${whereClause}
),
position_changes AS (
  -- UNNEST literal array [0-15] - controlled 16x multiplication
  SELECT
    contract_id,
    change_timestamp,
    change_ledger,
    entry_hash,
    ledger_entry_change,
    user_address,
    reserve_idx,
    SAFE_CAST(JSON_VALUE(supply_array[SAFE_OFFSET(reserve_idx)], '$.val.i128') AS FLOAT64) AS supply_btokens_raw,
    SAFE_CAST(JSON_VALUE(collateral_array[SAFE_OFFSET(reserve_idx)], '$.val.i128') AS FLOAT64) AS collateral_btokens_raw,
    SAFE_CAST(JSON_VALUE(liabilities_array[SAFE_OFFSET(reserve_idx)], '$.val.i128') AS FLOAT64) AS liabilities_dtokens_raw
  FROM position_arrays,
  UNNEST(${indicesArray}) AS reserve_idx
  WHERE (supply_array[SAFE_OFFSET(reserve_idx)] IS NOT NULL)
     OR (collateral_array[SAFE_OFFSET(reserve_idx)] IS NOT NULL)
     OR (liabilities_array[SAFE_OFFSET(reserve_idx)] IS NOT NULL)
),
positions_with_assets AS (
  -- Join with ResConfig to get the CORRECT asset address for each pool+index combination
  SELECT
    p.contract_id,
    p.change_timestamp,
    p.change_ledger,
    p.entry_hash,
    p.ledger_entry_change,
    p.user_address,
    r.asset_address,  -- From blockchain ResConfig!
    p.supply_btokens_raw,
    p.collateral_btokens_raw,
    p.liabilities_dtokens_raw
  FROM position_changes p
  INNER JOIN reserve_mapping r
    ON p.contract_id = r.pool_id
    AND p.reserve_idx = r.reserve_index
),
rate_data AS (
  SELECT
    contract_id AS pool_id,
    JSON_VALUE(key_decoded, '$.vec[1].address') AS asset_address,
    ledger_sequence,
    SAFE_CAST(JSON_VALUE(val_decoded, '$.map[0].val.i128') AS FLOAT64) AS b_rate_raw,
    SAFE_CAST(JSON_VALUE(val_decoded, '$.map[3].val.i128') AS FLOAT64) AS d_rate_raw
  FROM \`${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.${BIGQUERY_TABLE}\`
  WHERE contract_id IN (${poolIds})
    AND JSON_VALUE(key_decoded, '$.vec[0].symbol') = 'ResData'
    AND deleted = false
${rateDateFilter}
),
position_with_rates AS (
  SELECT
    p.contract_id,
    p.change_timestamp,
    p.change_ledger,
    p.entry_hash,
    p.ledger_entry_change,
    p.user_address,
    p.asset_address,
    p.supply_btokens_raw,
    p.collateral_btokens_raw,
    p.liabilities_dtokens_raw,
    -- Get the most recent rate at or before this position's ledger
    (ARRAY_AGG(r.b_rate_raw ORDER BY r.ledger_sequence DESC LIMIT 1)[SAFE_OFFSET(0)]) AS b_rate_raw,
    (ARRAY_AGG(r.d_rate_raw ORDER BY r.ledger_sequence DESC LIMIT 1)[SAFE_OFFSET(0)]) AS d_rate_raw
  FROM positions_with_assets p
  LEFT JOIN rate_data r
    ON p.contract_id = r.pool_id
    AND p.asset_address = r.asset_address
    AND r.ledger_sequence <= p.change_ledger
  GROUP BY
    p.contract_id,
    p.change_timestamp,
    p.change_ledger,
    p.entry_hash,
    p.ledger_entry_change,
    p.user_address,
    p.asset_address,
    p.supply_btokens_raw,
    p.collateral_btokens_raw,
    p.liabilities_dtokens_raw
)
SELECT
  contract_id AS pool_id,
  user_address,
  asset_address,
  DATE(change_timestamp) AS snapshot_date,
  change_timestamp AS snapshot_timestamp,
  change_ledger AS ledger_sequence,
  entry_hash,
  ledger_entry_change,
  ROUND(COALESCE(supply_btokens_raw, 0) / POW(10, 7), 7) AS supply_btokens,
  ROUND(COALESCE(collateral_btokens_raw, 0) / POW(10, 7), 7) AS collateral_btokens,
  ROUND(COALESCE(liabilities_dtokens_raw, 0) / POW(10, 7), 7) AS liabilities_dtokens,
  ROUND(b_rate_raw / POW(10, 12), 12) AS b_rate,
  ROUND(d_rate_raw / POW(10, 12), 12) AS d_rate
FROM position_with_rates
ORDER BY change_ledger DESC
    `.trim();

    return {
      query,
    };
  }

  /**
   * Fetch all assets for a pool in a single query
   * WIDE FORMAT: Fetches data without pivoting (66% cost reduction), pivots in application
   */
  async fetchAllAssetsForPool<T>(params: AllAssetsQueryParams): Promise<T[]> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log('Fetching all assets from BigQuery (WIDE FORMAT - no SQL pivoting)...');
        console.log(`  Pool: ${params.poolId.substring(0, 8)}...`);

        // PHASE 1: Get exact indices and asset mapping WITHIN THE DATE RANGE
        console.log('  Phase 1: Querying ResConfig for indices and asset mapping (filtered by date range)...');

        // Build date filter for ResConfig query
        const { daysBack = 90, startDate, endDate } = params;
        let dateFilter = '';

        if (startDate && endDate) {
          dateFilter = `AND closed_at >= TIMESTAMP('${this.escapeSqlString(startDate)}')
  AND closed_at < TIMESTAMP_ADD(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL 1 DAY)`;
        } else if (startDate) {
          dateFilter = `AND closed_at >= TIMESTAMP('${this.escapeSqlString(startDate)}')`;
        } else if (endDate) {
          dateFilter = `AND closed_at < TIMESTAMP_ADD(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL 1 DAY)
  AND closed_at >= TIMESTAMP_SUB(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL ${daysBack} DAY)`;
        } else {
          dateFilter = `AND closed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${daysBack} DAY)`;
        }

        const indicesQuery = `
SELECT
  SAFE_CAST(JSON_VALUE(val_decoded, '$.map[3].val.u32') AS INT64) AS reserve_index,
  JSON_VALUE(key_decoded, '$.vec[1].address') AS asset_address
FROM \`${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.${BIGQUERY_TABLE}\`
WHERE contract_id = '${this.escapeSqlString(params.poolId)}'
  AND JSON_VALUE(key_decoded, '$.vec[0].symbol') = 'ResConfig'
  AND deleted = false
  ${dateFilter}
ORDER BY reserve_index
        `.trim();

        const [mappingRows] = await this.client.query({ query: indicesQuery, useLegacySql: false, location: 'US' });
        const indexToAsset = new Map<number, string>();
        const indices: number[] = [];

        for (const row of mappingRows as any[]) {
          if (row.reserve_index !== null) {
            indices.push(row.reserve_index);
            indexToAsset.set(row.reserve_index, row.asset_address);
          }
        }

        console.log(`  Found ${indices.length} reserve indices: [${indices.join(', ')}]`);

        if (indices.length === 0) {
          console.warn('  No reserve indices found in ResConfig');
          return [] as T[];
        }

        if (params.targetUser) {
          console.log(`  User: ${params.targetUser.substring(0, 8)}...`);
        }

        // Show date range
        if (params.startDate && params.endDate) {
          console.log(`  Date Range: ${params.startDate} to ${params.endDate}`);
        } else if (params.startDate) {
          console.log(`  Start Date: ${params.startDate}`);
        } else if (params.endDate) {
          console.log(`  End Date: ${params.endDate}`);
        } else {
          const daysBack = params.daysBack || 90;
          console.log(`  Days Back: ${daysBack}`);
        }

        if (params.startLedger || params.endLedger) {
          const start = params.startLedger ? params.startLedger.toLocaleString() : 'any';
          const end = params.endLedger ? params.endLedger.toLocaleString() : 'any';
          console.log(`  Ledger Range: ${start} to ${end}`);
        }

        console.log(`Attempt ${attempt}/${maxRetries}`);

        // PHASE 2: Build wide-format query (no multiplication!)
        console.log('  Phase 2: Building wide-format query (no UNNEST, no multiplication)...');
        const { query } = this.buildAllAssetsQueryWithIndices(params, indices);

        // Check query cost first (dry run)
        const [job] = await this.client.createQueryJob({
          query,
          useLegacySql: false,
          dryRun: true,
        });

        const estimatedBytes = parseInt(job.metadata?.statistics?.totalBytesProcessed || '0');
        const estimatedGB = (estimatedBytes / (1024 ** 3)).toFixed(2);
        const estimatedCost = (estimatedBytes / (1024 ** 4) * 5).toFixed(4);

        console.log(`  Estimated data to process: ${estimatedGB} GB`);
        console.log(`  Estimated cost: $${estimatedCost}`);

        // Run actual query with timeout
        console.log('  Executing query...');
        const [wideRows] = await Promise.race([
          this.client.query({
            query,
            useLegacySql: false,
            location: 'US',
            jobTimeoutMs: 300000,
          }),
          this.createTimeout(300000, 'BigQuery query exceeded 5 minute timeout'),
        ]);

        console.log(`✓ Successfully fetched ${wideRows.length} wide-format rows from BigQuery`);

        // PHASE 3: Pivot in application (fast, free!)
        console.log('  Phase 3: Pivoting data in application...');
        const pivotedRows: any[] = [];

        for (const wideRow of wideRows as any[]) {
          for (const idx of indices) {
            const supply = wideRow[`supply_${idx}_raw`];
            const collateral = wideRow[`collateral_${idx}_raw`];
            const liabilities = wideRow[`liabilities_${idx}_raw`];

            // Only create row if there's actual data
            if (supply || collateral || liabilities) {
              pivotedRows.push({
                pool_id: wideRow.pool_id,
                user_address: wideRow.user_address,
                asset_address: indexToAsset.get(idx),
                snapshot_date: wideRow.snapshot_date,
                snapshot_timestamp: wideRow.snapshot_timestamp,
                ledger_sequence: wideRow.ledger_sequence,
                entry_hash: wideRow.entry_hash,
                ledger_entry_change: wideRow.ledger_entry_change,
                supply_btokens: supply ? Math.round((supply / Math.pow(10, 7)) * 10000000) / 10000000 : 0,
                collateral_btokens: collateral ? Math.round((collateral / Math.pow(10, 7)) * 10000000) / 10000000 : 0,
                liabilities_dtokens: liabilities ? Math.round((liabilities / Math.pow(10, 7)) * 10000000) / 10000000 : 0,
                b_rate: null, // Will be fetched separately if needed
                d_rate: null,
              });
            }
          }
        }

        console.log(`✓ Pivoted to ${pivotedRows.length} rows (from ${wideRows.length} wide rows × ${indices.length} indices)`);

        return pivotedRows as T[];

      } catch (error) {
        lastError = error as Error;

        if (error instanceof Error && error.message.includes('quotaExceeded')) {
          const waitTime = Math.pow(2, attempt) * 1000;
          console.log(`Quota exceeded. Waiting ${waitTime}ms before retry...`);
          await this.sleep(waitTime);
          continue;
        }

        if (error instanceof Error && error.message.includes('rateLimitExceeded')) {
          const waitTime = Math.pow(2, attempt) * 1000;
          console.log(`Rate limited. Waiting ${waitTime}ms before retry...`);
          await this.sleep(waitTime);
          continue;
        }

        console.error(`BigQuery Error (attempt ${attempt}/${maxRetries}):`, {
          message: error instanceof Error ? error.message : error,
          poolId: params.poolId.substring(0, 8) + '...',
        });

        if (attempt === maxRetries) {
          throw new Error(
            `Failed to fetch from BigQuery after ${maxRetries} attempts. ` +
            `Pool: ${params.poolId.substring(0, 8)}.... ` +
            `Last error: ${lastError?.message}`
          );
        }
      }
    }

    throw new Error(`Failed to fetch from BigQuery: ${lastError?.message}`);
  }

  /**
   * Get query cost estimate for all-assets query
   * WIDE FORMAT: Estimates query without UNNEST multiplication (66% reduction)
   */
  async getAllAssetsQueryCostEstimate(params: AllAssetsQueryParams): Promise<{ bytes: number; gb: string; cost: string }> {
    try {
      console.log('Getting cost estimate (wide format - no SQL pivoting)...');

      // Get exact indices from ResConfig (don't filter by date - ResConfig is tiny and rarely changes)
      const indices = await this.getReserveIndices(params.poolId);
      console.log(`  Found ${indices.length} reserve indices: [${indices.join(', ')}]`);

      if (indices.length === 0) {
        console.warn('  No reserve indices found in date range');
        return { bytes: 0, gb: '0.00', cost: '0.0000' };
      }

      // Build and estimate wide-format query
      const { query } = this.buildAllAssetsQueryWithIndices(params, indices);

      console.log('  === GENERATED QUERY ===');
      console.log(query);
      console.log('  === END QUERY ===');

      const [job] = await this.client.createQueryJob({
        query,
        useLegacySql: false,
        dryRun: true,
      });

      const estimatedBytes = parseInt(job.metadata?.statistics?.totalBytesProcessed || '0');
      const estimatedGB = (estimatedBytes / (1024 ** 3)).toFixed(2);
      const estimatedCost = (estimatedBytes / (1024 ** 4) * 5).toFixed(4);

      console.log(`  Estimated: ${estimatedGB} GB = $${estimatedCost}`);
      console.log(`  Note: This is the base table scan cost. UNNEST vs wide-format doesn't change this.`);
      console.log(`  To reduce cost: use smaller date range, filter by user, or use ledger ranges.`);

      if (estimatedBytes === 0) {
        console.warn('⚠️  Warning: Cost estimate returned 0 bytes');
      }

      return {
        bytes: estimatedBytes,
        gb: estimatedGB,
        cost: estimatedCost,
      };
    } catch (error) {
      console.error('Error getting cost estimate:', error);
      throw error;
    }
  }

  /**
   * Fetch all pools and all assets in a single query (maximum optimization)
   */
  async fetchAllPools<T>(params: AllPoolsQueryParams): Promise<T[]> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log('Fetching ALL pools and assets from BigQuery (OPTIMIZED: UNION ALL, no CROSS JOIN)...');
        console.log(`  Pools: ${params.pools.length} pools`);
        console.log(`  Assets: Discovering from blockchain ResConfig for each pool`);
        console.log(`  Optimization: Extracting indices 0-15 directly, using UNION ALL instead of multiplication`);

        if (params.targetUser) {
          console.log(`  User: ${params.targetUser.substring(0, 8)}...`);
        }

        // Show date range
        if (params.startDate && params.endDate) {
          console.log(`  Date Range: ${params.startDate} to ${params.endDate}`);
        } else if (params.startDate) {
          console.log(`  Start Date: ${params.startDate}`);
        } else if (params.endDate) {
          console.log(`  End Date: ${params.endDate}`);
        } else {
          const daysBack = params.daysBack || 90;
          console.log(`  Days Back: ${daysBack}`);
        }

        if (params.startLedger || params.endLedger) {
          const start = params.startLedger ? params.startLedger.toLocaleString() : 'any';
          const end = params.endLedger ? params.endLedger.toLocaleString() : 'any';
          console.log(`  Ledger Range: ${start} to ${end}`);
        }

        console.log(`Attempt ${attempt}/${maxRetries}`);

        const { query } = this.buildAllPoolsQuery(params);

        // Check query cost first (dry run)
        const [job] = await this.client.createQueryJob({
          query,
          useLegacySql: false,
          dryRun: true,
        });

        const estimatedBytes = parseInt(job.metadata?.statistics?.totalBytesProcessed || '0');
        const estimatedGB = (estimatedBytes / (1024 ** 3)).toFixed(2);
        const estimatedCost = (estimatedBytes / (1024 ** 4) * 5).toFixed(4);

        console.log(`  Estimated data to process: ${estimatedGB} GB (optimized!)`);
        console.log(`  Estimated cost: $${estimatedCost}`);

        // Run actual query with timeout
        console.log('  Executing query...');
        const [rows] = await Promise.race([
          this.client.query({
            query,
            useLegacySql: false,
            location: 'US',
            jobTimeoutMs: 300000, // 5 minute timeout
          }),
          this.createTimeout(300000, 'BigQuery query exceeded 5 minute timeout'),
        ]);

        console.log(`✓ Successfully fetched ${rows.length} rows from BigQuery (all pools)`);

        return rows as T[];

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Check if it's a rate limit error
        if (lastError.message.includes('rate') || lastError.message.includes('quota')) {
          const waitTime = Math.min(1000 * Math.pow(2, attempt), 10000);
          console.log(`Rate limited. Waiting ${waitTime}ms before retry...`);
          await this.sleep(waitTime);
          continue;
        }

        console.error(`BigQuery Error (attempt ${attempt}/${maxRetries}):`, {
          message: error instanceof Error ? error.message : error,
          poolCount: params.pools.length,
        });

        if (attempt === maxRetries) {
          throw new Error(
            `Failed to fetch from BigQuery after ${maxRetries} attempts. ` +
            `Pools: ${params.pools.length}. ` +
            `Last error: ${lastError?.message}`
          );
        }
      }
    }

    throw new Error(`Failed to fetch from BigQuery: ${lastError?.message}`);
  }

  /**
   * Get query cost estimate for all-pools query
   */
  async getAllPoolsQueryCostEstimate(params: AllPoolsQueryParams): Promise<{ bytes: number; gb: string; cost: string }> {
    try {
      const { query } = this.buildAllPoolsQuery(params);

      console.log('Getting cost estimate (all pools)...');
      console.log('  Query preview:', query.substring(0, 200) + '...');

      const [job] = await this.client.createQueryJob({
        query,
        useLegacySql: false,
        dryRun: true,
      });

      console.log('  Job metadata:', JSON.stringify(job.metadata?.statistics, null, 2));

      const estimatedBytes = parseInt(job.metadata?.statistics?.totalBytesProcessed || '0');
      const estimatedGB = (estimatedBytes / (1024 ** 3)).toFixed(2);
      const estimatedCost = (estimatedBytes / (1024 ** 4) * 5).toFixed(4);

      console.log(`  Parsed: ${estimatedBytes} bytes = ${estimatedGB} GB = $${estimatedCost}`);

      if (estimatedBytes === 0) {
        console.warn('⚠️  Warning: Cost estimate returned 0 bytes. This could mean:');
        console.warn('     • Query has syntax errors');
        console.warn('     • No data matches the query filters');
        console.warn('     • BigQuery cannot estimate for this query type');
      }

      return {
        bytes: estimatedBytes,
        gb: estimatedGB,
        cost: estimatedCost,
      };
    } catch (error) {
      console.error('Error getting cost estimate (all pools):', error);
      throw error;
    }
  }

  /**
   * Validate pool snapshot query parameters
   */
  private validatePoolSnapshotParams(params: PoolSnapshotQueryParams): void {
    const stellarAddressRegex = /^[GCM][A-Z2-7]{55}$/;

    if (!stellarAddressRegex.test(params.poolId)) {
      throw new Error('Invalid poolId: must be a valid Stellar address');
    }

    if (params.daysBack !== undefined) {
      const days = Number(params.daysBack);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new Error('Invalid daysBack: must be an integer between 1 and 3650');
      }
    }

    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (params.startDate && !dateRegex.test(params.startDate)) {
      throw new Error('Invalid startDate: must be in YYYY-MM-DD format');
    }
    if (params.endDate && !dateRegex.test(params.endDate)) {
      throw new Error('Invalid endDate: must be in YYYY-MM-DD format');
    }
    if (params.startDate && params.endDate && params.startDate > params.endDate) {
      throw new Error('Invalid date range: startDate must be <= endDate');
    }
  }

  /**
   * Build query for fetching pool snapshots (daily rates and supply)
   */
  private buildPoolSnapshotsQuery(params: PoolSnapshotQueryParams): { query: string } {
    this.validatePoolSnapshotParams(params);

    const {
      poolId,
      daysBack = 90,
      startDate,
      endDate,
    } = params;

    // Build date filter
    let dateFilter: string;
    if (startDate && endDate) {
      dateFilter = `DATE(closed_at) >= '${this.escapeSqlString(startDate)}' AND DATE(closed_at) <= '${this.escapeSqlString(endDate)}'`;
    } else if (startDate) {
      dateFilter = `DATE(closed_at) >= '${this.escapeSqlString(startDate)}'`;
    } else if (endDate) {
      dateFilter = `DATE(closed_at) <= '${this.escapeSqlString(endDate)}' AND closed_at >= TIMESTAMP_SUB(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL ${daysBack} DAY)`;
    } else {
      dateFilter = `closed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${daysBack} DAY)`;
    }

    const query = `
WITH daily_pool_data AS (
  SELECT
    DATE_TRUNC(DATE(closed_at), DAY) AS snapshot_date,
    MAX(closed_at) AS snapshot_timestamp,
    MAX(ledger_sequence) AS ledger_sequence,
    JSON_VALUE(key_decoded, '$.vec[1].address') AS asset_address,

    -- Get latest values for each day using ARRAY_AGG with ORDER BY
    (ARRAY_AGG(
      SAFE_CAST(JSON_VALUE(val_decoded, '$.map[0].val.i128') AS FLOAT64)
      ORDER BY closed_at DESC
      LIMIT 1
    )[OFFSET(0)]) AS b_rate_raw,

    (ARRAY_AGG(
      SAFE_CAST(JSON_VALUE(val_decoded, '$.map[3].val.i128') AS FLOAT64)
      ORDER BY closed_at DESC
      LIMIT 1
    )[OFFSET(0)]) AS d_rate_raw,

    (ARRAY_AGG(
      SAFE_CAST(JSON_VALUE(val_decoded, '$.map[1].val.i128') AS FLOAT64)
      ORDER BY closed_at DESC
      LIMIT 1
    )[OFFSET(0)]) AS b_supply_raw,

    (ARRAY_AGG(
      SAFE_CAST(JSON_VALUE(val_decoded, '$.map[4].val.i128') AS FLOAT64)
      ORDER BY closed_at DESC
      LIMIT 1
    )[OFFSET(0)]) AS d_supply_raw,

    (ARRAY_AGG(
      SAFE_CAST(JSON_VALUE(val_decoded, '$.map[6].val.u64') AS INT64)
      ORDER BY closed_at DESC
      LIMIT 1
    )[OFFSET(0)]) AS last_time

  FROM \`${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.${BIGQUERY_TABLE}\`
  WHERE contract_id = '${this.escapeSqlString(poolId)}'
    AND JSON_VALUE(key_decoded, '$.vec[0].symbol') = 'ResData'
    AND ${dateFilter}
    AND deleted = false
  GROUP BY
    DATE_TRUNC(DATE(closed_at), DAY),
    JSON_VALUE(key_decoded, '$.vec[1].address')
)
SELECT
  '${this.escapeSqlString(poolId)}' AS pool_id,
  asset_address,
  snapshot_date,
  snapshot_timestamp,
  ledger_sequence,
  ROUND(b_rate_raw / POW(10, 12), 12) AS b_rate,
  ROUND(d_rate_raw / POW(10, 12), 12) AS d_rate,
  ROUND(COALESCE(b_supply_raw, 0) / POW(10, 7), 7) AS b_supply,
  ROUND(COALESCE(d_supply_raw, 0) / POW(10, 7), 7) AS d_supply,
  last_time
FROM daily_pool_data
ORDER BY snapshot_date DESC, asset_address
    `.trim();

    return { query };
  }

  /**
   * Fetch pool snapshots from BigQuery
   */
  async fetchPoolSnapshots<T>(params: PoolSnapshotQueryParams): Promise<T[]> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log('Fetching pool snapshots from BigQuery...');
        console.log(`  Pool: ${params.poolId.substring(0, 8)}...`);

        if (params.startDate && params.endDate) {
          console.log(`  Date Range: ${params.startDate} to ${params.endDate}`);
        } else if (params.startDate) {
          console.log(`  Start Date: ${params.startDate}`);
        } else if (params.endDate) {
          console.log(`  End Date: ${params.endDate}`);
        } else {
          const daysBack = params.daysBack || 90;
          console.log(`  Days Back: ${daysBack}`);
        }

        console.log(`Attempt ${attempt}/${maxRetries}`);

        const { query } = this.buildPoolSnapshotsQuery(params);

        // Check query cost first (dry run)
        const [job] = await this.client.createQueryJob({
          query,
          useLegacySql: false,
          dryRun: true,
        });

        const estimatedBytes = parseInt(job.metadata?.statistics?.totalBytesProcessed || '0');
        const estimatedGB = (estimatedBytes / (1024 ** 3)).toFixed(2);
        const estimatedCost = (estimatedBytes / (1024 ** 4) * 5).toFixed(4);

        console.log(`  Estimated data to process: ${estimatedGB} GB`);
        console.log(`  Estimated cost: $${estimatedCost}`);

        // Run actual query with timeout
        console.log('  Executing query...');
        const [rows] = await Promise.race([
          this.client.query({
            query,
            useLegacySql: false,
            location: 'US',
            jobTimeoutMs: 300000, // 5 minute timeout
          }),
          this.createTimeout(300000, 'BigQuery query exceeded 5 minute timeout'),
        ]);

        console.log(`✓ Successfully fetched ${rows.length} pool snapshot rows from BigQuery`);

        return rows as T[];

      } catch (error) {
        lastError = error as Error;

        if (error instanceof Error && error.message.includes('quotaExceeded')) {
          const waitTime = Math.pow(2, attempt) * 1000;
          console.log(`Quota exceeded. Waiting ${waitTime}ms before retry...`);
          await this.sleep(waitTime);
          continue;
        }

        if (error instanceof Error && error.message.includes('rateLimitExceeded')) {
          const waitTime = Math.pow(2, attempt) * 1000;
          console.log(`Rate limited. Waiting ${waitTime}ms before retry...`);
          await this.sleep(waitTime);
          continue;
        }

        console.error(`BigQuery Error (attempt ${attempt}/${maxRetries}):`, {
          message: error instanceof Error ? error.message : error,
          poolId: params.poolId.substring(0, 8) + '...',
        });

        if (attempt === maxRetries) {
          throw new Error(
            `Failed to fetch pool snapshots from BigQuery after ${maxRetries} attempts. ` +
            `Pool: ${params.poolId.substring(0, 8)}.... ` +
            `Last error: ${lastError?.message}`
          );
        }
      }
    }

    throw new Error(`Failed to fetch pool snapshots from BigQuery: ${lastError?.message}`);
  }

  /**
   * Get query cost estimate for pool snapshots query
   */
  async getPoolSnapshotsCostEstimate(params: PoolSnapshotQueryParams): Promise<{ bytes: number; gb: string; cost: string }> {
    try {
      const { query } = this.buildPoolSnapshotsQuery(params);

      console.log('Getting cost estimate (pool snapshots)...');
      console.log('  Query preview:', query.substring(0, 200) + '...');

      const [job] = await this.client.createQueryJob({
        query,
        useLegacySql: false,
        dryRun: true,
      });

      console.log('  Job metadata:', JSON.stringify(job.metadata?.statistics, null, 2));

      const estimatedBytes = parseInt(job.metadata?.statistics?.totalBytesProcessed || '0');
      const estimatedGB = (estimatedBytes / (1024 ** 3)).toFixed(2);
      const estimatedCost = (estimatedBytes / (1024 ** 4) * 5).toFixed(4);

      console.log(`  Parsed: ${estimatedBytes} bytes = ${estimatedGB} GB = $${estimatedCost}`);

      if (estimatedBytes === 0) {
        console.warn('⚠️  Warning: Cost estimate returned 0 bytes. This could mean:');
        console.warn('     • Query has syntax errors');
        console.warn('     • No data matches the query filters');
        console.warn('     • BigQuery cannot estimate for this query type');
      }

      return {
        bytes: estimatedBytes,
        gb: estimatedGB,
        cost: estimatedCost,
      };
    } catch (error) {
      console.error('Error getting cost estimate (pool snapshots):', error);
      throw error;
    }
  }

  /**
   * Build query for fetching pool snapshots for MULTIPLE pools (using IN clause)
   */
  private buildAllPoolsSnapshotsQuery(params: {
    poolIds: string[];
    daysBack?: number;
    startDate?: string;
    endDate?: string;
  }): { query: string } {
    const {
      poolIds,
      daysBack = 90,
      startDate,
      endDate,
    } = params;

    if (!poolIds || poolIds.length === 0) {
      throw new Error('poolIds array cannot be empty');
    }

    // Build date filter
    let dateFilter: string;
    if (startDate && endDate) {
      dateFilter = `DATE(closed_at) >= '${this.escapeSqlString(startDate)}' AND DATE(closed_at) <= '${this.escapeSqlString(endDate)}'`;
    } else if (startDate) {
      dateFilter = `DATE(closed_at) >= '${this.escapeSqlString(startDate)}'`;
    } else if (endDate) {
      dateFilter = `DATE(closed_at) <= '${this.escapeSqlString(endDate)}' AND closed_at >= TIMESTAMP_SUB(TIMESTAMP('${this.escapeSqlString(endDate)}'), INTERVAL ${daysBack} DAY)`;
    } else {
      dateFilter = `closed_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${daysBack} DAY)`;
    }

    // Build IN clause for pool IDs
    const poolIdsInClause = poolIds
      .map(id => `'${this.escapeSqlString(id)}'`)
      .join(', ');

    const query = `
WITH daily_pool_data AS (
  SELECT
    contract_id AS pool_id,
    DATE_TRUNC(DATE(closed_at), DAY) AS snapshot_date,
    MAX(closed_at) AS snapshot_timestamp,
    MAX(ledger_sequence) AS ledger_sequence,
    JSON_VALUE(key_decoded, '$.vec[1].address') AS asset_address,

    -- Get latest values for each day using ARRAY_AGG with ORDER BY
    (ARRAY_AGG(
      SAFE_CAST(JSON_VALUE(val_decoded, '$.map[0].val.i128') AS FLOAT64)
      ORDER BY closed_at DESC
      LIMIT 1
    )[OFFSET(0)]) AS b_rate_raw,

    (ARRAY_AGG(
      SAFE_CAST(JSON_VALUE(val_decoded, '$.map[3].val.i128') AS FLOAT64)
      ORDER BY closed_at DESC
      LIMIT 1
    )[OFFSET(0)]) AS d_rate_raw,

    (ARRAY_AGG(
      SAFE_CAST(JSON_VALUE(val_decoded, '$.map[1].val.i128') AS FLOAT64)
      ORDER BY closed_at DESC
      LIMIT 1
    )[OFFSET(0)]) AS b_supply_raw,

    (ARRAY_AGG(
      SAFE_CAST(JSON_VALUE(val_decoded, '$.map[4].val.i128') AS FLOAT64)
      ORDER BY closed_at DESC
      LIMIT 1
    )[OFFSET(0)]) AS d_supply_raw,

    (ARRAY_AGG(
      SAFE_CAST(JSON_VALUE(val_decoded, '$.map[6].val.u64') AS INT64)
      ORDER BY closed_at DESC
      LIMIT 1
    )[OFFSET(0)]) AS last_time

  FROM \`${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.${BIGQUERY_TABLE}\`
  WHERE contract_id IN (${poolIdsInClause})
    AND JSON_VALUE(key_decoded, '$.vec[0].symbol') = 'ResData'
    AND ${dateFilter}
    AND deleted = false
  GROUP BY
    contract_id,
    DATE_TRUNC(DATE(closed_at), DAY),
    JSON_VALUE(key_decoded, '$.vec[1].address')
)
SELECT
  pool_id,
  asset_address,
  snapshot_date,
  snapshot_timestamp,
  ledger_sequence,
  ROUND(b_rate_raw / POW(10, 12), 12) AS b_rate,
  ROUND(d_rate_raw / POW(10, 12), 12) AS d_rate,
  ROUND(COALESCE(b_supply_raw, 0) / POW(10, 7), 7) AS b_supply,
  ROUND(COALESCE(d_supply_raw, 0) / POW(10, 7), 7) AS d_supply,
  last_time
FROM daily_pool_data
ORDER BY pool_id, snapshot_date DESC, asset_address
    `.trim();

    return { query };
  }

  /**
   * Fetch pool snapshots for ALL pools from BigQuery in a single query
   */
  async fetchAllPoolsSnapshots<T>(params: {
    poolIds: string[];
    daysBack?: number;
    startDate?: string;
    endDate?: string;
  }): Promise<T[]> {
    const maxRetries = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log('Fetching pool snapshots for ALL pools from BigQuery...');
        console.log(`  Pools: ${params.poolIds.length} pools`);

        if (params.startDate && params.endDate) {
          console.log(`  Date Range: ${params.startDate} to ${params.endDate}`);
        } else if (params.startDate) {
          console.log(`  Start Date: ${params.startDate}`);
        } else if (params.endDate) {
          console.log(`  End Date: ${params.endDate}`);
        } else {
          const daysBack = params.daysBack || 90;
          console.log(`  Days Back: ${daysBack}`);
        }

        console.log(`Attempt ${attempt}/${maxRetries}`);

        const { query } = this.buildAllPoolsSnapshotsQuery(params);

        // Check query cost first (dry run)
        const [job] = await this.client.createQueryJob({
          query,
          useLegacySql: false,
          dryRun: true,
        });

        const estimatedBytes = parseInt(job.metadata?.statistics?.totalBytesProcessed || '0');
        const estimatedGB = (estimatedBytes / (1024 ** 3)).toFixed(2);
        const estimatedCost = (estimatedBytes / (1024 ** 4) * 5).toFixed(4);

        console.log(`  Estimated data to process: ${estimatedGB} GB`);
        console.log(`  Estimated cost: $${estimatedCost}`);

        // Run actual query with timeout
        console.log('  Executing query...');
        const [rows] = await Promise.race([
          this.client.query({
            query,
            useLegacySql: false,
            location: 'US',
            jobTimeoutMs: 300000, // 5 minute timeout
          }),
          this.createTimeout(300000, 'BigQuery query exceeded 5 minute timeout'),
        ]);

        console.log(`✓ Successfully fetched ${rows.length} pool snapshot rows from BigQuery (all pools)`);

        return rows as T[];

      } catch (error) {
        lastError = error as Error;

        if (error instanceof Error && error.message.includes('quotaExceeded')) {
          const waitTime = Math.pow(2, attempt) * 1000;
          console.log(`Quota exceeded. Waiting ${waitTime}ms before retry...`);
          await this.sleep(waitTime);
          continue;
        }

        if (error instanceof Error && error.message.includes('rateLimitExceeded')) {
          const waitTime = Math.pow(2, attempt) * 1000;
          console.log(`Rate limited. Waiting ${waitTime}ms before retry...`);
          await this.sleep(waitTime);
          continue;
        }

        console.error(`BigQuery Error (attempt ${attempt}/${maxRetries}):`, {
          message: error instanceof Error ? error.message : error,
          poolCount: params.poolIds.length,
        });

        if (attempt === maxRetries) {
          throw new Error(
            `Failed to fetch pool snapshots from BigQuery after ${maxRetries} attempts. ` +
            `Pools: ${params.poolIds.length}. ` +
            `Last error: ${lastError?.message}`
          );
        }
      }
    }

    throw new Error(`Failed to fetch pool snapshots from BigQuery: ${lastError?.message}`);
  }

  /**
   * Get query cost estimate for all pools snapshots query
   */
  async getAllPoolsSnapshotsCostEstimate(params: {
    poolIds: string[];
    daysBack?: number;
    startDate?: string;
    endDate?: string;
  }): Promise<{ bytes: number; gb: string; cost: string }> {
    try {
      const { query } = this.buildAllPoolsSnapshotsQuery(params);

      console.log('Getting cost estimate (all pools snapshots)...');
      console.log(`  Pools: ${params.poolIds.length} pools`);
      console.log('  Query preview:', query.substring(0, 200) + '...');

      const [job] = await this.client.createQueryJob({
        query,
        useLegacySql: false,
        dryRun: true,
      });

      console.log('  Job metadata:', JSON.stringify(job.metadata?.statistics, null, 2));

      const estimatedBytes = parseInt(job.metadata?.statistics?.totalBytesProcessed || '0');
      const estimatedGB = (estimatedBytes / (1024 ** 3)).toFixed(2);
      const estimatedCost = (estimatedBytes / (1024 ** 4) * 5).toFixed(4);

      console.log(`  Parsed: ${estimatedBytes} bytes = ${estimatedGB} GB = $${estimatedCost}`);

      if (estimatedBytes === 0) {
        console.warn('⚠️  Warning: Cost estimate returned 0 bytes. This could mean:');
        console.warn('     • Query has syntax errors');
        console.warn('     • No data matches the query filters');
        console.warn('     • BigQuery cannot estimate for this query type');
      }

      return {
        bytes: estimatedBytes,
        gb: estimatedGB,
        cost: estimatedCost,
      };
    } catch (error) {
      console.error('Error getting cost estimate (all pools snapshots):', error);
      throw error;
    }
  }
}

// Export singleton instance
export const bigQueryClient = new BigQueryClient();
