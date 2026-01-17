import { Router, Request, Response } from 'express';
import { userRepository } from '../../repositories/user-repository';
import { poolRepository } from '../../repositories/pool-repository';

const router = Router();

/**
 * GET /api/balance/:user/:asset
 * Get current balance for a user and asset
 */
router.get('/balance/:user/:asset', async (req: Request, res: Response) => {
  try {
    const { user, asset } = req.params;
    const { date } = req.query;

    const balance = await userRepository.getUserBalance(
      user,
      asset,
      date as string | undefined
    );

    if (!balance) {
      return res.status(404).json({
        error: 'Balance not found',
        message: 'No position data found for this user and asset',
      });
    }

    res.json(balance);
  } catch (error) {
    console.error('Error fetching balance:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/balance/:user/:asset/history
 * Get balance history for a user and asset
 */
router.get('/balance/:user/:asset/history', async (req: Request, res: Response) => {
  try {
    const { user, asset } = req.params;
    const days = parseInt(req.query.days as string) || 30;

    const history = await userRepository.getUserBalanceHistory(user, asset, days);

    res.json({
      user_address: user,
      asset_address: asset,
      days,
      count: history.length,
      history,
    });
  } catch (error) {
    console.error('Error fetching balance history:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/stats
 * Get database statistics
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    const [poolStats, userStats] = await Promise.all([
      poolRepository.getStats(),
      userRepository.getStats(),
    ]);

    res.json({
      pool_snapshots: poolStats,
      user_positions: userStats,
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
