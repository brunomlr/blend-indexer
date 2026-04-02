import { pool } from '../config/database';

export interface AuctionAssetEntry {
  asset: string;
  amount: string;
}

export interface BlendActionRow {
  id: string;
  pool_id: string;
  transaction_hash: string;
  ledger_sequence: number;
  ledger_closed_at: Date | string;
  action_type: string;
  asset_address: string | null;
  user_address: string | null;
  amount_underlying: string | null;
  amount_tokens: string | null;
  implied_rate: string | null;
  // Auction-specific fields
  auction_type: string | null;        // 0=liquidation, 1=bad_debt, 2=interest
  filler_address: string | null;      // Who filled the auction (fill_auction only)
  liquidation_percent: string | null; // % of position (new_auction) or fill % (fill_auction)
  // Auction bid/lot data (scalar - first asset only, kept for backward compat)
  bid_asset: string | null;           // First asset in bid (what filler pays)
  bid_amount: string | null;          // Amount of bid asset
  lot_asset: string | null;           // First asset in lot (what filler receives)
  lot_amount: string | null;          // Amount of lot asset
  // Auction bid/lot data (JSONB - all assets)
  bid_assets: AuctionAssetEntry[] | null;  // All bid assets [{asset, amount}, ...]
  lot_assets: AuctionAssetEntry[] | null;  // All lot assets [{asset, amount}, ...]
  // Data source
  src: 'bq' | 'gs' | 'csv';           // 'bq' = BigQuery backfill, 'gs' = Goldsky, 'csv' = CSV upload
}

export class ActionsRepository {
  /**
   * Insert blend actions in a batch with transaction
   * Uses ON CONFLICT DO UPDATE for idempotency
   * Automatically chunks large batches to avoid PostgreSQL parameter limit (65535)
   */
  async insertBatch(rows: BlendActionRow[]): Promise<{ inserted: number; updated: number }> {
    if (rows.length === 0) {
      return { inserted: 0, updated: 0 };
    }

    // Deduplicate rows by ID (PostgreSQL ON CONFLICT can't handle same ID twice in one INSERT)
    const uniqueRows = this.deduplicateById(rows);
    if (uniqueRows.length < rows.length) {
      const duplicateCount = rows.length - uniqueRows.length;
      console.log(`   Deduplicated: ${rows.length} → ${uniqueRows.length} rows (${duplicateCount} duplicates removed)`);

      // Debug: Find sample duplicate IDs
      const idCounts = new Map<string, number>();
      for (const row of rows) {
        idCounts.set(row.id, (idCounts.get(row.id) || 0) + 1);
      }
      const duplicateIds = Array.from(idCounts.entries())
        .filter(([, count]) => count > 1)
        .slice(0, 5);
      console.log('   Sample duplicate IDs:');
      duplicateIds.forEach(([id, count]) => {
        console.log(`     - ${id} (appears ${count} times)`);
      });
    }

    // PostgreSQL has a 65535 parameter limit
    // With 21 parameters per row, we can safely do ~3100 rows per batch
    const CHUNK_SIZE = 3100;

    // If we have more rows than the chunk size, process in chunks
    if (uniqueRows.length > CHUNK_SIZE) {
      console.log(`⚠️  Large batch detected (${uniqueRows.length} rows). Processing in chunks of ${CHUNK_SIZE}...`);

      let totalInserted = 0;
      let totalUpdated = 0;

      for (let i = 0; i < uniqueRows.length; i += CHUNK_SIZE) {
        const chunk = uniqueRows.slice(i, i + CHUNK_SIZE);
        console.log(`   Processing chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(uniqueRows.length / CHUNK_SIZE)} (${chunk.length} rows)...`);

        const result = await this.insertBatchChunk(chunk);
        totalInserted += result.inserted;
        totalUpdated += result.updated;
      }

      return { inserted: totalInserted, updated: totalUpdated };
    }

    // For small batches, process directly
    return this.insertBatchChunk(uniqueRows);
  }

