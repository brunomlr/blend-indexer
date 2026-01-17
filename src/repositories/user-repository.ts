import { pool } from '../config/database';
import { UserPositionRow, UserBalance } from '../types';

export class UserRepository {
  /**
   * Insert user positions in a batch with transaction
   * Uses ON CONFLICT DO UPDATE for idempotency
   * Automatically chunks large batches to avoid PostgreSQL parameter limit (65535)
   */
  async insertBatch(rows: UserPositionRow[]): Promise<{ inserted: number; updated: number }> {
    if (rows.length === 0) {
      return { inserted: 0, updated: 0 };
    }

    // PostgreSQL has a 65535 parameter limit
    // With 13 parameters per row, we can safely do ~5000 rows per batch
    const CHUNK_SIZE = 5000;

    // If we have more rows than the chunk size, process in chunks
    if (rows.length > CHUNK_SIZE) {
      console.log(`⚠️  Large batch detected (${rows.length} rows). Processing in chunks of ${CHUNK_SIZE}...`);

      let totalInserted = 0;
      let totalUpdated = 0;

      for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
        const chunk = rows.slice(i, i + CHUNK_SIZE);
        console.log(`   Processing chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(rows.length / CHUNK_SIZE)} (${chunk.length} rows)...`);

        const result = await this.insertBatchChunk(chunk);
        totalInserted += result.inserted;
        totalUpdated += result.updated;
      }

      return { inserted: totalInserted, updated: totalUpdated };
    }

