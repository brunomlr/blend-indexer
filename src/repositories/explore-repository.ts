import { pool } from '../config/database';

// Types
export type ActionType =
  | 'supply'
  | 'withdraw'
  | 'supply_collateral'
  | 'withdraw_collateral'
  | 'borrow'
  | 'repay'
  | 'claim'
  | 'liquidate'
  | 'new_auction'
  | 'fill_auction'
  | 'delete_auction';

export interface AccountDepositResult {
  userAddress: string;
  totalDeposited: number;
  totalDepositedUsd: number;
  depositCount: number;
  lastDepositDate: string;
  assetSymbol?: string;
}

export interface AccountEventCountResult {
  userAddress: string;
  eventCount: number;
  eventsByType: Record<string, number>;
  firstEventDate: string;
  lastEventDate: string;
}

export interface AccountBalanceResult {
  userAddress: string;
  balance: number;
  balanceUsd: number;
  supplyBalance: number;
  collateralBalance: number;
  debtBalance: number;
  netBalance: number;
  assetSymbol?: string;
}

export interface TopDepositorResult {
  userAddress: string;
  poolId: string;
  poolName: string;
  totalDeposited: number;
  totalDepositedUsd: number;
  rank: number;
  assetSymbol?: string;
}

export interface AggregateMetrics {
  totalDeposits: number;
  totalDepositsUsd: number;
  totalWithdrawals: number;
  totalWithdrawalsUsd: number;
  netFlow: number;
  netFlowUsd: number;
  activeAccounts: number;
  totalEvents: number;
}

export interface TokenVolumeResult {
  assetAddress: string;
  symbol: string;
  name: string | null;
  depositVolume: number;
  depositVolumeUsd: number;
  withdrawVolume: number;
  withdrawVolumeUsd: number;
  netVolume: number;
  netVolumeUsd: number;
}

export interface PoolStatisticsResult {
  poolId: string;
  poolName: string;
  poolShortName: string | null;
  eventCount: number;
  uniqueEventTypes: string[];
  uniqueEventTypeCount: number;
  firstEventDate: string | null;
  lastEventDate: string | null;
}

export interface Pool {
  pool_id: string;
  name: string;
  short_name: string | null;
  description: string | null;
  icon_url: string | null;
  website_url: string | null;
  is_active: boolean;
  version: number;
}

export interface Token {
  asset_address: string;
  symbol: string;
  name: string | null;
  decimals: number;
  icon_url: string | null;
  coingecko_id: string | null;
  is_native: boolean;
}

// Mock prices for USD conversion
const MOCK_PRICES: Record<string, number> = {
  USDC: 1,
  XLM: 0.12,
  AQUA: 0.004,
  BLND: 0.25,
};

export class ExploreRepository {
  /**
   * Get accounts by minimum deposit amount
   */
  async getAccountsByMinDeposit(params: {
    assetAddress: string;
    minAmount: number;
    inUsd: boolean;
    limit: number;
    offset: number;
    orderDir?: 'asc' | 'desc';
  }): Promise<{ results: AccountDepositResult[]; totalCount: number }> {
    const { assetAddress, minAmount, inUsd, limit, offset, orderDir = 'desc' } = params;

    const tokenResult = await pool.query(
      'SELECT symbol FROM tokens WHERE asset_address = $1',
      [assetAddress]
    );
    const symbol = tokenResult.rows[0]?.symbol || '';
    const price = MOCK_PRICES[symbol.toUpperCase()] || 0;

    const minAmountNative = inUsd && price > 0 ? minAmount / price : minAmount;
    const orderDirection = orderDir === 'asc' ? 'ASC' : 'DESC';

    const countResult = await pool.query(
      `
      SELECT COUNT(*) as total FROM (
        SELECT user_address
        FROM user_action_history
        WHERE asset_address = $1
          AND action_type IN ('supply', 'supply_collateral')
        GROUP BY user_address
        HAVING SUM(amount_underlying) / 1e7 >= $2
      ) sub
      `,
      [assetAddress, minAmountNative]
    );
    const totalCount = parseInt(countResult.rows[0]?.total || '0', 10);

    const result = await pool.query(
      `
      SELECT
        user_address,
        SUM(amount_underlying) / 1e7 as total_deposited,
        COUNT(*) as deposit_count,
        to_char(MAX(ledger_closed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_deposit_date
      FROM user_action_history
      WHERE asset_address = $1
        AND action_type IN ('supply', 'supply_collateral')
      GROUP BY user_address
      HAVING SUM(amount_underlying) / 1e7 >= $2
      ORDER BY total_deposited ${orderDirection}
      LIMIT $3 OFFSET $4
      `,
      [assetAddress, minAmountNative, limit, offset]
    );

    const results: AccountDepositResult[] = result.rows.map((row) => {
      const totalDeposited = parseFloat(row.total_deposited) || 0;
      return {
        userAddress: row.user_address,
        totalDeposited,
        totalDepositedUsd: totalDeposited * price,
        depositCount: parseInt(row.deposit_count, 10),
        lastDepositDate: row.last_deposit_date,
        assetSymbol: symbol,
      };
    });

    return { results, totalCount };
  }

