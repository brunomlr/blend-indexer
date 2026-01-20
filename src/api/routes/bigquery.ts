import express, { Request, Response } from 'express';
import multer from 'multer';
import { bigQueryBackfillService, BackfillOptions } from '../../services/bigquery-backfill';
import { bigQueryPoolBackfillService, PoolBackfillOptions } from '../../services/bigquery-pool-backfill';
import { bigQueryActionsBackfillService, ActionsBackfillParams } from '../../services/bigquery-actions-backfill';
import { actionsRepository } from '../../repositories/actions-repository';
import { bigQueryBackstopBackfillService, BackstopBackfillParams } from '../../services/bigquery-backstop-backfill';
import { backstopRepository } from '../../repositories/backstop-repository';
import { getPoolAssetPairs, POOL_ASSET_CONFIG, getPoolAssetPairsFromDiscovery } from '../../config/bigquery-config';
import { bigQueryClient } from '../../services/bigquery-client';
import { bigQueryClientOptimized } from '../../services/bigquery-client-optimized';
import { discoverAllPoolAssets, convertToLegacyConfig } from '../../lib/blend/discovery';
import { SyncPoolsTokensService } from '../../services/sync-pools-tokens';
import { pool as dbPool } from '../../config/database';
import { processActionsCsv, processBackstopCsv } from '../../services/csv-processor';
import { LpPriceBackfillService } from '../../services/lp-price-backfill';
import { poolRepository } from '../../repositories/pool-repository';

// Configure multer for file uploads (store in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  },
});

const router = express.Router();

/**
 * Validate Stellar address format
 */
function isValidStellarAddress(address: string): boolean {
  return /^[GCM][A-Z2-7]{55}$/.test(address);
}

/**
 * Validate date format (YYYY-MM-DD)
 */
function isValidDateFormat(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return false;
  }
  const d = new Date(date);
  return !isNaN(d.getTime());
}

/**
 * Validate and parse integer with radix
 */
function parseAndValidateInt(value: any, min: number, max: number, name: string): number {
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}: must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

/**
 * POST /api/bigquery/backfill
 * Run BigQuery backfill with options
 */