  /**
   * Deduplicate rows by ID, keeping the last occurrence
   */
  private deduplicateById(rows: BlendActionRow[]): BlendActionRow[] {
    const seen = new Map<string, BlendActionRow>();
    for (const row of rows) {
      seen.set(row.id, row);
    }
    return Array.from(seen.values());
  }

  /**
   * Insert a single chunk of blend actions (internal method)
   * Should not be called directly - use insertBatch instead
   */
  private async insertBatchChunk(rows: BlendActionRow[]): Promise<{ inserted: number; updated: number }> {
    if (rows.length === 0) {
      return { inserted: 0, updated: 0 };
    }

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // Build multi-row INSERT statement
      const values: any[] = [];
      const placeholders: string[] = [];

      rows.forEach((row, index) => {
        const offset = index * 21;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, $${offset + 17}, $${offset + 18}, $${offset + 19}, $${offset + 20}, $${offset + 21})`
        );

        values.push(
          row.id,
          row.pool_id,
          row.transaction_hash,
          row.ledger_sequence,
          row.ledger_closed_at,
          row.action_type,
          row.asset_address,
          row.user_address,
          row.amount_underlying,
          row.amount_tokens,
          row.implied_rate,
          row.auction_type,
          row.filler_address,
          row.liquidation_percent,
          row.bid_asset,
          row.bid_amount,
          row.lot_asset,
          row.lot_amount,
          row.bid_assets ? JSON.stringify(row.bid_assets) : null,
          row.lot_assets ? JSON.stringify(row.lot_assets) : null,
          row.src
        );
      });

      const query = `
        INSERT INTO parsed_events (
          id, pool_id, transaction_hash, ledger_sequence, ledger_closed_at,
          action_type, asset_address, user_address,
          amount_underlying, amount_tokens, implied_rate,
          auction_type, filler_address, liquidation_percent,
          bid_asset, bid_amount, lot_asset, lot_amount,
          bid_assets, lot_assets, src
        )
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (id)
        DO UPDATE SET
          pool_id = EXCLUDED.pool_id,
          transaction_hash = EXCLUDED.transaction_hash,
          ledger_sequence = EXCLUDED.ledger_sequence,
          ledger_closed_at = EXCLUDED.ledger_closed_at,
          action_type = EXCLUDED.action_type,
          asset_address = EXCLUDED.asset_address,
          user_address = EXCLUDED.user_address,
          amount_underlying = EXCLUDED.amount_underlying,
          amount_tokens = EXCLUDED.amount_tokens,
          implied_rate = EXCLUDED.implied_rate,
          auction_type = EXCLUDED.auction_type,
          filler_address = EXCLUDED.filler_address,
          liquidation_percent = EXCLUDED.liquidation_percent,
          bid_asset = EXCLUDED.bid_asset,
          bid_amount = EXCLUDED.bid_amount,
          lot_asset = EXCLUDED.lot_asset,
          lot_amount = EXCLUDED.lot_amount,
          bid_assets = EXCLUDED.bid_assets,
          lot_assets = EXCLUDED.lot_assets,
          src = EXCLUDED.src
        RETURNING (xmax = 0) AS inserted;
      `;

      const result = await client.query(query, values);

      await client.query('COMMIT');

      // Count inserts vs updates
      const inserted = result.rows.filter(r => r.inserted).length;
      const updated = result.rows.length - inserted;

      return { inserted, updated };

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error inserting blend actions:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get statistics about blend actions
   */
  async getStats(): Promise<{
    total_rows: number;
    latest_ledger: number;
    unique_users: number;
    action_counts: Record<string, number>;
  }> {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_rows,
        MAX(ledger_sequence) as latest_ledger,
        COUNT(DISTINCT user_address) as unique_users
      FROM parsed_events
    `);

    const actionCounts = await pool.query(`
      SELECT action_type, COUNT(*) as count
      FROM parsed_events
      GROUP BY action_type
      ORDER BY count DESC
    `);

    const action_counts: Record<string, number> = {};
    for (const row of actionCounts.rows) {
      action_counts[row.action_type] = parseInt(row.count, 10);
    }

    return {
      total_rows: parseInt(result.rows[0].total_rows, 10),
      latest_ledger: parseInt(result.rows[0].latest_ledger, 10) || 0,
      unique_users: parseInt(result.rows[0].unique_users, 10),
      action_counts,
    };
  }

