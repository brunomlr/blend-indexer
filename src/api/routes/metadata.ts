import { Router, Request, Response } from 'express';
import { exploreRepository } from '../../repositories/explore-repository';

const router = Router();

// GET /api/metadata
router.get('/', async (req: Request, res: Response) => {
  try {
    const type = req.query.type as string | undefined; // 'pools', 'tokens', or 'all' (default)

    let pools = null;
    let tokens = null;

    if (type === 'pools' || type === 'all' || !type) {
      pools = await exploreRepository.getPools();
    }

    if (type === 'tokens' || type === 'all' || !type) {
      tokens = await exploreRepository.getTokens();
    }

    const response: Record<string, unknown> = {};

    if (pools !== null) {
      response.pools = pools;
    }

    if (tokens !== null) {
      response.tokens = tokens;
    }

    // Cache metadata for 1 hour - it rarely changes
    res.set('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');
    res.json(response);
  } catch (error) {
    console.error('[Metadata API] Error:', error);

    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
