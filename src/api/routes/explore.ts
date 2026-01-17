import { Router, Request, Response } from 'express';
import { exploreRepository, ActionType } from '../../repositories/explore-repository';

const router = Router();

// Valid action types for filtering
const VALID_ACTION_TYPES: ActionType[] = [
  'supply',
  'withdraw',
  'supply_collateral',
  'withdraw_collateral',
  'borrow',
  'repay',
  'claim',
  'liquidate',
];

type TimeRangePreset = '7d' | '30d' | '90d' | '1y' | 'all';
type ExploreQueryType = 'deposits' | 'events' | 'balance' | 'top-depositors' | 'aggregates' | 'pools';

// Convert time range preset to start/end dates
function getDateRangeFromPreset(preset: TimeRangePreset): { startDate: string; endDate: string } {
  const now = new Date();
  const endDate = now.toISOString();
  let startDate: Date;

  switch (preset) {
    case '7d':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case '90d':
      startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      break;
    case '1y':
      startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      break;
    case 'all':
    default:
      startDate = new Date('2020-01-01');
      break;
  }

  return { startDate: startDate.toISOString(), endDate };
}

// GET /api/explore
router.get('/', async (req: Request, res: Response) => {
  try {
    // Parse query parameters
    const query = (req.query.query as string || 'aggregates') as ExploreQueryType;
    const assetAddress = req.query.asset as string | undefined;
    const poolId = req.query.pool as string | undefined;
    const minAmount = req.query.minAmount
      ? parseFloat(req.query.minAmount as string)
      : undefined;
    const minCount = req.query.minCount
      ? parseInt(req.query.minCount as string, 10)
      : undefined;
    const inUsd = req.query.inUsd === 'true';
    const eventTypesParam = req.query.eventTypes as string | undefined;
    const eventTypes = eventTypesParam
      ? (eventTypesParam.split(',').filter((t) => VALID_ACTION_TYPES.includes(t as ActionType)) as ActionType[])
      : undefined;
    const timeRange = req.query.timeRange as TimeRangePreset | undefined;
    const startDateParam = req.query.startDate as string | undefined;
    const endDateParam = req.query.endDate as string | undefined;
    const orderBy = (req.query.orderBy as string || 'amount') as 'amount' | 'count' | 'date';
    const orderDir = (req.query.orderDir as string || 'desc') as 'asc' | 'desc';
    const limit = Math.min(Math.max(parseInt(req.query.limit as string || '50', 10), 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string || '0', 10), 0);

    // Position filters
    const hasBorrowsParam = req.query.hasBorrows as string | undefined;
    const hasBorrows = hasBorrowsParam === 'true' ? true : hasBorrowsParam === 'false' ? false : undefined;
    const hasDepositsParam = req.query.hasDeposits as string | undefined;
    const hasDeposits = hasDepositsParam === 'true' ? true : hasDepositsParam === 'false' ? false : undefined;
    const hasBackstopParam = req.query.hasBackstop as string | undefined;
    const hasBackstop = hasBackstopParam === 'true' ? true : hasBackstopParam === 'false' ? false : undefined;

    // Token filters (array of {assetAddress, symbol, minAmount})
    const tokenFiltersParam = req.query.tokenFilters as string | undefined;
    let tokenFilters: Array<{ assetAddress: string; symbol: string; minAmount?: number }> | undefined;
    if (tokenFiltersParam) {
      try {
        tokenFilters = JSON.parse(tokenFiltersParam);
      } catch {
        // Invalid JSON, ignore
      }
    }

    // Determine date range
    let dateRange: { startDate?: string; endDate?: string } = {};
    if (timeRange) {
      dateRange = getDateRangeFromPreset(timeRange);
    } else if (startDateParam || endDateParam) {
      dateRange = { startDate: startDateParam, endDate: endDateParam };
    }

    // Build filters object
    const filters = {
      query,
      assetAddress,
      poolId,
      minAmount,
      minCount,
      inUsd,
      eventTypes,
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      orderBy,
      orderDir,
      limit,
      offset,
      hasBorrows,
      hasDeposits,
      hasBackstop,
      tokenFilters,
    };

    // Get aggregate metrics (always included)
    const aggregates = await exploreRepository.getAggregateMetrics({
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      poolId,
      assetAddress,
    });

    let response: Record<string, unknown>;

    switch (query) {
      case 'deposits': {
        if (!assetAddress) {
          return res.status(400).json({
            error: 'Missing required parameter',
            message: 'asset parameter is required for deposits query',
          });
        }
        if (minAmount === undefined) {
          return res.status(400).json({
            error: 'Missing required parameter',
            message: 'minAmount parameter is required for deposits query',
          });
        }

        const { results, totalCount } = await exploreRepository.getAccountsByMinDeposit({
          assetAddress,
          minAmount,
          inUsd,
          limit,
          offset,
          orderDir,
        });

        response = {
          query: 'deposits',
          filters,
          count: results.length,
          totalCount,
          results,
          aggregates,
        };
        break;
      }

      case 'events': {
        if (minCount === undefined) {
          return res.status(400).json({
            error: 'Missing required parameter',
            message: 'minCount parameter is required for events query',
          });
        }

        const { results, totalCount } = await exploreRepository.getAccountsByEventCount({
          assetAddress,
          eventTypes: eventTypes || ['supply', 'supply_collateral'],
          minCount,
          limit,
          offset,
          orderDir,
        });

        response = {
          query: 'events',
          filters,
          count: results.length,
          totalCount,
          results,
          aggregates,
        };
        break;
      }

      case 'balance': {
        // Require at least one token filter for balance query
        if (!tokenFilters || tokenFilters.length === 0) {
          return res.status(400).json({
            error: 'Missing required parameter',
            message: 'At least one token filter is required for balance query',
          });
        }

        const { results, totalCount } = await exploreRepository.getAccountsByBalance({
          tokenFilters,
          inUsd,
          limit,
          offset,
          orderDir,
          hasBorrows,
          hasDeposits,
          hasBackstop,
        });

        response = {
          query: 'balance',
          filters,
          count: results.length,
          totalCount,
          results,
          aggregates,
        };
        break;
      }

      case 'top-depositors': {
        if (!poolId) {
          return res.status(400).json({
            error: 'Missing required parameter',
            message: 'pool parameter is required for top-depositors query',
          });
        }

        const results = await exploreRepository.getTopDepositorsByPool({
          poolId,
          assetAddress,
          limit,
        });

        response = {
          query: 'top-depositors',
          filters,
          count: results.length,
          results,
          aggregates,
        };
        break;
      }

      case 'pools': {
        const { results, totalCount } = await exploreRepository.getPoolStatistics({
          limit,
          offset,
          orderDir,
        });

        response = {
          query: 'pools',
          filters,
          count: results.length,
          totalCount,
          results,
          aggregates,
        };
        break;
      }

      case 'aggregates':
      default: {
        const volumeByToken = await exploreRepository.getVolumeByToken({
          startDate: dateRange.startDate,
          endDate: dateRange.endDate,
          limit: 20,
        });

        response = {
          query: 'aggregates',
          filters,
          aggregates,
          volumeByToken,
        };
        break;
      }
    }

    res.set('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    res.json(response);
  } catch (error) {
    console.error('[Explore API] Error:', error);

    res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
