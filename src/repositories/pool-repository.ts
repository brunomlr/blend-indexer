import { pool } from '../config/database';
import { PoolSnapshotRow } from '../types';

export class PoolRepository {
  /**
   * Insert pool snapshots in a batch with transaction
   * Uses ON CONFLICT DO UPDATE for idempotency
   */
  async insertBatch(rows: PoolSnapshotRow[]): Promise<{ inserted: number; updated: number }> {
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
        const offset = index * 10;
        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`
        );

        values.push(
          row.pool_id,
          row.asset_address,
          row.snapshot_date,
          row.snapshot_timestamp,
          row.ledger_sequence,
          row.b_rate,
          row.d_rate,
          row.b_supply,
          row.d_supply,
          row.last_time
        );
      });

      const query = `
        INSERT INTO pool_snapshots (
          pool_id, asset_address, snapshot_date, snapshot_timestamp,
          ledger_sequence, b_rate, d_rate, b_supply, d_supply, last_time
        )
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (pool_id, asset_address, snapshot_date)
        DO UPDATE SET
          snapshot_timestamp = EXCLUDED.snapshot_timestamp,
          ledger_sequence = EXCLUDED.ledger_sequence,
          b_rate = EXCLUDED.b_rate,
          d_rate = EXCLUDED.d_rate,
          b_supply = EXCLUDED.b_supply,
          d_supply = EXCLUDED.d_supply,
          last_time = EXCLUDED.last_time
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
      console.error('Error inserting pool snapshots:', error);
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
      'SELECT MAX(snapshot_date)::text as latest_date FROM pool_snapshots'
    );
    return result.rows[0]?.latest_date || null;
  }

  /**
   * Get statistics about pool snapshots
   */
  async getStats(): Promise<{
    total_rows: number;
    latest_date: string;
    unique_assets: number;
  }> {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_rows,
        MAX(snapshot_date)::text as latest_date,
        COUNT(DISTINCT asset_address) as unique_assets
      FROM pool_snapshots
    `);

    return {
      total_rows: parseInt(result.rows[0].total_rows, 10),
      latest_date: result.rows[0].latest_date || 'N/A',
      unique_assets: parseInt(result.rows[0].unique_assets, 10),
    };
  }

  /**
   * Get the most recent rates for a pool/asset at or before a specific ledger
   * Used by Goldsky webhook handler to attach rates to position changes
   */
  async getLatestRatesAtLedger(
    poolId: string,
    assetAddress: string,
    ledgerSequence: number
  ): Promise<{ b_rate: number; d_rate: number } | null> {
    const result = await pool.query(
      `
      SELECT b_rate, d_rate
      FROM pool_snapshots
      WHERE pool_id = $1
        AND asset_address = $2
        AND ledger_sequence <= $3
      ORDER BY ledger_sequence DESC
      LIMIT 1
      `,
      [poolId, assetAddress, ledgerSequence]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return {
      b_rate: parseFloat(result.rows[0].b_rate),
      d_rate: parseFloat(result.rows[0].d_rate),
    };
  }
}

export const poolRepository = new PoolRepository();