router.post('/backfill', async (req: Request, res: Response) => {
  try {
    // Determine query mode (with backward compatibility)
    let queryMode: 'individual' | 'allAssets' | 'allPools' = 'allPools'; // Default to maximum optimization

    if (req.body.queryMode) {
      // New explicit mode
      queryMode = req.body.queryMode;
    } else if (req.body.allAssets === false) {
      // Backward compatibility: allAssets=false means individual mode
      queryMode = 'individual';
    }

    const options: BackfillOptions = {
      skipConfirmation: true, // Skip confirmation prompts for API calls
      queryMode,
    };

    // Validate and parse options from request body
    if (req.body.targetUser) {
      if (typeof req.body.targetUser !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid targetUser: must be a string',
        });
      }
      if (!isValidStellarAddress(req.body.targetUser)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid targetUser: must be a valid Stellar address (56 chars, starting with G/C/M)',
        });
      }
      options.targetUser = req.body.targetUser;
    }

    if (req.body.daysBack !== undefined) {
      try {
        options.daysBack = parseAndValidateInt(req.body.daysBack, 1, 3650, 'daysBack');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid daysBack',
        });
      }
    }

    if (req.body.startDate) {
      if (typeof req.body.startDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.startDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be in YYYY-MM-DD format',
        });
      }
      options.startDate = req.body.startDate;
    }

    if (req.body.endDate) {
      if (typeof req.body.endDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.endDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be in YYYY-MM-DD format',
        });
      }
      options.endDate = req.body.endDate;
    }

    if (req.body.startDate && req.body.endDate && req.body.startDate > req.body.endDate) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date range: startDate must be before or equal to endDate',
      });
    }

    if (req.body.startLedger !== undefined) {
      try {
        options.startLedger = parseAndValidateInt(req.body.startLedger, 0, Number.MAX_SAFE_INTEGER, 'startLedger');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid startLedger',
        });
      }
    }

    if (req.body.endLedger !== undefined) {
      try {
        options.endLedger = parseAndValidateInt(req.body.endLedger, 0, Number.MAX_SAFE_INTEGER, 'endLedger');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid endLedger',
        });
      }
    }

    if (options.startLedger !== undefined && options.endLedger !== undefined && options.startLedger > options.endLedger) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ledger range: startLedger must be less than or equal to endLedger',
      });
    }

    // Validation
    if (options.startLedger && options.endLedger && options.startLedger > options.endLedger) {
      return res.status(400).json({
        success: false,
        error: 'start_ledger must be less than or equal to end_ledger',
      });
    }

    if (options.startDate && options.endDate && options.startDate > options.endDate) {
      return res.status(400).json({
        success: false,
        error: 'start_date must be before or equal to end_date',
      });
    }

    // Run backfill (this may take a while)
    console.log('Starting BigQuery backfill via API...');
    console.log('Options:', options);

    const result = await bigQueryBackfillService.runBackfillAll(options);

    if (result.success) {
      // Build detailed message
      const total = result.rows_inserted + result.rows_updated;
      let message = `Successfully backfilled ${total} rows`;

      if (total === 0) {
        message = 'Backfill completed successfully, but no data was found. This could mean:\n';
        message += '• No data exists in BigQuery for the specified date/ledger range\n';
        message += '• The pool/asset configuration may be incorrect\n';
        message += '• Date range may be outside available data\n';
        message += `\nConfiguration: ${getPoolAssetPairs().length} pool-asset pairs`;
        if (options.startDate || options.endDate) {
          message += `\nDate range: ${options.startDate || 'any'} to ${options.endDate || 'any'}`;
        } else {
          message += `\nDays back: ${options.daysBack || 90}`;
        }
        if (options.startLedger || options.endLedger) {
          message += `\nLedger range: ${options.startLedger || 'any'} to ${options.endLedger || 'any'}`;
        }
      }

      res.json({
        success: true,
        rows_inserted: result.rows_inserted,
        rows_updated: result.rows_updated,
        total: total,
        message,
        details: {
          poolAssetPairs: getPoolAssetPairs().length,
          options: {
            daysBack: options.daysBack,
            startDate: options.startDate,
            endDate: options.endDate,
            startLedger: options.startLedger,
            endLedger: options.endLedger,
            targetUser: options.targetUser,
          }
        }
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Backfill failed',
      });
    }
  } catch (error) {
    console.error('Backfill API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/backfill/pool
 * Run BigQuery pool snapshots backfill with options
 */
router.post('/backfill/pool', async (req: Request, res: Response) => {
  try {
    // Validate poolId
    if (!req.body.poolId || typeof req.body.poolId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid poolId: must be a valid Stellar address',
      });
    }

    if (!isValidStellarAddress(req.body.poolId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid poolId: must be a valid Stellar address (56 chars, starting with G/C/M)',
      });
    }

    const options: PoolBackfillOptions = {
      poolId: req.body.poolId,
      skipConfirmation: true, // Skip confirmation prompts for API calls
    };

    // Validate and parse options from request body
    if (req.body.daysBack !== undefined) {
      try {
        options.daysBack = parseAndValidateInt(req.body.daysBack, 1, 3650, 'daysBack');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid daysBack',
        });
      }
    }

    if (req.body.startDate) {
      if (typeof req.body.startDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.startDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be in YYYY-MM-DD format',
        });
      }
      options.startDate = req.body.startDate;
    }

    if (req.body.endDate) {
      if (typeof req.body.endDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.endDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be in YYYY-MM-DD format',
        });
      }
      options.endDate = req.body.endDate;
    }

    if (req.body.startDate && req.body.endDate && req.body.startDate > req.body.endDate) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date range: startDate must be before or equal to endDate',
      });
    }

    // Run pool backfill (this may take a while)
    console.log('Starting BigQuery pool snapshots backfill via API...');
    console.log('Options:', options);

    const result = await bigQueryPoolBackfillService.runBackfillSingle(options);

    if (result.success) {
      // Build detailed message
      const total = result.rows_inserted + result.rows_updated;
      let message = `Successfully backfilled ${total} pool snapshot rows`;

      if (total === 0) {
        message = 'Backfill completed successfully, but no data was found. This could mean:\n';
        message += '• No data exists in BigQuery for the specified date range\n';
        message += '• The pool ID may be incorrect\n';
        message += '• Date range may be outside available data\n';
        if (options.startDate || options.endDate) {
          message += `\nDate range: ${options.startDate || 'any'} to ${options.endDate || 'any'}`;
        } else {
          message += `\nDays back: ${options.daysBack || 90}`;
        }
      }

      res.json({
        success: true,
        rows_inserted: result.rows_inserted,
        rows_updated: result.rows_updated,
        total: total,
        message,
        details: {
          poolId: options.poolId,
          options: {
            daysBack: options.daysBack,
            startDate: options.startDate,
            endDate: options.endDate,
          }
        }
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Pool backfill failed',
      });
    }
  } catch (error) {
    console.error('Pool backfill API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/backfill/pool/all
 * Run BigQuery pool snapshots backfill for ALL discovered pools
 */
router.post('/backfill/pool/all', async (req: Request, res: Response) => {
  try {
    const options: any = {
      skipConfirmation: true, // Skip confirmation prompts for API calls
    };

    // Validate and parse options from request body
    if (req.body.daysBack !== undefined) {
      try {
        options.daysBack = parseAndValidateInt(req.body.daysBack, 1, 3650, 'daysBack');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid daysBack',
        });
      }
    }

    if (req.body.startDate) {
      if (typeof req.body.startDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.startDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be in YYYY-MM-DD format',
        });
      }
      options.startDate = req.body.startDate;
    }

    if (req.body.endDate) {
      if (typeof req.body.endDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.endDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be in YYYY-MM-DD format',
        });
      }
      options.endDate = req.body.endDate;
    }

    if (req.body.startDate && req.body.endDate && req.body.startDate > req.body.endDate) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date range: startDate must be before or equal to endDate',
      });
    }

    // Run backfill for all pools (this may take a while)
    console.log('Starting BigQuery pool snapshots backfill for ALL pools via API...');
    console.log('Options:', options);

    const result = await bigQueryPoolBackfillService.runBackfillAll(options);

    if (result.success) {
      // Build detailed message
      const total = result.rows_inserted + result.rows_updated;
      let message = `Successfully backfilled ${total} pool snapshot rows`;

      if (total === 0) {
        message = 'Backfill completed successfully, but no data was found. This could mean:\n';
        message += '• No data exists in BigQuery for the specified date range\n';
        message += '• No pools were discovered\n';
        message += '• Date range may be outside available data\n';
        if (options.startDate || options.endDate) {
          message += `\nDate range: ${options.startDate || 'any'} to ${options.endDate || 'any'}`;
        } else {
          message += `\nDays back: ${options.daysBack || 90}`;
        }
      }

      res.json({
        success: true,
        rows_inserted: result.rows_inserted,
        rows_updated: result.rows_updated,
        total: total,
        message,
        details: {
          poolResults: (result as any).poolResults || [],
          options: {
            daysBack: options.daysBack,
            startDate: options.startDate,
            endDate: options.endDate,
          }
        }
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'All pools backfill failed',
      });
    }
  } catch (error) {
    console.error('All pools backfill API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/estimate/pool
 * Get cost estimate for pool snapshots backfill without running it
 */
router.post('/estimate/pool', async (req: Request, res: Response) => {
  try {
    // Validate poolId
    if (!req.body.poolId || typeof req.body.poolId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid poolId: must be a valid Stellar address',
      });
    }

    if (!isValidStellarAddress(req.body.poolId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid poolId: must be a valid Stellar address (56 chars, starting with G/C/M)',
      });
    }

    const params: any = {
      poolId: req.body.poolId,
    };

    // Validate and parse options from request body
    if (req.body.daysBack !== undefined) {
      try {
        params.daysBack = parseAndValidateInt(req.body.daysBack, 1, 3650, 'daysBack');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid daysBack',
        });
      }
    }

    if (req.body.startDate) {
      if (typeof req.body.startDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.startDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be in YYYY-MM-DD format',
        });
      }
      params.startDate = req.body.startDate;
    }

    if (req.body.endDate) {
      if (typeof req.body.endDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.endDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be in YYYY-MM-DD format',
        });
      }
      params.endDate = req.body.endDate;
    }

    if (req.body.startDate && req.body.endDate && req.body.startDate > req.body.endDate) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date range: startDate must be before or equal to endDate',
      });
    }

    // Get cost estimate
    const estimate = await bigQueryClient.getPoolSnapshotsCostEstimate(params);

    res.json({
      success: true,
      bytes: estimate.bytes,
      gb: estimate.gb,
      cost: estimate.cost,
      warning: parseFloat(estimate.cost) > 1 ? 'Cost exceeds $1' : null,
    });
  } catch (error) {
    console.error('Pool estimate API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/estimate/pool/all
 * Get cost estimate for ALL pools backfill without running it
 */
router.post('/estimate/pool/all', async (req: Request, res: Response) => {
  try {
    const params: any = {};

    // Validate and parse options from request body
    if (req.body.daysBack !== undefined) {
      try {
        params.daysBack = parseAndValidateInt(req.body.daysBack, 1, 3650, 'daysBack');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid daysBack',
        });
      }
    }

    if (req.body.startDate) {
      if (typeof req.body.startDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.startDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be in YYYY-MM-DD format',
        });
      }
      params.startDate = req.body.startDate;
    }

    if (req.body.endDate) {
      if (typeof req.body.endDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.endDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be in YYYY-MM-DD format',
        });
      }
      params.endDate = req.body.endDate;
    }

    if (req.body.startDate && req.body.endDate && req.body.startDate > req.body.endDate) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date range: startDate must be before or equal to endDate',
      });
    }

    // Discover all pools
    console.log('🔍 Discovering pools for cost estimate...');
    const discovery = await discoverAllPoolAssets();
    const poolIds = discovery.pools.map(p => p.poolId);

    console.log(`✓ Found ${poolIds.length} pools`);

    if (poolIds.length === 0) {
      return res.json({
        success: true,
        bytes: 0,
        gb: '0.00',
        cost: '0.0000',
        totalPools: 0,
      });
    }

    // Get cost estimate using SINGLE combined query for all pools
    const estimate = await bigQueryClient.getAllPoolsSnapshotsCostEstimate({
      poolIds,
      ...params,
    });

    res.json({
      success: true,
      bytes: estimate.bytes,
      gb: estimate.gb,
      cost: estimate.cost,
      totalPools: poolIds.length,
      poolNames: discovery.pools.map(p => p.poolName),
      warning: parseFloat(estimate.cost) > 1 ? 'Cost exceeds $1' : null,
    });
  } catch (error) {
    console.error('All pools estimate API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/bigquery/pool-snapshots/stats
 * Get current statistics about pool_snapshots table
 */
router.get('/pool-snapshots/stats', async (req: Request, res: Response) => {
  try {
    const stats = await poolRepository.getStats();

    // Get additional details: unique pools and date range
    const detailsResult = await dbPool.query(`
      SELECT
        COUNT(DISTINCT pool_id) as unique_pools,
        MIN(snapshot_date)::text as earliest_date,
        MAX(snapshot_date)::text as latest_date
      FROM pool_snapshots
    `);

    const details = detailsResult.rows[0];

    res.json({
      success: true,
      total_rows: stats.total_rows,
      unique_assets: stats.unique_assets,
      unique_pools: parseInt(details.unique_pools, 10),
      earliest_date: details.earliest_date || null,
      latest_date: details.latest_date || null,
    });
  } catch (error) {
    console.error('Pool snapshots stats API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/bigquery/config
 * Get pool and asset configuration (now uses dynamic discovery)
 */
router.get('/config', async (req: Request, res: Response) => {
  try {
    console.log('🔍 Using dynamic asset discovery for config...');
    const discovery = await discoverAllPoolAssets();
    const discoveredConfig = convertToLegacyConfig(discovery);

    const pairs: Array<{
      poolName: string;
      assetName: string;
      reserveIndex: number;
    }> = [];

    discoveredConfig.forEach(pool => {
      pool.assets.forEach(asset => {
        pairs.push({
          poolName: pool.poolName,
          assetName: asset.name,
          reserveIndex: asset.reserveIndex,
        });
      });
    });

    res.json({
      pools: discoveredConfig,
      combinations: pairs.length,
      pairs,
      totalAssets: discovery.totalAssets,
      uniqueAssets: discovery.uniqueAssets,
      source: 'dynamic-discovery',
    });
  } catch (error) {
    console.error('Config API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/estimate
 * Get cost estimate for backfill without running it
 */
router.post('/estimate', async (req: Request, res: Response) => {
  try {
    const options: BackfillOptions = {};

    // Validate and parse options from request body (same validation as backfill endpoint)
    if (req.body.targetUser) {
      if (typeof req.body.targetUser !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid targetUser: must be a string',
        });
      }
      if (!isValidStellarAddress(req.body.targetUser)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid targetUser: must be a valid Stellar address (56 chars, starting with G/C/M)',
        });
      }
      options.targetUser = req.body.targetUser;
    }

    if (req.body.daysBack !== undefined) {
      try {
        options.daysBack = parseAndValidateInt(req.body.daysBack, 1, 3650, 'daysBack');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid daysBack',
        });
      }
    }

    if (req.body.startDate) {
      if (typeof req.body.startDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.startDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be in YYYY-MM-DD format',
        });
      }
      options.startDate = req.body.startDate;
    }

    if (req.body.endDate) {
      if (typeof req.body.endDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.endDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be in YYYY-MM-DD format',
        });
      }
      options.endDate = req.body.endDate;
    }

    if (req.body.startDate && req.body.endDate && req.body.startDate > req.body.endDate) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date range: startDate must be before or equal to endDate',
      });
    }

    if (req.body.startLedger !== undefined) {
      try {
        options.startLedger = parseAndValidateInt(req.body.startLedger, 0, Number.MAX_SAFE_INTEGER, 'startLedger');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid startLedger',
        });
      }
    }

    if (req.body.endLedger !== undefined) {
      try {
        options.endLedger = parseAndValidateInt(req.body.endLedger, 0, Number.MAX_SAFE_INTEGER, 'endLedger');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid endLedger',
        });
      }
    }

    if (options.startLedger !== undefined && options.endLedger !== undefined && options.startLedger > options.endLedger) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ledger range: startLedger must be less than or equal to endLedger',
      });
    }

    const estimates = [];
    let totalBytes = 0;
    let totalCost = 0;

    // Determine query mode (with backward compatibility)
    let queryMode: 'individual' | 'allAssets' | 'allPools' = 'allPools'; // Default to maximum optimization

    if (req.body.queryMode) {
      queryMode = req.body.queryMode;
    } else if (req.body.allAssets === false) {
      queryMode = 'individual';
    }

    // Use dynamic discovery to get pool configuration
    console.log('🔍 Using dynamic asset discovery for cost estimate...');
    const discovery = await discoverAllPoolAssets();
    const discoveredConfig = convertToLegacyConfig(discovery);
    console.log(`✓ Using ${discoveredConfig.length} pools with ${discovery.totalAssets} total assets\n`);

    if (queryMode === 'allPools') {
      // Get estimate for all pools using OPTIMIZED two-step approach
      console.log('🚀 Using OPTIMIZED multi-pool cost estimation (35% cheaper!)');
      try {
        const poolIds = discoveredConfig.map(p => p.poolId);

        const estimate = await bigQueryClientOptimized.getAllPoolsCostEstimate({
          poolIds,
          ...options,
        });

        const bytes = parseInt(estimate.total.bytes.toString());
        const cost = parseFloat(estimate.total.cost);

        const totalAssets = discoveredConfig.reduce((sum, p) => sum + p.assets.length, 0);
        estimates.push({
          poolName: 'All Pools (Optimized)',
          assetName: `${discoveredConfig.length} pools, ${totalAssets} assets`,
          gb: estimate.total.gb,
          cost: estimate.total.cost,
        });

        totalBytes += bytes;
        totalCost += cost;
      } catch (error) {
        console.error(`Failed to estimate for all pools:`, error);
      }
    } else if (queryMode === 'allAssets') {
      // Get estimate for each pool (all assets combined)
      for (const pool of discoveredConfig) {
        try {
          const estimate = await bigQueryClient.getAllAssetsQueryCostEstimate({
            poolId: pool.poolId,
            ...options,
          });

          const bytes = parseInt(estimate.bytes.toString());
          const cost = parseFloat(estimate.cost);

          estimates.push({
            poolName: pool.poolName,
            assetName: `All assets (${pool.assets.length})`,
            gb: estimate.gb,
            cost: estimate.cost,
          });

          totalBytes += bytes;
          totalCost += cost;
        } catch (error) {
          console.error(`Failed to estimate for ${pool.poolName}:`, error);
        }
      }
    } else {
      // Get estimate for each pool-asset combination (individual mode)
      const pairs: Array<{
        poolId: string;
        poolName: string;
        assetAddress: string;
        assetName: string;
        reserveIndex: number;
      }> = [];

      discoveredConfig.forEach(pool => {
        pool.assets.forEach(asset => {
          pairs.push({
            poolId: pool.poolId,
            poolName: pool.poolName,
            assetAddress: asset.address,
            assetName: asset.name,
            reserveIndex: asset.reserveIndex,
          });
        });
      });

      for (const pair of pairs) {
        try {
          const estimate = await bigQueryClient.getQueryCostEstimate({
            poolId: pair.poolId,
            assetAddress: pair.assetAddress,
            reserveIndex: pair.reserveIndex,
            ...options,
          });

          const bytes = parseInt(estimate.bytes.toString());
          const cost = parseFloat(estimate.cost);

          estimates.push({
            poolName: pair.poolName,
            assetName: pair.assetName,
            gb: estimate.gb,
            cost: estimate.cost,
          });

          totalBytes += bytes;
          totalCost += cost;
        } catch (error) {
          console.error(`Failed to estimate for ${pair.poolName} - ${pair.assetName}:`, error);
        }
      }
    }

    const totalGB = (totalBytes / (1024 ** 3)).toFixed(2);

    res.json({
      success: true,
      total: {
        bytes: totalBytes,
        gb: totalGB,
        cost: totalCost.toFixed(4),
      },
      combinations: estimates.length,
      estimates,
      warning: totalCost > 1 ? 'Cost exceeds $1' : null,
    });
  } catch (error) {
    console.error('Estimate API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/bigquery/status
 * Check if BigQuery is configured and accessible
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const hasCredentials = !!(
      process.env.GOOGLE_CLOUD_PROJECT ||
      process.env.GOOGLE_APPLICATION_CREDENTIALS
    );

    res.json({
      configured: hasCredentials,
      project: process.env.GOOGLE_CLOUD_PROJECT || 'default',
      message: hasCredentials
        ? 'BigQuery credentials configured'
        : 'BigQuery not configured (will use default credentials)',
    });
  } catch (error) {
    console.error('Status API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/bigquery/discover
 * Discover all pool assets using Blend SDK
 * This dynamically fetches all tokens from the pools without manual configuration
 */
router.get('/discover', async (req: Request, res: Response) => {
  try {
    console.log('Starting pool asset discovery...');
    const discovery = await discoverAllPoolAssets();

    res.json({
      success: true,
      ...discovery,
    });
  } catch (error) {
    console.error('Discovery API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/backfill/estimate
 * Get cost estimate for a backfill query without executing it
 */
router.post('/backfill/estimate', async (req: Request, res: Response) => {
  try {
    // Get first pool from discovery for estimation
    const discovery = await getPoolAssetPairsFromDiscovery();

    if (discovery.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No pools configured for backfill',
      });
    }

    const poolId = discovery[0].poolId;

    // Parse and validate options
    const daysBack = req.body.daysBack !== undefined
      ? parseAndValidateInt(req.body.daysBack, 1, 3650, 'daysBack')
      : 90;

    let startDate = req.body.startDate;
    let endDate = req.body.endDate;

    // Validate dates if provided
    if (startDate && !isValidDateFormat(startDate)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid startDate: must be in YYYY-MM-DD format',
      });
    }

    if (endDate && !isValidDateFormat(endDate)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid endDate: must be in YYYY-MM-DD format',
      });
    }

    if (startDate && endDate && startDate > endDate) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date range: startDate must be before or equal to endDate',
      });
    }

    // Get cost estimate
    console.log('Getting cost estimate...');
    console.log(`  Pool: ${poolId}`);
    console.log(`  Days back: ${daysBack}`);
    if (startDate) console.log(`  Start date: ${startDate}`);
    if (endDate) console.log(`  End date: ${endDate}`);

    const estimate = await bigQueryClient.getAllAssetsQueryCostEstimate({
      poolId,
      daysBack,
      startDate,
      endDate,
    });

    res.json({
      success: true,
      poolId,
      daysBack,
      startDate: startDate || null,
      endDate: endDate || null,
      estimate: {
        bytes: estimate.bytes,
        gigabytes: estimate.gb,
        cost_usd: estimate.cost,
      },
      message: `This query will scan approximately ${estimate.gb} GB of data, costing ~$${estimate.cost}`,
    });

  } catch (error) {
    console.error('Cost estimate API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================
// BLEND ACTIONS BACKFILL ROUTES
// ============================================

/**
 * POST /api/bigquery/actions/simulate
 * Simulate the actions backfill - preview data without saving
 */
router.post('/actions/simulate', async (req: Request, res: Response) => {
  try {
    const params: ActionsBackfillParams = {};

    // Validate and parse options from request body
    if (req.body.startLedger !== undefined) {
      try {
        params.startLedger = parseAndValidateInt(req.body.startLedger, 0, Number.MAX_SAFE_INTEGER, 'startLedger');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid startLedger',
        });
      }
    }

    if (req.body.endLedger !== undefined) {
      try {
        params.endLedger = parseAndValidateInt(req.body.endLedger, 0, Number.MAX_SAFE_INTEGER, 'endLedger');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid endLedger',
        });
      }
    }

    if (params.startLedger !== undefined && params.endLedger !== undefined && params.startLedger > params.endLedger) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ledger range: startLedger must be less than or equal to endLedger',
      });
    }

    if (req.body.startDate) {
      if (typeof req.body.startDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.startDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be in YYYY-MM-DD format',
        });
      }
      params.startDate = req.body.startDate;
    }

    if (req.body.endDate) {
      if (typeof req.body.endDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.endDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be in YYYY-MM-DD format',
        });
      }
      params.endDate = req.body.endDate;
    }

    if (req.body.startDate && req.body.endDate && req.body.startDate > req.body.endDate) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date range: startDate must be before or equal to endDate',
      });
    }

    if (req.body.limit !== undefined) {
      try {
        params.limit = parseAndValidateInt(req.body.limit, 1, 10000, 'limit');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid limit',
        });
      }
    }

    console.log('Simulating actions backfill via API...');
    console.log('Options:', params);

    const result = await bigQueryActionsBackfillService.simulate(params);

    if (result.success) {
      res.json({
        success: true,
        rows_count: result.rows.length,
        rows: result.rows,
        estimated_cost: result.estimated_cost,
        query: result.query,
        tracked_pools: bigQueryActionsBackfillService.getTrackedPools(),
        action_types: bigQueryActionsBackfillService.getActionTypes(),
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Simulation failed',
      });
    }
  } catch (error) {
    console.error('Actions simulate API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/actions/estimate
 * Get cost estimate for actions backfill without running it
 */
router.post('/actions/estimate', async (req: Request, res: Response) => {
  try {
    const params: ActionsBackfillParams = {};

    console.log('📊 Actions estimate - Request body:', JSON.stringify(req.body, null, 2));

    // Validate and parse options (same as simulate)
    if (req.body.startLedger !== undefined) {
      params.startLedger = parseAndValidateInt(req.body.startLedger, 0, Number.MAX_SAFE_INTEGER, 'startLedger');
    }
    if (req.body.endLedger !== undefined) {
      params.endLedger = parseAndValidateInt(req.body.endLedger, 0, Number.MAX_SAFE_INTEGER, 'endLedger');
    }
    if (req.body.startDate && isValidDateFormat(req.body.startDate)) {
      params.startDate = req.body.startDate;
    }
    if (req.body.endDate && isValidDateFormat(req.body.endDate)) {
      params.endDate = req.body.endDate;
    }
    if (req.body.limit !== undefined) {
      params.limit = parseAndValidateInt(req.body.limit, 1, 10000000, 'limit');
    }

    console.log('📊 Actions estimate - Parsed params:', JSON.stringify(params, null, 2));
    console.log('Getting cost estimate for actions backfill...');

    const estimate = await bigQueryActionsBackfillService.getCostEstimate(params);

    res.json({
      success: true,
      bytes: estimate.bytes,
      gb: estimate.gb,
      cost: estimate.cost,
      query: estimate.query,
      tracked_pools: bigQueryActionsBackfillService.getTrackedPools(),
      action_types: bigQueryActionsBackfillService.getActionTypes(),
      warning: parseFloat(estimate.cost) > 1 ? 'Cost exceeds $1' : null,
    });
  } catch (error) {
    console.error('Actions estimate API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/actions/backfill
 * Run the full actions backfill - fetch from BigQuery and save to Neon
 */
router.post('/actions/backfill', async (req: Request, res: Response) => {
  try {
    const params: ActionsBackfillParams = {
      skipConfirmation: true, // Skip confirmation for API calls
    };

    // Validate and parse options
    if (req.body.startLedger !== undefined) {
      try {
        params.startLedger = parseAndValidateInt(req.body.startLedger, 0, Number.MAX_SAFE_INTEGER, 'startLedger');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid startLedger',
        });
      }
    }

    if (req.body.endLedger !== undefined) {
      try {
        params.endLedger = parseAndValidateInt(req.body.endLedger, 0, Number.MAX_SAFE_INTEGER, 'endLedger');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid endLedger',
        });
      }
    }

    if (params.startLedger !== undefined && params.endLedger !== undefined && params.startLedger > params.endLedger) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ledger range: startLedger must be less than or equal to endLedger',
      });
    }

    if (req.body.startDate) {
      if (typeof req.body.startDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.startDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be in YYYY-MM-DD format',
        });
      }
      params.startDate = req.body.startDate;
    }

    if (req.body.endDate) {
      if (typeof req.body.endDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.endDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be in YYYY-MM-DD format',
        });
      }
      params.endDate = req.body.endDate;
    }

    if (req.body.startDate && req.body.endDate && req.body.startDate > req.body.endDate) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date range: startDate must be before or equal to endDate',
      });
    }

    if (req.body.limit !== undefined) {
      try {
        params.limit = parseAndValidateInt(req.body.limit, 1, 10000000, 'limit');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid limit',
        });
      }
    }

    console.log('Starting actions backfill via API...');
    console.log('Options:', params);

    const result = await bigQueryActionsBackfillService.runBackfill(params);

    if (result.success) {
      const total = result.rows_inserted + result.rows_updated;
      let message = `Successfully backfilled ${total} blend actions`;

      if (total === 0) {
        message = 'Backfill completed successfully, but no data was found matching the criteria.';
      }

      res.json({
        success: true,
        rows_fetched: result.rows_fetched,
        rows_inserted: result.rows_inserted,
        rows_updated: result.rows_updated,
        total,
        estimated_cost: result.estimated_cost,
        message,
        tracked_pools: bigQueryActionsBackfillService.getTrackedPools(),
        action_types: bigQueryActionsBackfillService.getActionTypes(),
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Actions backfill failed',
      });
    }
  } catch (error) {
    console.error('Actions backfill API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/bigquery/actions/stats
 * Get current statistics about blend_actions table
 */
router.get('/actions/stats', async (req: Request, res: Response) => {
  try {
    const stats = await actionsRepository.getStats();

    res.json({
      success: true,
      stats,
      tracked_pools: bigQueryActionsBackfillService.getTrackedPools(),
      action_types: bigQueryActionsBackfillService.getActionTypes(),
    });
  } catch (error) {
    console.error('Actions stats API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/bigquery/actions/config
 * Get configuration for actions backfill
 */
router.get('/actions/config', async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      tracked_pools: bigQueryActionsBackfillService.getTrackedPools(),
      action_types: bigQueryActionsBackfillService.getActionTypes(),
      bigquery_table: 'crypto-stellar.crypto_stellar.history_contract_events',
      target_table: 'blend_actions',
    });
  } catch (error) {
    console.error('Actions config API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/actions/upload-csv
 * Upload a CSV file with actions data and process it
 */
router.post('/actions/upload-csv', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded',
      });
    }

    console.log(`Received CSV file: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)`);

    // Convert buffer to string
    const csvContent = req.file.buffer.toString('utf-8');

    // Process the CSV
    const result = await processActionsCsv(csvContent);

    if (result.success) {
      res.json({
        success: true,
        rows_fetched: result.rows_fetched,
        rows_inserted: result.rows_inserted,
        rows_updated: result.rows_updated,
        estimated_cost: '0.00', // CSV upload is free
        message: `Successfully processed ${result.rows_fetched} rows from CSV`,
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error || 'CSV processing failed',
        rows_fetched: result.rows_fetched,
      });
    }
  } catch (error) {
    console.error('Actions CSV upload API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================
// BACKSTOP BACKFILL ROUTES
// ============================================

/**
 * POST /api/bigquery/backstop/simulate
 * Preview backstop events from BigQuery without saving
 */
router.post('/backstop/simulate', async (req: Request, res: Response) => {
  try {
    const params: BackstopBackfillParams = {};

    // Validate and parse options from request body
    if (req.body.startLedger !== undefined) {
      try {
        params.startLedger = parseAndValidateInt(req.body.startLedger, 0, Number.MAX_SAFE_INTEGER, 'startLedger');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid startLedger',
        });
      }
    }

    if (req.body.endLedger !== undefined) {
      try {
        params.endLedger = parseAndValidateInt(req.body.endLedger, 0, Number.MAX_SAFE_INTEGER, 'endLedger');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid endLedger',
        });
      }
    }

    if (params.startLedger !== undefined && params.endLedger !== undefined && params.startLedger > params.endLedger) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ledger range: startLedger must be less than or equal to endLedger',
      });
    }

    if (req.body.startDate) {
      if (typeof req.body.startDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.startDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be in YYYY-MM-DD format',
        });
      }
      params.startDate = req.body.startDate;
    }

    if (req.body.endDate) {
      if (typeof req.body.endDate !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be a string',
        });
      }
      if (!isValidDateFormat(req.body.endDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be in YYYY-MM-DD format',
        });
      }
      params.endDate = req.body.endDate;
    }

    if (req.body.startDate && req.body.endDate && req.body.startDate > req.body.endDate) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date range: startDate must be before or equal to endDate',
      });
    }

    if (req.body.limit !== undefined) {
      try {
        params.limit = parseAndValidateInt(req.body.limit, 1, 10000, 'limit');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid limit',
        });
      }
    }

    console.log('Simulating backstop backfill via API...');
    console.log('Options:', params);

    const result = await bigQueryBackstopBackfillService.simulate(params);

    if (result.success) {
      res.json({
        success: true,
        rows_count: result.rows.length,
        rows: result.rows,
        estimated_cost: result.estimated_cost,
        query: result.query,
        backstop_contract: bigQueryBackstopBackfillService.getBackstopContract(),
        action_types: bigQueryBackstopBackfillService.getActionTypes(),
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Simulation failed',
      });
    }
  } catch (error) {
    console.error('Backstop simulate API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/backstop/estimate
 * Get cost estimate for backstop backfill without running it
 */
router.post('/backstop/estimate', async (req: Request, res: Response) => {
  try {
    const params: BackstopBackfillParams = {};

    // Validate and parse options
    if (req.body.startLedger !== undefined) {
      params.startLedger = parseAndValidateInt(req.body.startLedger, 0, Number.MAX_SAFE_INTEGER, 'startLedger');
    }
    if (req.body.endLedger !== undefined) {
      params.endLedger = parseAndValidateInt(req.body.endLedger, 0, Number.MAX_SAFE_INTEGER, 'endLedger');
    }
    if (req.body.startDate && isValidDateFormat(req.body.startDate)) {
      params.startDate = req.body.startDate;
    }
    if (req.body.endDate && isValidDateFormat(req.body.endDate)) {
      params.endDate = req.body.endDate;
    }
    if (req.body.limit !== undefined) {
      params.limit = parseAndValidateInt(req.body.limit, 1, 10000000, 'limit');
    }

    console.log('Getting cost estimate for backstop backfill...');

    const estimate = await bigQueryBackstopBackfillService.getCostEstimate(params);

    res.json({
      success: true,
      bytes: estimate.bytes,
      gb: estimate.gb,
      cost: estimate.cost,
      query: estimate.query,
      backstop_contract: bigQueryBackstopBackfillService.getBackstopContract(),
      action_types: bigQueryBackstopBackfillService.getActionTypes(),
      warning: parseFloat(estimate.cost) > 1 ? 'Cost exceeds $1' : null,
    });
  } catch (error) {
    console.error('Backstop estimate API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/backstop/backfill
 * Run the full backstop backfill - fetch from BigQuery and save to database
 */
router.post('/backstop/backfill', async (req: Request, res: Response) => {
  try {
    const params: BackstopBackfillParams = {
      skipConfirmation: true,
    };

    // Validate and parse options
    if (req.body.startLedger !== undefined) {
      try {
        params.startLedger = parseAndValidateInt(req.body.startLedger, 0, Number.MAX_SAFE_INTEGER, 'startLedger');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid startLedger',
        });
      }
    }

    if (req.body.endLedger !== undefined) {
      try {
        params.endLedger = parseAndValidateInt(req.body.endLedger, 0, Number.MAX_SAFE_INTEGER, 'endLedger');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid endLedger',
        });
      }
    }

    if (params.startLedger !== undefined && params.endLedger !== undefined && params.startLedger > params.endLedger) {
      return res.status(400).json({
        success: false,
        error: 'Invalid ledger range: startLedger must be less than or equal to endLedger',
      });
    }

    if (req.body.startDate) {
      if (typeof req.body.startDate !== 'string' || !isValidDateFormat(req.body.startDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid startDate: must be in YYYY-MM-DD format',
        });
      }
      params.startDate = req.body.startDate;
    }

    if (req.body.endDate) {
      if (typeof req.body.endDate !== 'string' || !isValidDateFormat(req.body.endDate)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid endDate: must be in YYYY-MM-DD format',
        });
      }
      params.endDate = req.body.endDate;
    }

    if (req.body.startDate && req.body.endDate && req.body.startDate > req.body.endDate) {
      return res.status(400).json({
        success: false,
        error: 'Invalid date range: startDate must be before or equal to endDate',
      });
    }

    if (req.body.limit !== undefined) {
      try {
        params.limit = parseAndValidateInt(req.body.limit, 1, 10000000, 'limit');
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: error instanceof Error ? error.message : 'Invalid limit',
        });
      }
    }

    console.log('Starting backstop backfill via API...');
    console.log('Options:', params);

    const result = await bigQueryBackstopBackfillService.runBackfill(params);

    if (result.success) {
      res.json({
        success: true,
        rows_fetched: result.rows_fetched,
        rows_inserted: result.rows_inserted,
        rows_updated: result.rows_updated,
        estimated_cost: result.estimated_cost,
        backstop_contract: bigQueryBackstopBackfillService.getBackstopContract(),
        action_types: bigQueryBackstopBackfillService.getActionTypes(),
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Backfill failed',
        rows_fetched: result.rows_fetched,
      });
    }
  } catch (error) {
    console.error('Backstop backfill API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/bigquery/backstop/stats
 * Get current statistics about backstop_events table
 */
router.get('/backstop/stats', async (req: Request, res: Response) => {
  try {
    const stats = await backstopRepository.getStats();

    res.json({
      success: true,
      stats,
      backstop_contract: bigQueryBackstopBackfillService.getBackstopContract(),
      action_types: bigQueryBackstopBackfillService.getActionTypes(),
    });
  } catch (error) {
    console.error('Backstop stats API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/bigquery/backstop/config
 * Get configuration for backstop backfill
 */
router.get('/backstop/config', async (req: Request, res: Response) => {
  try {
    res.json({
      success: true,
      backstop_contract: bigQueryBackstopBackfillService.getBackstopContract(),
      action_types: bigQueryBackstopBackfillService.getActionTypes(),
      bigquery_table: 'crypto-stellar.crypto_stellar.history_contract_events',
      target_table: 'backstop_events',
    });
  } catch (error) {
    console.error('Backstop config API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/backstop/upload-csv
 * Upload a CSV file with backstop events data and process it
 */
router.post('/backstop/upload-csv', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded',
      });
    }

    console.log(`Received CSV file: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)`);

    // Convert buffer to string
    const csvContent = req.file.buffer.toString('utf-8');

    // Process the CSV
    const result = await processBackstopCsv(csvContent);

    if (result.success) {
      res.json({
        success: true,
        rows_fetched: result.rows_fetched,
        rows_inserted: result.rows_inserted,
        rows_updated: result.rows_updated,
        estimated_cost: '0.00', // CSV upload is free
        message: `Successfully processed ${result.rows_fetched} rows from CSV`,
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error || 'CSV processing failed',
        rows_fetched: result.rows_fetched,
      });
    }
  } catch (error) {
    console.error('Backstop CSV upload API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================
// SYNC POOLS & TOKENS ROUTES
// ============================================

/**
 * GET /api/bigquery/sync/stats
 * Get current stats for pools and tokens tables
 */
router.get('/sync/stats', async (req: Request, res: Response) => {
  try {
    const syncService = new SyncPoolsTokensService(dbPool);
    const stats = await syncService.getStats();

    res.json({
      success: true,
      ...stats,
    });
  } catch (error) {
    console.error('Sync stats API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/sync/run
 * Run the sync for pools and tokens tables
 */
router.post('/sync/run', async (req: Request, res: Response) => {
  try {
    console.log('Starting pools & tokens sync via API...');

    const syncService = new SyncPoolsTokensService(dbPool);
    const result = await syncService.runSync();

    if (result.success) {
      res.json({
        success: true,
        pools_synced: result.pools.synced,
        tokens_inserted: result.tokens.inserted,
        tokens_updated: result.tokens.updated,
        pools_errors: result.pools.errors,
        tokens_errors: result.tokens.errors,
        message: `Synced ${result.pools.synced} pools, ${result.tokens.inserted} new tokens, ${result.tokens.updated} updated tokens`,
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error || 'Sync failed',
      });
    }
  } catch (error) {
    console.error('Sync run API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================
// LP PRICE BACKFILL ROUTES
// ============================================

// Configure multer for JSON uploads
const jsonUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/json' ||
        file.originalname.endsWith('.json') ||
        file.originalname.endsWith('.ndjson') ||
        file.originalname.endsWith('.jsonl')) {
      cb(null, true);
    } else {
      cb(new Error('Only JSON files are allowed'));
    }
  },
});

/**
 * GET /api/bigquery/lp-prices/stats
 * Get current statistics about LP prices in daily_token_prices
 */
router.get('/lp-prices/stats', async (req: Request, res: Response) => {
  try {
    const lpService = new LpPriceBackfillService(dbPool);
    const stats = await lpService.getStats();

    res.json({
      success: true,
      ...stats,
      lp_token_address: 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM',
    });
  } catch (error) {
    console.error('LP prices stats API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/bigquery/lp-prices/query
 * Get the BigQuery query for fetching LP prices
 */
router.get('/lp-prices/query', async (req: Request, res: Response) => {
  try {
    const lpService = new LpPriceBackfillService(dbPool);
    const startDate = (req.query.startDate as string) || '2025-04-15';
    const endDate = req.query.endDate as string | undefined;

    const query = lpService.getBigQueryQuery(startDate, endDate);

    res.json({
      success: true,
      query,
      instructions: [
        '1. Copy the query above',
        '2. Run it in BigQuery Console (https://console.cloud.google.com/bigquery)',
        '3. Export results as JSON (newline delimited or regular)',
        '4. Upload the JSON file using the upload endpoint',
      ],
      lp_token_address: 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM',
    });
  } catch (error) {
    console.error('LP prices query API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/bigquery/lp-prices/data
 * Get existing LP price data from the database
 */
router.get('/lp-prices/data', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;
    const offset = req.query.offset ? parseInt(req.query.offset as string) : 0;

    const result = await dbPool.query(`
      SELECT
        price_date::text as price_date,
        usd_price as lp_token_price,
        source
      FROM daily_token_prices
      WHERE token_address = 'CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM'
      ORDER BY price_date DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows.map(row => ({
        ...row,
        price_date: row.price_date.split('T')[0],
        lp_token_price: parseFloat(row.lp_token_price),
      })),
    });
  } catch (error) {
    console.error('LP prices data API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/lp-prices/estimate
 * Get cost estimate for LP price backfill with given date range
 */
router.post('/lp-prices/estimate', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate } = req.body;

    const lpService = new LpPriceBackfillService(dbPool);
    const estimate = await lpService.getCostEstimate({ startDate, endDate });

    res.json({
      success: true,
      ...estimate,
    });
  } catch (error) {
    console.error('LP prices estimate API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/lp-prices/simulate
 * Preview LP price data from BigQuery without saving
 */
router.post('/lp-prices/simulate', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, limit } = req.body;

    const lpService = new LpPriceBackfillService(dbPool);
    const result = await lpService.simulate({ startDate, endDate, limit });

    res.json({
      success: result.success,
      rows_count: result.rows.length,
      rows: result.rows,
      estimated_cost: result.estimated_cost,
      query: result.query,
      error: result.error,
    });
  } catch (error) {
    console.error('LP prices simulate API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/lp-prices/backfill
 * Run LP price backfill directly from BigQuery
 */
router.post('/lp-prices/backfill', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, limit } = req.body;

    const lpService = new LpPriceBackfillService(dbPool);
    const result = await lpService.runFromBigQuery({ startDate, endDate, limit });

    res.json({
      success: result.success,
      rows_fetched: result.rows_fetched,
      rows_inserted: result.rows_inserted,
      rows_updated: result.rows_updated,
      rows_skipped: result.rows_skipped,
      estimated_cost: result.estimated_cost,
      error: result.error,
    });
  } catch (error) {
    console.error('LP prices backfill API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/lp-prices/upload
 * Upload JSON file with LP prices and process it
 */
router.post('/lp-prices/upload', jsonUpload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded',
      });
    }

    console.log(`Received JSON file: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)`);

    // Save file temporarily
    const fs = require('fs');
    const path = require('path');
    const tempDir = path.join(__dirname, '../../../temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempPath = path.join(tempDir, `lp-prices-${Date.now()}.json`);
    fs.writeFileSync(tempPath, req.file.buffer);

    try {
      const lpService = new LpPriceBackfillService(dbPool);
      const dryRun = req.body.dryRun === 'true' || req.body.dryRun === true;

      const result = await lpService.runBackfill({
        filePath: tempPath,
        dryRun,
        skipConfirmation: true,
      });

      res.json({
        success: result.success,
        rows_processed: result.rowsProcessed,
        rows_inserted: result.rowsInserted,
        rows_skipped: result.rowsSkipped,
        dry_run: dryRun,
        error: result.error,
      });
    } finally {
      // Clean up temp file
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  } catch (error) {
    console.error('LP prices upload API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================
// BACKSTOP Q4W PERCENTAGE BACKFILL ROUTES
// ============================================

import { backstopQ4wBackfillService, BackstopQ4wBackfillParams } from '../../services/backstop-q4w-backfill';
import { backstopPoolSnapshotRepository } from '../../repositories/backstop-pool-snapshot-repository';

/**
 * GET /api/bigquery/backstop-q4w/stats
 * Get current statistics about backstop pool snapshots
 */
router.get('/backstop-q4w/stats', async (req: Request, res: Response) => {
  try {
    const stats = await backstopPoolSnapshotRepository.getStats();

    res.json({
      success: true,
      ...stats,
      backstop_contract: backstopQ4wBackfillService.getBackstopContract(),
    });
  } catch (error) {
    console.error('Backstop Q4W stats API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/bigquery/backstop-q4w/query
 * Get the BigQuery query for fetching backstop Q4W data
 */
router.get('/backstop-q4w/query', async (req: Request, res: Response) => {
  try {
    const startDate = (req.query.startDate as string) || '2025-04-14';
    const endDate = req.query.endDate as string | undefined;
    const poolAddress = req.query.poolAddress as string | undefined;

    const query = backstopQ4wBackfillService.getBigQueryQuery({ startDate, endDate, poolAddress });

    res.json({
      success: true,
      query,
      backstop_contract: backstopQ4wBackfillService.getBackstopContract(),
      instructions: [
        '1. Copy the query above',
        '2. Run it in BigQuery Console (https://console.cloud.google.com/bigquery)',
        '3. Review the results for Q4W percentage data',
      ],
    });
  } catch (error) {
    console.error('Backstop Q4W query API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/bigquery/backstop-q4w/data
 * Get existing backstop Q4W data from the database
 */
router.get('/backstop-q4w/data', async (req: Request, res: Response) => {
  try {
    const poolAddress = req.query.poolAddress as string | undefined;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;

    if (poolAddress) {
      // Get data for specific pool
      const data = await backstopPoolSnapshotRepository.getQ4wHistory(poolAddress, startDate, endDate);
      res.json({
        success: true,
        pool_address: poolAddress,
        count: data.length,
        data,
      });
    } else {
      // Get latest Q4W for all pools
      const data = await backstopPoolSnapshotRepository.getLatestQ4wByPool();
      res.json({
        success: true,
        count: data.length,
        data,
      });
    }
  } catch (error) {
    console.error('Backstop Q4W data API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/backstop-q4w/estimate
 * Get cost estimate for backstop Q4W backfill
 */
router.post('/backstop-q4w/estimate', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, poolAddress } = req.body;

    const estimate = await backstopQ4wBackfillService.getCostEstimate({
      startDate,
      endDate,
      poolAddress,
    });

    res.json({
      success: true,
      ...estimate,
    });
  } catch (error) {
    console.error('Backstop Q4W estimate API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/backstop-q4w/simulate
 * Preview backstop Q4W data from BigQuery without saving
 */
router.post('/backstop-q4w/simulate', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, poolAddress, limit } = req.body;

    const result = await backstopQ4wBackfillService.simulate({
      startDate,
      endDate,
      poolAddress,
      limit,
    });

    res.json({
      success: result.success,
      rows_count: result.rows.length,
      rows: result.rows,
      estimated_cost: result.estimated_cost,
      query: result.query,
      error: result.error,
    });
  } catch (error) {
    console.error('Backstop Q4W simulate API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/bigquery/backstop-q4w/backfill
 * Run backstop Q4W backfill directly from BigQuery
 */
router.post('/backstop-q4w/backfill', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, poolAddress, limit } = req.body;

    const result = await backstopQ4wBackfillService.runBackfill({
      startDate,
      endDate,
      poolAddress,
      limit,
      skipConfirmation: true, // Skip confirmation for API calls
    });

    res.json({
      success: result.success,
      rows_fetched: result.rows_fetched,
      rows_inserted: result.rows_inserted,
      rows_updated: result.rows_updated,
      estimated_cost: result.estimated_cost,
      error: result.error,
    });
  } catch (error) {
    console.error('Backstop Q4W backfill API error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
