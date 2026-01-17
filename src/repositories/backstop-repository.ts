import { pool } from '../config/database';

export interface BackstopEventRow {
  id: string;
  transaction_hash: string;
  ledger_sequence: number;
  ledger_closed_at: Date | string;
  action_type: string;
  pool_address: string | null;  // NULL for claim (global across pools)
  user_address: string | null;
  lp_tokens: string | null;     // LP tokens deposited/withdrawn/claimed
  shares: string | null;        // Backstop shares received/burned/queued
  q4w_exp: number | null;       // Queue withdrawal expiration timestamp
  emissions_amount: string | null;  // BLND tokens gulped (gulp_emissions only)
  emissions_shares: string | null;  // Shares/tokens delta (gulp_emissions only)
  src: 'bq' | 'gs' | 'csv';     // 'bq' = BigQuery backfill, 'gs' = Goldsky, 'csv' = CSV upload
}

export class BackstopRepository {
  /**
   * Insert backstop events in a batch with transaction
   * Uses ON CONFLICT DO UPDATE for idempotency
   * Automatically chunks large batches to avoid PostgreSQL parameter limit (65535)
   */
  async insertBatch(rows: BackstopEventRow[]): Promise<{ inserted: number; updated: number }> {
    if (rows.length === 0) {
      return { inserted: 0, updated: 0 };
    }

    // Deduplicate rows by ID (PostgreSQL ON CONFLICT can't handle same ID twice in one INSERT)
    const uniqueRows = this.deduplicateById(rows);
    if (uniqueRows.length < rows.length) {
      const duplicateCount = rows.length - uniqueRows.length;
      console.log(`   Deduplicated: ${rows.length} → ${uniqueRows.length} rows (${duplicateCount} duplicates removed)`);
    }

    // PostgreSQL has a 65535 parameter limit
    // With 13 parameters per row, we can safely do ~5000 rows per batch
    const CHUNK_SIZE = 5000;

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

    return this.insertBatchChunk(uniqueRows);
  }

  /**
   * Deduplicate rows by ID, keeping the last occurrence
   */
  private deduplicateById(rows: BackstopEventRow[]): BackstopEventRow[] {
    const seen = new Map<string, BackstopEventRow>();
    for (const row of rows) {
      seen.set(row.id, row);
    }
    return Array.from(seen.values());
  }

  /**
   * Insert a single chunk of backstop events (internal method)
   */
  private async insertBatchChunk(rows: BackstopEventRow[]): Promise<{ inserted: number; updated: number }> {
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
        const offset = index * 13;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13})`
        );

        values.push(
          row.id,
          row.transaction_hash,
          row.ledger_sequence,
          row.ledger_closed_at,
          row.action_type,
          row.pool_address,
          row.user_address,
          row.lp_tokens,
          row.shares,
          row.q4w_exp,
          row.emissions_amount,
          row.emissions_shares,
          row.src
        );
      });

      const query = `
        INSERT INTO backstop_events (
          id, transaction_hash, ledger_sequence, ledger_closed_at,
          action_type, pool_address, user_address,
          lp_tokens, shares, q4w_exp, emissions_amount, emissions_shares, src
        )
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (id)
        DO UPDATE SET
          transaction_hash = EXCLUDED.transaction_hash,
          ledger_sequence = EXCLUDED.ledger_sequence,
          ledger_closed_at = EXCLUDED.ledger_closed_at,
          action_type = EXCLUDED.action_type,
          pool_address = EXCLUDED.pool_address,
          user_address = EXCLUDED.user_address,
          lp_tokens = EXCLUDED.lp_tokens,
          shares = EXCLUDED.shares,
          q4w_exp = EXCLUDED.q4w_exp,
          emissions_amount = EXCLUDED.emissions_amount,
          emissions_shares = EXCLUDED.emissions_shares,
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
      console.error('Error inserting backstop events:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get statistics about backstop events
   */
  async getStats(): Promise<{
    total_rows: number;
    latest_ledger: number;
    unique_users: number;
    unique_pools: number;
    action_counts: Record<string, number>;
  }> {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_rows,
        MAX(ledger_sequence) as latest_ledger,
        COUNT(DISTINCT user_address) as unique_users,
        COUNT(DISTINCT pool_address) as unique_pools
      FROM backstop_events
    `);

    const actionCounts = await pool.query(`
      SELECT action_type, COUNT(*) as count
      FROM backstop_events
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
      unique_pools: parseInt(result.rows[0].unique_pools, 10),
      action_counts,
    };
  }

  /**
   * Filter out BQ rows that already have matching GS records (content-based deduplication)
   * This prevents inserting BQ records when a GS record with the same content exists
   */
  async filterExistingGsRecords(rows: BackstopEventRow[]): Promise<BackstopEventRow[]> {
    if (rows.length === 0) {
      return [];
    }

    const client = await pool.connect();

    try {
      // Start explicit transaction to keep temp table alive (Neon drops on autocommit)
      await client.query('BEGIN');

      // Create a temp table with the BQ records to check
      await client.query(`
        CREATE TEMP TABLE temp_backstop_bq_check (
          idx INTEGER,
          transaction_hash TEXT,
          pool_address TEXT,
          action_type TEXT,
          user_address TEXT,
          lp_tokens TEXT,
          shares TEXT,
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
          row.pool_address,
          row.action_type,
          row.user_address,
          row.lp_tokens,
          row.shares,
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
            `INSERT INTO temp_backstop_bq_check (idx, transaction_hash, pool_address, action_type, user_address, lp_tokens, shares, ledger_sequence)
             VALUES ${chunkPlaceholders.join(', ')}`,
            chunkValues
          );
        }
      }

      // Find indices of BQ records that have matching GS records
      // Cast numeric columns to TEXT for comparison since temp table stores TEXT
      const matchResult = await client.query(`
        SELECT DISTINCT t.idx
        FROM temp_backstop_bq_check t
        JOIN backstop_events p ON
          p.transaction_hash = t.transaction_hash
          AND p.pool_address IS NOT DISTINCT FROM t.pool_address
          AND p.action_type = t.action_type
          AND p.user_address IS NOT DISTINCT FROM t.user_address
          AND p.lp_tokens::TEXT IS NOT DISTINCT FROM t.lp_tokens
          AND p.shares::TEXT IS NOT DISTINCT FROM t.shares
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
      FROM backstop_events
    `);
    return parseInt(result.rows[0].latest_ledger, 10) || 0;
  }

  /**
   * Delete all backstop events (for testing/reset)
   */
  async deleteAll(): Promise<number> {
    const result = await pool.query('DELETE FROM backstop_events RETURNING id');
    return result.rowCount || 0;
  }
}

export const backstopRepository = new BackstopRepository();
