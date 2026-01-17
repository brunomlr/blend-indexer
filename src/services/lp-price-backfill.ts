/**
 * LP Token Price Backfill Service
 *
 * Imports historical LP token prices from Hubble BigQuery exports.
 * Supports both file upload and direct BigQuery execution.
 */

import { Pool } from "pg";
import { BigQuery } from "@google-cloud/bigquery";
import fs from "fs";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const LP_TOKEN_ADDRESS = "CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM";
const START_DATE = "2025-04-15";

const GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT;
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;

export interface LpPriceBackfillOptions {
  filePath: string;
  dryRun?: boolean;
  skipConfirmation?: boolean;
}

export interface LpPriceRow {
  price_date: string;
  lp_token_price: number;
  ledger_sequence?: number;
}

export interface BackfillResult {
  success: boolean;
  rowsProcessed: number;
  rowsInserted: number;
  rowsSkipped: number;
  error?: string;
}

export interface LpPriceStats {
  totalPrices: number;
  earliestDate: string | null;
  latestDate: string | null;
}

export interface LpPriceBackfillParams {
  startDate?: string;
  endDate?: string;
  limit?: number;
}

export interface CostEstimate {
  bytes: number;
  gb: string;
  cost: string;
  query: string;
}

export interface SimulateResult {
  success: boolean;
  rows: LpPriceRow[];
  estimated_cost: string;
  query: string;
  error?: string;
}

export interface BigQueryBackfillResult {
  success: boolean;
  rows_fetched: number;
  rows_inserted: number;
  rows_updated: number;
  rows_skipped: number;
  estimated_cost: string;
  error?: string;
}

export class LpPriceBackfillService {
  private pool: Pool;
  private bigQueryClient: BigQuery;

  constructor(pool: Pool) {
    this.pool = pool;

    // Initialize BigQuery client
    const options: { projectId?: string; keyFilename?: string } = {};
    if (GOOGLE_CLOUD_PROJECT) {
      options.projectId = GOOGLE_CLOUD_PROJECT;
    }
    if (GOOGLE_APPLICATION_CREDENTIALS) {
      options.keyFilename = GOOGLE_APPLICATION_CREDENTIALS;
    }
    this.bigQueryClient = new BigQuery(options);
  }

  /**
   * Get the BigQuery query for fetching LP prices
   */
  getBigQueryQuery(startDate: string = START_DATE, endDate?: string): string {
    const endDateClause = endDate ? `AND closed_at < '${endDate}'` : "";

    return `
WITH total_shares AS (
  SELECT
    ledger_sequence,
    closed_at,
    DATE(closed_at) as price_date,
    CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.i128') AS NUMERIC) as total_lp_tokens
  FROM \`crypto-stellar.crypto_stellar.contract_data\`
  WHERE contract_id = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM'
    AND JSON_EXTRACT_SCALAR(key_decoded, '$.vec[0].symbol') = 'TotalShares'
    AND closed_at >= '${startDate}'
    ${endDateClause}
),
record_data AS (
  SELECT
    ledger_sequence,
    CAST(JSON_EXTRACT_SCALAR(val_decoded, '$.map[0].val.map[0].val.i128') AS NUMERIC) as usdc_balance
  FROM \`crypto-stellar.crypto_stellar.contract_data\`
  WHERE contract_id = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM'
    AND JSON_EXTRACT_SCALAR(key_decoded, '$.vec[0].symbol') = 'AllRecordData'
    AND closed_at >= '${startDate}'
    ${endDateClause}
),
combined AS (
  SELECT
    t.price_date,
    t.ledger_sequence,
    (5.0 * r.usdc_balance / t.total_lp_tokens) as lp_token_price,
    ROW_NUMBER() OVER (PARTITION BY t.price_date ORDER BY t.ledger_sequence DESC) as rn
  FROM total_shares t
  JOIN record_data r ON t.ledger_sequence = r.ledger_sequence
)
SELECT
  price_date,
  lp_token_price,
  ledger_sequence
FROM combined
WHERE rn = 1
ORDER BY price_date
`.trim();
  }

