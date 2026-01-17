/**
 * Cron endpoint for daily price capture
 *
 * Can be triggered by external cron services (Vercel, GitHub Actions, etc.)
 *
 * Endpoints:
 *   POST /api/cron/capture-prices - Trigger price capture (requires auth)
 *   GET  /api/cron/prices/status  - Check latest prices (public)
 */

import { Router } from "express";
import { Pool } from "pg";
import { DailyPriceCaptureService } from "../../services/daily-price-capture";

const router = Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("neon") ? { rejectUnauthorized: false } : undefined,
});

/**
 * POST /api/cron/capture-prices
 * Trigger daily price capture
 *
 * Requires CRON_SECRET header for authentication
 */
router.post("/capture-prices", async (req, res) => {
  // Verify cron secret
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({
      error: "Unauthorized",
      message: "Invalid or missing CRON_SECRET",
    });
  }

  try {
    console.log("[cron] Price capture triggered via API");

    const service = new DailyPriceCaptureService(pool);
    const result = await service.captureDailyPrices();

    res.json({
      success: result.errors.length === 0,
      date: result.date,
      pricesInserted: result.pricesInserted,
      captured: result.captured,
      errors: result.errors,
    });
  } catch (error: any) {
    console.error("[cron] Price capture failed:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/cron/prices/status
 * Check latest price capture status
 */
router.get("/prices/status", async (req, res) => {
  try {
    // Get latest prices per token
    const latestPrices = await pool.query(`
      SELECT
        t.symbol,
        dtp.token_address,
        dtp.price_date,
        dtp.usd_price,
        dtp.source
      FROM daily_token_prices dtp
      JOIN tokens t ON t.asset_address = dtp.token_address
      WHERE dtp.price_date = (
        SELECT MAX(price_date) FROM daily_token_prices
      )
      ORDER BY t.symbol
    `);

    // Get coverage stats
    const coverage = await pool.query(`
      SELECT
        t.symbol,
        MIN(dtp.price_date) as earliest,
        MAX(dtp.price_date) as latest,
        COUNT(*)::int as days
      FROM tokens t
      LEFT JOIN daily_token_prices dtp ON t.asset_address = dtp.token_address
      GROUP BY t.symbol
      ORDER BY t.symbol
    `);

    res.json({
      latestDate: latestPrices.rows[0]?.price_date || null,
      prices: latestPrices.rows,
      coverage: coverage.rows,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
