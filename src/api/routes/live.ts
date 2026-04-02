import { Router, Request, Response } from 'express';
import { pool } from '../../config/database';

const router = Router();

/**
 * GET /api/live/transactions
 * Returns the most recent blend actions and backstop events for a given pool.
 *
 * Query params:
 *   poolId (required) - pool contract ID
 *   includeActions (boolean, default "true")
 *   includeBackstop (boolean, default "true")
 *   limit (number, default 50, max 200)
 */
router.get('/transactions', async (req: Request, res: Response) => {
  try {
    const { poolId, includeActions, includeBackstop, limit: limitParam } = req.query;

    if (!poolId || typeof poolId !== 'string') {
      return res.status(400).json({ error: 'poolId query parameter is required' });
    }

    const shouldIncludeActions = includeActions !== 'false';
    const shouldIncludeBackstop = includeBackstop !== 'false';
    const limit = Math.min(Math.max(parseInt(limitParam as string, 10) || 50, 1), 200);

    const [actions, backstop] = await Promise.all([
      shouldIncludeActions
        ? pool.query(
            `SELECT id, pool_id, transaction_hash, ledger_sequence, ledger_closed_at,
                    action_type, asset_address, user_address,
                    amount_underlying, amount_tokens, implied_rate,
                    auction_type, filler_address, liquidation_percent,
                    bid_asset, bid_amount, lot_asset, lot_amount, src
             FROM parsed_events
             WHERE pool_id = $1
             ORDER BY ledger_closed_at DESC
             LIMIT $2`,
            [poolId, limit]
          )
        : { rows: [] },
      shouldIncludeBackstop
        ? pool.query(
            `SELECT id, transaction_hash, ledger_sequence, ledger_closed_at,
                    action_type, pool_address, user_address,
                    lp_tokens, shares, q4w_exp,
                    emissions_amount, emissions_shares, src
             FROM backstop_events
             WHERE pool_address = $1
             ORDER BY ledger_closed_at DESC
             LIMIT $2`,
            [poolId, limit]
          )
        : { rows: [] },
    ]);

    res.json({
      actions: actions.rows,
      backstop: backstop.rows,
    });
  } catch (error) {
    console.error('Error fetching live transactions:', error);
    res.status(500).json({ error: 'Failed to fetch live transactions' });
  }
});

export default router;