  /**
   * Filter out BQ rows that already have matching GS records (content-based deduplication)
   * This prevents inserting BQ records when a GS record with the same content exists
   */
  async filterExistingGsRecords(rows: BlendActionRow[]): Promise<BlendActionRow[]> {
    if (rows.length === 0) {
      return [];
    }

    // Build a query to find existing GS records matching the content
    const client = await pool.connect();

    try {
      // Start explicit transaction to keep temp table alive (Neon drops on autocommit)
      await client.query('BEGIN');

      // Create a temp table with the BQ records to check
      await client.query(`
        CREATE TEMP TABLE temp_bq_check (
          idx INTEGER,
          transaction_hash TEXT,
          pool_id TEXT,
          action_type TEXT,
          user_address TEXT,
          amount_underlying TEXT,
          amount_tokens TEXT,
          ledger_sequence BIGINT
        ) ON COMMIT DROP
      `);

      // Insert BQ records into temp table
      const values: any[] = [];
      const placeholders: string[] = [];

      rows.forEach((row, index) => {
        const offset = index * 8;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`
        );
        values.push(
          index,
          row.transaction_hash,
          row.pool_id,
          row.action_type,
          row.user_address,
          row.amount_underlying,
          row.amount_tokens,
          row.ledger_sequence
        );
      });

      // Chunk the insert if needed (65535 / 8 = ~8000 rows max)
      const CHUNK_SIZE = 8000;
      for (let i = 0; i < placeholders.length; i += CHUNK_SIZE) {
        const chunkPlaceholders = placeholders.slice(i, i + CHUNK_SIZE);
        const chunkValues = values.slice(i * 8, (i + CHUNK_SIZE) * 8);

        if (chunkPlaceholders.length > 0) {
          await client.query(
            `INSERT INTO temp_bq_check (idx, transaction_hash, pool_id, action_type, user_address, amount_underlying, amount_tokens, ledger_sequence)
             VALUES ${chunkPlaceholders.join(', ')}`,
            chunkValues
          );
        }
      }

      // Find indices of BQ records that have matching GS records
      // Cast numeric columns to TEXT for comparison since temp table stores TEXT
      const matchResult = await client.query(`
        SELECT DISTINCT t.idx
        FROM temp_bq_check t
        JOIN parsed_events p ON
          p.transaction_hash = t.transaction_hash
          AND p.pool_id = t.pool_id
          AND p.action_type = t.action_type
          AND p.user_address IS NOT DISTINCT FROM t.user_address
          AND p.amount_underlying::TEXT IS NOT DISTINCT FROM t.amount_underlying
          AND p.amount_tokens::TEXT IS NOT DISTINCT FROM t.amount_tokens
          AND p.ledger_sequence = t.ledger_sequence
          AND p.src = 'gs'
      `);

      // Commit transaction (temp table will be dropped)
      await client.query('COMMIT');

      const matchingIndices = new Set(matchResult.rows.map(r => r.idx));

      // Filter out the matching rows
      const filteredRows = rows.filter((_, index) => !matchingIndices.has(index));

      const skippedCount = rows.length - filteredRows.length;
      if (skippedCount > 0) {
        console.log(`   Skipped ${skippedCount} BQ records that already have matching GS records`);
      }

      return filteredRows;

    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get the latest ledger sequence in the database
   */
  async getLatestLedger(): Promise<number> {
    const result = await pool.query(`
      SELECT MAX(ledger_sequence) as latest_ledger
      FROM parsed_events
    `);
    return parseInt(result.rows[0].latest_ledger, 10) || 0;
  }

  /**
   * Delete all actions (for testing/reset)
   */
  async deleteAll(): Promise<number> {
    const result = await pool.query('DELETE FROM parsed_events RETURNING id');
    return result.rowCount || 0;
  }
}

export const actionsRepository = new ActionsRepository();