  /**
   * Parse JSON file containing LP price data
   */
  parseFile(filePath: string): LpPriceRow[] {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const content = fs.readFileSync(filePath, "utf-8");

    // Handle newline-delimited JSON (BigQuery export format)
    if (filePath.endsWith(".ndjson") || filePath.endsWith(".jsonl")) {
      const lines = content.trim().split("\n");
      return lines.map((line) => JSON.parse(line));
    }

    // Handle regular JSON
    const data = JSON.parse(content);

    // Array of objects
    if (Array.isArray(data)) {
      return data;
    }

    // BigQuery export with rows property
    if (data.rows && Array.isArray(data.rows)) {
      return data.rows;
    }

    throw new Error(
      "Unexpected JSON format. Expected array of { price_date, lp_token_price }"
    );
  }

  /**
   * Validate and normalize a price row
   */
  validateRow(row: LpPriceRow): { valid: boolean; priceDate?: string; price?: number; error?: string } {
    // Normalize date format
    let priceDate = row.price_date;
    if (priceDate.includes("T")) {
      priceDate = priceDate.split("T")[0];
    }

    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(priceDate)) {
      return { valid: false, error: `Invalid date format: ${row.price_date}` };
    }

    // Validate price
    const price = Number(row.lp_token_price);
    if (isNaN(price) || price <= 0) {
      return { valid: false, error: `Invalid price: ${row.lp_token_price}` };
    }