    // For small batches, process directly
    return this.insertBatchChunk(rows);
  }

  /**
   * Insert a single chunk of user positions (internal method)
   * Should not be called directly - use insertBatch instead
   */
  private async insertBatchChunk(rows: UserPositionRow[]): Promise<{ inserted: number; updated: number }> {
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
          row.pool_id,
          row.user_address,
          row.asset_address,
          row.snapshot_date,
          row.snapshot_timestamp,
          row.ledger_sequence,
          row.supply_btokens,
          row.collateral_btokens,
          row.liabilities_dtokens,
          row.b_rate || null,
          row.d_rate || null,
          row.entry_hash || null,
          row.ledger_entry_change || null
        );
      });

      const query = `
        INSERT INTO user_positions (
          pool_id, user_address, asset_address, snapshot_date,
          snapshot_timestamp, ledger_sequence,
          supply_btokens, collateral_btokens, liabilities_dtokens,
          b_rate, d_rate,
          entry_hash, ledger_entry_change
        )
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (pool_id, user_address, asset_address, ledger_sequence)
        DO UPDATE SET
          snapshot_date = EXCLUDED.snapshot_date,
          snapshot_timestamp = EXCLUDED.snapshot_timestamp,
          supply_btokens = EXCLUDED.supply_btokens,
          collateral_btokens = EXCLUDED.collateral_btokens,
          liabilities_dtokens = EXCLUDED.liabilities_dtokens,
          b_rate = EXCLUDED.b_rate,
          d_rate = EXCLUDED.d_rate,
          entry_hash = EXCLUDED.entry_hash,
          ledger_entry_change = EXCLUDED.ledger_entry_change
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
      console.error('Error inserting user positions:', error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get user balance by joining positions with pool rates
   */
  async getUserBalance(
    userAddress: string,
    assetAddress: string,
    date?: string
  ): Promise<UserBalance | null> {
    const dateCondition = date
      ? 'AND p.snapshot_date = $3'
      : 'AND p.snapshot_date = (SELECT MAX(snapshot_date) FROM user_positions)';

    const params = date
      ? [userAddress, assetAddress, date]
      : [userAddress, assetAddress];

    const result = await pool.query(
      `
      SELECT
        p.pool_id,
        p.user_address,
        p.asset_address,
        p.snapshot_date::text,
        p.snapshot_timestamp::text,
        p.ledger_sequence,
        p.supply_btokens,
        p.collateral_btokens,
        p.liabilities_dtokens,
        p.entry_hash,
        p.ledger_entry_change,
        r.b_rate,
        r.d_rate,
        -- Calculate balances
        (p.supply_btokens * r.b_rate) AS supply_balance,
        (p.collateral_btokens * r.b_rate) AS collateral_balance,
        (p.liabilities_dtokens * r.d_rate) AS debt_balance,
        ((p.supply_btokens + p.collateral_btokens) * r.b_rate - p.liabilities_dtokens * r.d_rate) AS net_balance
      FROM user_positions p
      JOIN pool_snapshots r
        ON p.asset_address = r.asset_address
        AND p.snapshot_date = r.snapshot_date
      WHERE p.user_address = $1
        AND p.asset_address = $2
        ${dateCondition}
      LIMIT 1
      `,
      params
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      pool_id: row.pool_id,
      user_address: row.user_address,
      asset_address: row.asset_address,
      snapshot_date: row.snapshot_date,
      snapshot_timestamp: row.snapshot_timestamp,
      ledger_sequence: row.ledger_sequence,
      supply_balance: parseFloat(row.supply_balance),
      collateral_balance: parseFloat(row.collateral_balance),
      debt_balance: parseFloat(row.debt_balance),
      net_balance: parseFloat(row.net_balance),
      supply_btokens: parseFloat(row.supply_btokens),
      collateral_btokens: parseFloat(row.collateral_btokens),
      liabilities_dtokens: parseFloat(row.liabilities_dtokens),
      entry_hash: row.entry_hash,
      ledger_entry_change: row.ledger_entry_change,
      b_rate: parseFloat(row.b_rate),
      d_rate: parseFloat(row.d_rate),
    };
  }

  /**
   * Get user balance history over a date range
   * Shows actual position changes (ledger-based tracking)
   * Returns data for ALL pools for the given asset
   */
  async getUserBalanceHistory(
    userAddress: string,
    assetAddress: string,
    days: number = 30
  ): Promise<UserBalance[]> {
    const result = await pool.query(
      `
      WITH date_series AS (
        -- Generate all dates in the range
        SELECT generate_series(
          CURRENT_DATE - $3::integer,
          CURRENT_DATE,
          '1 day'::interval
        )::date AS date
      ),
      user_pools AS (
        -- Get all unique pools this user has positions in for this asset
        SELECT DISTINCT pool_id
        FROM user_positions
        WHERE user_address = $1
          AND asset_address = $2
      ),
      date_pool_combinations AS (
        -- Cross join to get every date x pool combination
        SELECT d.date, p.pool_id
        FROM date_series d
        CROSS JOIN user_pools p
      )
      SELECT
        dpc.pool_id,
        $1 AS user_address,
        $2 AS asset_address,
        dpc.date::text AS snapshot_date,
        latest_pos.snapshot_timestamp::text AS snapshot_timestamp,
        COALESCE(latest_pos.ledger_sequence, 0) AS ledger_sequence,
        COALESCE(latest_pos.supply_btokens, 0) AS supply_btokens,
        COALESCE(latest_pos.collateral_btokens, 0) AS collateral_btokens,
        COALESCE(latest_pos.liabilities_dtokens, 0) AS liabilities_dtokens,
        latest_pos.entry_hash,
        latest_pos.ledger_entry_change,
        -- Return raw rate data - application layer will choose which to use
        latest_pos.b_rate AS position_b_rate,
        latest_pos.d_rate AS position_d_rate,
        rates.b_rate AS snapshot_b_rate,
        rates.d_rate AS snapshot_d_rate,
        latest_pos.snapshot_date::text AS position_date
      FROM date_pool_combinations dpc
      -- Get the first position date for this pool (to avoid showing data before position exists)
      LEFT JOIN LATERAL (
        SELECT MIN(snapshot_date) as first_date
        FROM user_positions
        WHERE user_address = $1
          AND asset_address = $2
          AND pool_id = dpc.pool_id
      ) first_date ON true
      -- Get the most recent position for THIS POOL on or before this date
      LEFT JOIN LATERAL (
        SELECT *
        FROM user_positions
        WHERE user_address = $1
          AND asset_address = $2
          AND pool_id = dpc.pool_id
          AND snapshot_date <= dpc.date
        ORDER BY snapshot_date DESC, ledger_sequence DESC
        LIMIT 1
      ) latest_pos ON true
      -- Get the pool rates for THIS specific date and pool
      LEFT JOIN LATERAL (
        SELECT b_rate, d_rate
        FROM pool_snapshots
        WHERE asset_address = $2
          AND pool_id = dpc.pool_id
          AND snapshot_date <= dpc.date
        ORDER BY snapshot_date DESC, ledger_sequence DESC
        LIMIT 1
      ) rates ON true
      -- Only include dates on or after the first position date
      WHERE latest_pos.pool_id IS NOT NULL
        AND dpc.date >= first_date.first_date
      ORDER BY dpc.date DESC, dpc.pool_id
      `,
      [userAddress, assetAddress, days]
    );

    return result.rows.map(row => {
      // Parse raw values
      const supply_btokens = parseFloat(row.supply_btokens);
      const collateral_btokens = parseFloat(row.collateral_btokens);
      const liabilities_dtokens = parseFloat(row.liabilities_dtokens);

      const position_b_rate = row.position_b_rate ? parseFloat(row.position_b_rate) : null;
      const position_d_rate = row.position_d_rate ? parseFloat(row.position_d_rate) : null;
      const snapshot_b_rate = row.snapshot_b_rate ? parseFloat(row.snapshot_b_rate) : null;
      const snapshot_d_rate = row.snapshot_d_rate ? parseFloat(row.snapshot_d_rate) : null;

      // Rate selection logic: use position rate only if this is the exact position date
      const isExactPositionDate = row.position_date === row.snapshot_date;

      const b_rate = isExactPositionDate
        ? (position_b_rate ?? snapshot_b_rate ?? 1.0)
        : (snapshot_b_rate ?? 1.0);

      const d_rate = isExactPositionDate
        ? (position_d_rate ?? snapshot_d_rate ?? 1.0)
        : (snapshot_d_rate ?? 1.0);

      // Calculate balances with selected rates
      const supply_balance = supply_btokens * b_rate;
      const collateral_balance = collateral_btokens * b_rate;
      const debt_balance = liabilities_dtokens * d_rate;
      const net_balance = (supply_btokens + collateral_btokens) * b_rate - liabilities_dtokens * d_rate;

      return {
        pool_id: row.pool_id,
        user_address: row.user_address,
        asset_address: row.asset_address,
        snapshot_date: row.snapshot_date,
        snapshot_timestamp: row.snapshot_timestamp,
        ledger_sequence: row.ledger_sequence,
        supply_balance,
        collateral_balance,
        debt_balance,
        net_balance,
        supply_btokens,
        collateral_btokens,
        liabilities_dtokens,
        entry_hash: row.entry_hash,
        ledger_entry_change: row.ledger_entry_change,
        b_rate,
        d_rate,
        // Debug fields for rate comparison
        position_b_rate,
        position_d_rate,
        snapshot_b_rate,
        snapshot_d_rate,
        position_date: row.position_date,
      };
    });
  }

  /**
   * Get statistics about user positions
   */
  async getStats(): Promise<{
    total_rows: number;
    latest_date: string;
    unique_users: number;
  }> {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_rows,
        MAX(snapshot_date)::text as latest_date,
        COUNT(DISTINCT user_address) as unique_users
      FROM user_positions
    `);

    return {
      total_rows: parseInt(result.rows[0].total_rows, 10),
      latest_date: result.rows[0].latest_date || 'N/A',
      unique_users: parseInt(result.rows[0].unique_users, 10),
    };
  }
}

export const userRepository = new UserRepository();