  /**
   * Get accounts by event count
   */
  async getAccountsByEventCount(params: {
    assetAddress?: string;
    eventTypes: ActionType[];
    minCount: number;
    limit: number;
    offset: number;
    orderDir?: 'asc' | 'desc';
  }): Promise<{ results: AccountEventCountResult[]; totalCount: number }> {
    const { assetAddress, eventTypes, minCount, limit, offset, orderDir = 'desc' } = params;
    const orderDirection = orderDir === 'asc' ? 'ASC' : 'DESC';

    let whereClause = 'WHERE action_type = ANY($1)';
    const countParams: (string | string[] | number)[] = [eventTypes];
    const queryParams: (string | string[] | number)[] = [eventTypes];
    let paramIndex = 2;

    if (assetAddress) {
      whereClause += ` AND asset_address = $${paramIndex}`;
      countParams.push(assetAddress);
      queryParams.push(assetAddress);
      paramIndex++;
    }

    const countResult = await pool.query(
      `
      SELECT COUNT(*) as total FROM (
        SELECT user_address
        FROM user_action_history
        ${whereClause}
        GROUP BY user_address
        HAVING COUNT(*) >= $${paramIndex}
      ) sub
      `,
      [...countParams, minCount]
    );
    const totalCount = parseInt(countResult.rows[0]?.total || '0', 10);

    queryParams.push(minCount, limit, offset);
    const result = await pool.query(
      `
      SELECT
        user_address,
        COUNT(*) as event_count,
        jsonb_object_agg(action_type, type_count) as events_by_type,
        to_char(MIN(ledger_closed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as first_event_date,
        to_char(MAX(ledger_closed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_event_date
      FROM (
        SELECT
          user_address,
          action_type,
          ledger_closed_at,
          COUNT(*) OVER (PARTITION BY user_address, action_type) as type_count
        FROM user_action_history
        ${whereClause}
      ) sub
      GROUP BY user_address
      HAVING COUNT(*) >= $${paramIndex}
      ORDER BY event_count ${orderDirection}
      LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2}
      `,
      queryParams
    );

    const results: AccountEventCountResult[] = result.rows.map((row) => ({
      userAddress: row.user_address,
      eventCount: parseInt(row.event_count, 10),
      eventsByType: row.events_by_type || {},
      firstEventDate: row.first_event_date,
      lastEventDate: row.last_event_date,
    }));

    return { results, totalCount };
  }