    return { valid: true, priceDate, price };
  }

  /**
   * Get existing LP price dates from the database
   */
  async getExistingDates(): Promise<Set<string>> {
    const result = await this.pool.query(
      `
      SELECT price_date::text
      FROM daily_token_prices
      WHERE token_address = $1
    `,
      [LP_TOKEN_ADDRESS]
    );

    return new Set(result.rows.map((r) => r.price_date.split("T")[0]));
  }

  /**
   * Get stats about existing LP prices
   */
  async getStats(): Promise<LpPriceStats> {
    const result = await this.pool.query(
      `
      SELECT
        COUNT(*) as total,
        MIN(price_date)::text as earliest,
        MAX(price_date)::text as latest
      FROM daily_token_prices
      WHERE token_address = $1
    `,
      [LP_TOKEN_ADDRESS]
    );

    const row = result.rows[0];
    return {
      totalPrices: parseInt(row.total) || 0,
      earliestDate: row.earliest?.split("T")[0] || null,
      latestDate: row.latest?.split("T")[0] || null,
    };
  }

  /**
   * Run the backfill
   */
  async runBackfill(options: LpPriceBackfillOptions): Promise<BackfillResult> {
    const { filePath, dryRun = false } = options;

    try {
      // Parse input file
      console.log(`\nStep 1: Parsing input file...`);
      const data = this.parseFile(filePath);
      console.log(`✓ Parsed ${data.length} records from file`);

      if (data.length === 0) {
        return {
          success: true,
          rowsProcessed: 0,
          rowsInserted: 0,
          rowsSkipped: 0,
        };
      }

      // Show date range
      const sortedData = [...data].sort((a, b) =>
        a.price_date.localeCompare(b.price_date)
      );
      console.log(
        `  Date range: ${sortedData[0].price_date} to ${sortedData[sortedData.length - 1].price_date}`
      );
      console.log(
        `  Sample: ${sortedData[0].price_date} = $${Number(sortedData[0].lp_token_price).toFixed(6)}`
      );

      // Get existing dates
      console.log(`\nStep 2: Checking existing data...`);
      const existingDates = await this.getExistingDates();
      console.log(`✓ Found ${existingDates.size} existing price dates`);

      // Validate and filter data
      console.log(`\nStep 3: Validating data...`);
      const validRows: Array<{ priceDate: string; price: number }> = [];
      const errors: string[] = [];
      let skippedExisting = 0;

      for (const row of data) {
        const validation = this.validateRow(row);

        if (!validation.valid) {
          errors.push(validation.error!);
          continue;
        }

        if (existingDates.has(validation.priceDate!)) {
          skippedExisting++;
          continue;
        }

        validRows.push({
          priceDate: validation.priceDate!,
          price: validation.price!,
        });
      }

      console.log(`✓ Valid rows to insert: ${validRows.length}`);
      console.log(`  Skipped (already exists): ${skippedExisting}`);
      if (errors.length > 0) {
        console.log(`  Skipped (validation errors): ${errors.length}`);
        if (errors.length <= 5) {
          errors.forEach((err) => console.log(`    - ${err}`));
        }
      }

      if (validRows.length === 0) {
        console.log(`\n⚠️  No new rows to insert`);
        return {
          success: true,
          rowsProcessed: data.length,
          rowsInserted: 0,
          rowsSkipped: skippedExisting + errors.length,
        };
      }

      // Dry run mode
      if (dryRun) {
        console.log(`\nStep 4: DRY RUN - Would insert ${validRows.length} rows`);
        console.log(`\n📋 Sample rows that would be inserted:`);

        const sampleRows = validRows.slice(0, 5);
        for (const row of sampleRows) {
          console.log(`  ${row.priceDate}: $${row.price.toFixed(6)}`);
        }
        if (validRows.length > 5) {
          console.log(`  ... and ${validRows.length - 5} more`);
        }

        return {
          success: true,
          rowsProcessed: data.length,
          rowsInserted: 0,
          rowsSkipped: skippedExisting + errors.length,
        };
      }

      // Insert rows
      console.log(`\nStep 4: Inserting ${validRows.length} rows...`);

      let inserted = 0;
      for (const row of validRows) {
        await this.pool.query(
          `
          INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
          VALUES ($1, $2, $3, 'hubble')
          ON CONFLICT (token_address, price_date)
          DO UPDATE SET usd_price = EXCLUDED.usd_price, source = 'hubble'
        `,
          [LP_TOKEN_ADDRESS, row.priceDate, row.price]
        );
        inserted++;
      }

      console.log(`✓ Inserted ${inserted} rows`);

      return {
        success: true,
        rowsProcessed: data.length,
        rowsInserted: inserted,
        rowsSkipped: skippedExisting + errors.length,
      };
    } catch (error) {
      console.error(`\n❌ Backfill failed:`, error);
      return {
        success: false,
        rowsProcessed: 0,
        rowsInserted: 0,
        rowsSkipped: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get cost estimate for a BigQuery query with given parameters
   */
  async getCostEstimate(params: LpPriceBackfillParams): Promise<CostEstimate> {
    const startDate = params.startDate || START_DATE;
    const endDate = params.endDate;
    const query = this.getBigQueryQuery(startDate, endDate);

    console.log(`📊 Getting cost estimate for LP price backfill...`);
    console.log(`   Date range: ${startDate} to ${endDate || "now"}`);

    const [job] = await this.bigQueryClient.createQueryJob({
      query,
      useLegacySql: false,
      dryRun: true,
      location: "US",
    });

    const estimatedBytes = parseInt(
      job.metadata?.statistics?.totalBytesProcessed || "0"
    );
    const estimatedGB = (estimatedBytes / 1024 ** 3).toFixed(2);
    const estimatedCost = ((estimatedBytes / 1024 ** 4) * 5).toFixed(4);

    console.log(`✓ Estimated: ${estimatedGB} GB = $${estimatedCost}`);

    return {
      bytes: estimatedBytes,
      gb: estimatedGB,
      cost: estimatedCost,
      query,
    };
  }

  /**
   * Simulate the backfill - fetch data from BigQuery without saving
   */
  async simulate(params: LpPriceBackfillParams): Promise<SimulateResult> {
    try {
      console.log("\n🔍 Simulating LP price backfill (dry run)...");

      // Get cost estimate first
      const estimate = await this.getCostEstimate(params);

      // Build query with limit for simulation
      const startDate = params.startDate || START_DATE;
      const endDate = params.endDate;
      let query = this.getBigQueryQuery(startDate, endDate);

      // Add limit for simulation
      const limit = params.limit || 100;
      query = query + `\nLIMIT ${limit}`;

      console.log("Executing simulation query...");
      const [rows] = await this.bigQueryClient.query({
        query,
        useLegacySql: false,
        location: "US",
        jobTimeoutMs: 300000,
      });

      console.log(`✓ Fetched ${rows.length} sample rows`);

      // Convert BigQuery rows to LpPriceRow format
      const priceRows: LpPriceRow[] = rows.map((row: any) => ({
        price_date:
          typeof row.price_date === "object"
            ? row.price_date.value
            : row.price_date,
        lp_token_price: parseFloat(row.lp_token_price),
        ledger_sequence: parseInt(row.ledger_sequence),
      }));

      return {
        success: true,
        rows: priceRows,
        estimated_cost: estimate.cost,
        query: estimate.query,
      };
    } catch (error) {
      console.error("❌ Simulation failed:", error);
      return {
        success: false,
        rows: [],
        estimated_cost: "0",
        query: "",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Run the full backfill from BigQuery - fetch and save to database
   */
  async runFromBigQuery(
    params: LpPriceBackfillParams
  ): Promise<BigQueryBackfillResult> {
    try {
      console.log("\n🔄 Starting LP price backfill from BigQuery...");

      const startDate = params.startDate || START_DATE;
      const endDate = params.endDate;

      console.log(`Date range: ${startDate} to ${endDate || "now"}`);

      // Step 1: Get cost estimate
      console.log("\nStep 1: Getting cost estimate...");
      const estimate = await this.getCostEstimate(params);
      console.log(`Estimated cost: $${estimate.cost} (${estimate.gb} GB)`);

      // Step 2: Execute query
      console.log("\nStep 2: Fetching data from BigQuery...");
      let query = this.getBigQueryQuery(startDate, endDate);

      // Add limit if specified
      if (params.limit) {
        query = query + `\nLIMIT ${params.limit}`;
      }

      const [rows] = await this.bigQueryClient.query({
        query,
        useLegacySql: false,
        location: "US",
        jobTimeoutMs: 600000, // 10 minutes
      });

      console.log(`✓ Fetched ${rows.length} rows from BigQuery`);

      if (rows.length === 0) {
        return {
          success: true,
          rows_fetched: 0,
          rows_inserted: 0,
          rows_updated: 0,
          rows_skipped: 0,
          estimated_cost: estimate.cost,
        };
      }

      // Step 3: Get existing dates to avoid duplicates
      console.log("\nStep 3: Checking existing data...");
      const existingDates = await this.getExistingDates();
      console.log(`Found ${existingDates.size} existing price dates`);

      // Step 4: Insert/update rows
      console.log("\nStep 4: Inserting/updating rows...");
      let inserted = 0;
      let updated = 0;
      let skipped = 0;

      for (const row of rows) {
        // Normalize date format
        let priceDate =
          typeof row.price_date === "object"
            ? row.price_date.value
            : row.price_date;
        if (priceDate.includes("T")) {
          priceDate = priceDate.split("T")[0];
        }

        const price = parseFloat(row.lp_token_price);
        if (isNaN(price) || price <= 0) {
          console.log(`  Skipping invalid price for ${priceDate}: ${row.lp_token_price}`);
          skipped++;
          continue;
        }

        // Track if this is an update or insert
        const isUpdate = existingDates.has(priceDate);

        await this.pool.query(
          `
          INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
          VALUES ($1, $2, $3, 'hubble')
          ON CONFLICT (token_address, price_date)
          DO UPDATE SET usd_price = EXCLUDED.usd_price, source = 'hubble'
        `,
          [LP_TOKEN_ADDRESS, priceDate, price]
        );

        if (isUpdate) {
          updated++;
        } else {
          inserted++;
        }
      }

      console.log(`✓ Inserted ${inserted} rows, updated ${updated}, skipped ${skipped}`);

      return {
        success: true,
        rows_fetched: rows.length,
        rows_inserted: inserted,
        rows_updated: updated,
        rows_skipped: skipped,
        estimated_cost: estimate.cost,
      };
    } catch (error) {
      console.error("\n❌ BigQuery backfill failed:", error);
      return {
        success: false,
        rows_fetched: 0,
        rows_inserted: 0,
        rows_updated: 0,
        rows_skipped: 0,
        estimated_cost: "0",
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
