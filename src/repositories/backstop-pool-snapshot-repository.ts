import { pool } from '../config/database';
import { BackstopPoolSnapshotRow } from '../types';

export class BackstopPoolSnapshotRepository {
  /**
   * Insert backstop pool snapshots in a batch with transaction
   * Uses ON CONFLICT DO UPDATE for idempotency
   */
  async insertBatch(rows: BackstopPoolSnapshotRow[]): Promise<{ inserted: number; updated: number }> {
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
        const offset = index * 8;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8})`
        );

        values.push(
          row.pool_address,
          row.snapshot_date,
          row.snapshot_timestamp,
          row.ledger_sequence,
          row.shares,
          row.tokens,
          row.q4w,
          row.q4w_pct
        );
      });

      const query = `
        INSERT INTO backstop_pool_snapshots (
          pool_address, snapshot_date, snapshot_timestamp,
          ledger_sequence, shares, tokens, q4w, q4w_pct
        )
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (pool_address, snapshot_date)
        DO UPDATE SET
          snapshot_timestamp = EXCLUDED.snapshot_timestamp,
          ledger_sequence = EXCLUDED.ledger_sequence,
          shares = EXCLUDED.shares,
          tokens = EXCLUDED.tokens,
          q4w = EXCLUDED.q4w,
          q4w_pct = EXCLUDED.q4w_pct
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
      console.error('Error inserting backstop pool snapshots:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get the latest snapshot date in the table
   */
  async getLatestSnapshotDate(): Promise<string | null> {
    const result = await pool.query(
      'SELECT MAX(snapshot_date)::text as latest_date FROM backstop_pool_snapshots'
    );
    return result.rows[0]?.latest_date || null;
  }

  /**
   * Get statistics about backstop pool snapshots
   */
  async getStats(): Promise<{
    total_rows: number;
    latest_date: string;
    earliest_date: string;
    unique_pools: number;
  }> {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_rows,
        MAX(snapshot_date)::text as latest_date,
        MIN(snapshot_date)::text as earliest_date,
        COUNT(DISTINCT pool_address) as unique_pools
      FROM backstop_pool_snapshots
    `);

    return {
      total_rows: parseInt(result.rows[0].total_rows, 10),
      latest_date: result.rows[0].latest_date || 'N/A',
      earliest_date: result.rows[0].earliest_date || 'N/A',
      unique_pools: parseInt(result.rows[0].unique_pools, 10),
    };
  }

  /**
   * Get Q4W percentage history for a specific pool
   */
  async getQ4wHistory(poolAddress: string, startDate?: string, endDate?: string): Promise<{
    snapshot_date: string;
    shares: string;
    tokens: string;
    q4w: string;
    q4w_pct: number;
  }[]> {
    let query = `
      SELECT snapshot_date::text, shares, tokens, q4w, q4w_pct
      FROM backstop_pool_snapshots
      WHERE pool_address = $1
    `;
    const params: any[] = [poolAddress];

    if (startDate) {
      params.push(startDate);
      query += ` AND snapshot_date >= $${params.length}`;
    }
    if (endDate) {
      params.push(endDate);
      query += ` AND snapshot_date <= $${params.length}`;
    }

    query += ' ORDER BY snapshot_date ASC';

    const result = await pool.query(query, params);
    return result.rows;
  }

  /**
   * Get existing snapshot dates for filtering duplicates
   */
  async getExistingDates(poolAddress?: string): Promise<Set<string>> {
    let query = 'SELECT DISTINCT snapshot_date::text as date FROM backstop_pool_snapshots';
    const params: any[] = [];

    if (poolAddress) {
      query += ' WHERE pool_address = $1';
      params.push(poolAddress);
    }

    const result = await pool.query(query, params);
    return new Set(result.rows.map(r => r.date.split('T')[0]));
  }

  /**
   * Get all pools with their latest Q4W percentage
   */
  async getLatestQ4wByPool(): Promise<{
    pool_address: string;
    snapshot_date: string;
    q4w_pct: number;
    shares: string;
    tokens: string;
    q4w: string;
  }[]> {
    const result = await pool.query(`
      SELECT DISTINCT ON (pool_address)
        pool_address,
        snapshot_date::text,
        q4w_pct,
        shares,
        tokens,
        q4w
      FROM backstop_pool_snapshots
      ORDER BY pool_address, snapshot_date DESC
    `);

    return result.rows;
  }
}

export const backstopPoolSnapshotRepository = new BackstopPoolSnapshotRepository();