  /**
   * Get accounts by current balance (supports multi-token filters with AND logic)
   */
  async getAccountsByBalance(params: {
    tokenFilters: Array<{ assetAddress: string; symbol: string; minAmount?: number }>;
    inUsd: boolean;
    limit: number;
    offset: number;
    orderDir?: 'asc' | 'desc';
    hasBorrows?: boolean;
    hasDeposits?: boolean;
    hasBackstop?: boolean;
  }): Promise<{ results: AccountBalanceResult[]; totalCount: number }> {
    const { tokenFilters, inUsd, limit, offset, orderDir = 'desc', hasBorrows, hasDeposits, hasBackstop } = params;

    if (tokenFilters.length === 0) {
      return { results: [], totalCount: 0 };
    }

    const orderDirection = orderDir === 'asc' ? 'ASC' : 'DESC';

    // Build position filters
    const positionFilters: string[] = [];
    if (hasBorrows === true) {
      positionFilters.push('debt_balance > 0');
    } else if (hasBorrows === false) {
      positionFilters.push('debt_balance <= 0');
    }
    if (hasDeposits === true) {
      positionFilters.push('(supply_balance + collateral_balance) > 0');
    } else if (hasDeposits === false) {
      positionFilters.push('(supply_balance + collateral_balance) <= 0');
    }
    const positionFilterClause = positionFilters.length > 0
      ? ' AND ' + positionFilters.join(' AND ')
      : '';

    // Build backstop filter
    const backstopJoin = hasBackstop !== undefined
      ? `${hasBackstop ? 'INNER' : 'LEFT'} JOIN (SELECT DISTINCT user_address FROM backstop_events WHERE user_address IS NOT NULL) bs ON ub.user_address = bs.user_address`
      : '';
    const backstopWhere = hasBackstop === false
      ? ' AND bs.user_address IS NULL'
      : '';

    // Build query for each token and use INTERSECT for AND logic
    const tokenQueries: string[] = [];
    const allParams: (string | number)[] = [];
    let paramIndex = 1;

    for (const filter of tokenFilters) {
      const price = MOCK_PRICES[filter.symbol.toUpperCase()] || 0;
      const minBalance = filter.minAmount || 0;
      const minBalanceNative = inUsd && price > 0 ? minBalance / price : minBalance;

      tokenQueries.push(`
        SELECT user_address
        FROM (
          SELECT
            p.user_address,
            SUM(COALESCE(p.supply_btokens, 0) / 1e7 * COALESCE(r.b_rate, 1)) +
            SUM(COALESCE(p.collateral_btokens, 0) / 1e7 * COALESCE(r.b_rate, 1)) -
            SUM(COALESCE(p.debt_dtokens, 0) / 1e7 * COALESCE(r.d_rate, 1)) as net_balance,
            SUM(COALESCE(p.supply_btokens, 0) / 1e7 * COALESCE(r.b_rate, 1)) as supply_balance,
            SUM(COALESCE(p.collateral_btokens, 0) / 1e7 * COALESCE(r.b_rate, 1)) as collateral_balance,
            SUM(COALESCE(p.debt_dtokens, 0) / 1e7 * COALESCE(r.d_rate, 1)) as debt_balance
          FROM (
            SELECT
              user_address,
              pool_id,
              SUM(CASE WHEN action_type = 'supply' THEN amount_tokens ELSE 0 END) -
              SUM(CASE WHEN action_type = 'withdraw' THEN amount_tokens ELSE 0 END) as supply_btokens,
              SUM(CASE WHEN action_type = 'supply_collateral' THEN amount_tokens ELSE 0 END) -
              SUM(CASE WHEN action_type = 'withdraw_collateral' THEN amount_tokens ELSE 0 END) as collateral_btokens,
              SUM(CASE WHEN action_type = 'borrow' THEN amount_tokens ELSE 0 END) -
              SUM(CASE WHEN action_type = 'repay' THEN amount_tokens ELSE 0 END) as debt_dtokens
            FROM user_action_history
            WHERE asset_address = $${paramIndex}
            GROUP BY user_address, pool_id
          ) p
          LEFT JOIN (
            SELECT DISTINCT ON (pool_id) pool_id, b_rate, d_rate
            FROM daily_rates
            WHERE asset_address = $${paramIndex}
            ORDER BY pool_id, rate_date DESC
          ) r ON p.pool_id = r.pool_id
          GROUP BY p.user_address
        ) sub
        WHERE net_balance >= $${paramIndex + 1}${positionFilterClause}
      `);
      allParams.push(filter.assetAddress, minBalanceNative);
      paramIndex += 2;
    }

    // Combine with INTERSECT for AND logic
    const intersectedQuery = tokenQueries.join(' INTERSECT ');

    // Use the first token for display (or aggregate later)
    const primaryFilter = tokenFilters[0];
    const primaryPrice = MOCK_PRICES[primaryFilter.symbol.toUpperCase()] || 0;

    // Build final query that gets user details
    const finalQuery = `
      WITH matching_users AS (
        ${intersectedQuery}
      ),
      user_balances AS (
        SELECT
          p.user_address,
          SUM(COALESCE(p.supply_btokens, 0) / 1e7 * COALESCE(r.b_rate, 1)) as supply_balance,
          SUM(COALESCE(p.collateral_btokens, 0) / 1e7 * COALESCE(r.b_rate, 1)) as collateral_balance,
          SUM(COALESCE(p.debt_dtokens, 0) / 1e7 * COALESCE(r.d_rate, 1)) as debt_balance
        FROM (
          SELECT
            user_address,
            pool_id,
            SUM(CASE WHEN action_type = 'supply' THEN amount_tokens ELSE 0 END) -
            SUM(CASE WHEN action_type = 'withdraw' THEN amount_tokens ELSE 0 END) as supply_btokens,
            SUM(CASE WHEN action_type = 'supply_collateral' THEN amount_tokens ELSE 0 END) -
            SUM(CASE WHEN action_type = 'withdraw_collateral' THEN amount_tokens ELSE 0 END) as collateral_btokens,
            SUM(CASE WHEN action_type = 'borrow' THEN amount_tokens ELSE 0 END) -
            SUM(CASE WHEN action_type = 'repay' THEN amount_tokens ELSE 0 END) as debt_dtokens
          FROM user_action_history
          WHERE asset_address = $${paramIndex}
            AND user_address IN (SELECT user_address FROM matching_users)
          GROUP BY user_address, pool_id
        ) p
        LEFT JOIN (
          SELECT DISTINCT ON (pool_id) pool_id, b_rate, d_rate
          FROM daily_rates
          WHERE asset_address = $${paramIndex}
          ORDER BY pool_id, rate_date DESC
        ) r ON p.pool_id = r.pool_id
        GROUP BY p.user_address
      )
      SELECT
        ub.user_address,
        ub.supply_balance,
        ub.collateral_balance,
        ub.debt_balance,
        (ub.supply_balance + ub.collateral_balance - ub.debt_balance) as net_balance
      FROM user_balances ub
      ${backstopJoin}
      WHERE 1=1${backstopWhere}
      ORDER BY net_balance ${orderDirection}
    `;

    allParams.push(primaryFilter.assetAddress);
    paramIndex++;

    // Get count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total FROM (${finalQuery}) sub`,
      allParams
    );
    const totalCount = parseInt(countResult.rows[0]?.total || '0', 10);

    // Get paginated results
    const paginatedQuery = `${finalQuery} LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    const result = await pool.query(paginatedQuery, [...allParams, limit, offset]);

    const results: AccountBalanceResult[] = result.rows.map((row) => {
      const supplyBalance = parseFloat(row.supply_balance) || 0;
      const collateralBalance = parseFloat(row.collateral_balance) || 0;
      const debtBalance = parseFloat(row.debt_balance) || 0;
      const netBalance = parseFloat(row.net_balance) || 0;

      return {
        userAddress: row.user_address,
        balance: netBalance,
        balanceUsd: netBalance * primaryPrice,
        supplyBalance,
        collateralBalance,
        debtBalance,
        netBalance,
        assetSymbol: primaryFilter.symbol,
      };
    });

    return { results, totalCount };
  }

  /**
   * Get top depositors by pool
   */
  async getTopDepositorsByPool(params: {
    poolId: string;
    assetAddress?: string;
    limit: number;
  }): Promise<TopDepositorResult[]> {
    const { poolId, assetAddress, limit } = params;

    let whereClause = "WHERE pool_id = $1 AND action_type IN ('supply', 'supply_collateral')";
    const queryParams: (string | number)[] = [poolId];
    let paramIndex = 2;

    if (assetAddress) {
      whereClause += ` AND asset_address = $${paramIndex}`;
      queryParams.push(assetAddress);
      paramIndex++;
    }

    queryParams.push(limit);

    const result = await pool.query(
      `
      SELECT
        user_address,
        pool_id,
        pool_name,
        asset_symbol,
        SUM(amount_underlying) / 1e7 as total_deposited,
        ROW_NUMBER() OVER (ORDER BY SUM(amount_underlying) DESC) as rank
      FROM user_action_history
      ${whereClause}
      GROUP BY user_address, pool_id, pool_name, asset_symbol
      ORDER BY total_deposited DESC
      LIMIT $${paramIndex}
      `,
      queryParams
    );

    return result.rows.map((row) => {
      const totalDeposited = parseFloat(row.total_deposited) || 0;
      const symbol = row.asset_symbol || '';
      const price = MOCK_PRICES[symbol.toUpperCase()] || 0;

      return {
        userAddress: row.user_address,
        poolId: row.pool_id,
        poolName: row.pool_name || 'Unknown Pool',
        totalDeposited,
        totalDepositedUsd: totalDeposited * price,
        rank: parseInt(row.rank, 10),
        assetSymbol: symbol,
      };
    });
  }

  /**
   * Get aggregate metrics for a time range
   */
  async getAggregateMetrics(params: {
    startDate?: string;
    endDate?: string;
    poolId?: string;
    assetAddress?: string;
  }): Promise<AggregateMetrics> {
    const { startDate, endDate, poolId, assetAddress } = params;

    let whereClause = 'WHERE 1=1';
    const queryParams: string[] = [];
    let paramIndex = 1;

    if (startDate) {
      whereClause += ` AND ledger_closed_at >= $${paramIndex}::timestamp`;
      queryParams.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      whereClause += ` AND ledger_closed_at < $${paramIndex}::timestamp`;
      queryParams.push(endDate);
      paramIndex++;
    }

    if (poolId) {
      whereClause += ` AND pool_id = $${paramIndex}`;
      queryParams.push(poolId);
      paramIndex++;
    }

    if (assetAddress) {
      whereClause += ` AND asset_address = $${paramIndex}`;
      queryParams.push(assetAddress);
      paramIndex++;
    }

    const result = await pool.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN action_type IN ('supply', 'supply_collateral')
            THEN amount_underlying / 1e7 ELSE 0 END), 0) as total_deposits,
        COALESCE(SUM(CASE WHEN action_type IN ('withdraw', 'withdraw_collateral')
            THEN amount_underlying / 1e7 ELSE 0 END), 0) as total_withdrawals,
        COUNT(DISTINCT user_address) as active_accounts,
        COUNT(*) as total_events,
        asset_symbol
      FROM user_action_history
      ${whereClause}
      GROUP BY asset_symbol
      `,
      queryParams
    );

    let totalDeposits = 0;
    let totalDepositsUsd = 0;
    let totalWithdrawals = 0;
    let totalWithdrawalsUsd = 0;
    let activeAccounts = 0;
    let totalEvents = 0;

    for (const row of result.rows) {
      const deposits = parseFloat(row.total_deposits) || 0;
      const withdrawals = parseFloat(row.total_withdrawals) || 0;
      const symbol = row.asset_symbol || '';
      const price = MOCK_PRICES[symbol.toUpperCase()] || 0;

      totalDeposits += deposits;
      totalDepositsUsd += deposits * price;
      totalWithdrawals += withdrawals;
      totalWithdrawalsUsd += withdrawals * price;
      activeAccounts = Math.max(activeAccounts, parseInt(row.active_accounts, 10) || 0);
      totalEvents += parseInt(row.total_events, 10) || 0;
    }

    if (result.rows.length > 1) {
      const accountCountResult = await pool.query(
        `
        SELECT COUNT(DISTINCT user_address) as active_accounts
        FROM user_action_history
        ${whereClause}
        `,
        queryParams
      );
      activeAccounts = parseInt(accountCountResult.rows[0]?.active_accounts, 10) || 0;
    }

    return {
      totalDeposits,
      totalDepositsUsd,
      totalWithdrawals,
      totalWithdrawalsUsd,
      netFlow: totalDeposits - totalWithdrawals,
      netFlowUsd: totalDepositsUsd - totalWithdrawalsUsd,
      activeAccounts,
      totalEvents,
    };
  }

  /**
   * Get volume breakdown by token
   */
  async getVolumeByToken(params: {
    startDate?: string;
    endDate?: string;
    limit: number;
  }): Promise<TokenVolumeResult[]> {
    const { startDate, endDate, limit } = params;

    let whereClause = 'WHERE 1=1';
    const queryParams: (string | number)[] = [];
    let paramIndex = 1;

    if (startDate) {
      whereClause += ` AND ledger_closed_at >= $${paramIndex}::timestamp`;
      queryParams.push(startDate);
      paramIndex++;
    }

    if (endDate) {
      whereClause += ` AND ledger_closed_at < $${paramIndex}::timestamp`;
      queryParams.push(endDate);
      paramIndex++;
    }

    queryParams.push(limit);

    const result = await pool.query(
      `
      SELECT
        asset_address,
        asset_symbol,
        asset_name,
        COALESCE(SUM(CASE WHEN action_type IN ('supply', 'supply_collateral')
            THEN amount_underlying / 1e7 ELSE 0 END), 0) as deposit_volume,
        COALESCE(SUM(CASE WHEN action_type IN ('withdraw', 'withdraw_collateral')
            THEN amount_underlying / 1e7 ELSE 0 END), 0) as withdraw_volume
      FROM user_action_history
      ${whereClause}
      GROUP BY asset_address, asset_symbol, asset_name
      ORDER BY deposit_volume DESC
      LIMIT $${paramIndex}
      `,
      queryParams
    );

    return result.rows.map((row) => {
      const depositVolume = parseFloat(row.deposit_volume) || 0;
      const withdrawVolume = parseFloat(row.withdraw_volume) || 0;
      const symbol = row.asset_symbol || '';
      const price = MOCK_PRICES[symbol.toUpperCase()] || 0;

      return {
        assetAddress: row.asset_address,
        symbol,
        name: row.asset_name,
        depositVolume,
        depositVolumeUsd: depositVolume * price,
        withdrawVolume,
        withdrawVolumeUsd: withdrawVolume * price,
        netVolume: depositVolume - withdrawVolume,
        netVolumeUsd: (depositVolume - withdrawVolume) * price,
      };
    });
  }

  /**
   * Get pool statistics
   */
  async getPoolStatistics(params: {
    limit: number;
    offset: number;
    orderDir?: 'asc' | 'desc';
  }): Promise<{ results: PoolStatisticsResult[]; totalCount: number }> {
    const { limit, offset, orderDir = 'desc' } = params;
    const orderDirection = orderDir === 'asc' ? 'ASC' : 'DESC';

    const countResult = await pool.query(`
      SELECT COUNT(DISTINCT pool_id) as total
      FROM pools
      WHERE is_active = true
    `);
    const totalCount = parseInt(countResult.rows[0]?.total || '0', 10);

    const result = await pool.query(
      `
      SELECT
        p.pool_id,
        p.name as pool_name,
        p.short_name as pool_short_name,
        COALESCE(stats.event_count, 0) as event_count,
        COALESCE(stats.unique_event_types, ARRAY[]::text[]) as unique_event_types,
        COALESCE(array_length(stats.unique_event_types, 1), 0) as unique_event_type_count,
        stats.first_event_date,
        stats.last_event_date
      FROM pools p
      LEFT JOIN (
        SELECT
          pool_id,
          COUNT(*) as event_count,
          ARRAY_AGG(DISTINCT action_type ORDER BY action_type) as unique_event_types,
          to_char(MIN(ledger_closed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as first_event_date,
          to_char(MAX(ledger_closed_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_event_date
        FROM user_action_history
        GROUP BY pool_id
      ) stats ON p.pool_id = stats.pool_id
      WHERE p.is_active = true
      ORDER BY event_count ${orderDirection}
      LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );

    const results: PoolStatisticsResult[] = result.rows.map((row) => ({
      poolId: row.pool_id,
      poolName: row.pool_name,
      poolShortName: row.pool_short_name,
      eventCount: parseInt(row.event_count, 10) || 0,
      uniqueEventTypes: row.unique_event_types || [],
      uniqueEventTypeCount: parseInt(row.unique_event_type_count, 10) || 0,
      firstEventDate: row.first_event_date,
      lastEventDate: row.last_event_date,
    }));

    return { results, totalCount };
  }

  /**
   * Get all pools
   */
  async getPools(): Promise<Pool[]> {
    const result = await pool.query(
      `
      SELECT pool_id, name, short_name, description, icon_url, website_url, is_active, version
      FROM pools
      WHERE is_active = true
      ORDER BY name
      `
    );

    return result.rows.map((row) => ({
      ...row,
      version: parseInt(row.version, 10),
    }));
  }

  /**
   * Get all tokens
   */
  async getTokens(): Promise<Token[]> {
    const result = await pool.query(
      `
      SELECT asset_address, symbol, name, decimals, icon_url, coingecko_id, is_native
      FROM tokens
      ORDER BY symbol
      `
    );

    return result.rows.map((row) => ({
      ...row,
      decimals: parseInt(row.decimals),
    }));
  }
}

export const exploreRepository = new ExploreRepository();
