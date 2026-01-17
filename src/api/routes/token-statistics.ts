import { Router } from "express";
import { Pool } from "pg";

const router = Router();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("neon") ? { rejectUnauthorized: false } : undefined,
});

interface TokenStatistic {
  asset_address: string;
  symbol: string;
  name: string | null;
  total_records: number;
  source_counts: Record<string, number>;
  earliest_date: string;
  latest_date: string;
  earliest_price: number | null;
  latest_price: number | null;
}

// GET /api/token-statistics
// Returns statistics about daily_token_prices for each token
router.get("/", async (req, res) => {
  try {
    // First get all tokens from the tokens table
    const tokensResult = await pool.query(`
      SELECT asset_address, symbol, name
      FROM tokens
      ORDER BY symbol
    `);

    // Get statistics for each token
    const statsQuery = `
      WITH price_stats AS (
        SELECT
          token_address,
          source,
          COUNT(*) as record_count,
          MIN(price_date) as earliest_date,
          MAX(price_date) as latest_date
        FROM daily_token_prices
        GROUP BY token_address, source
      ),
      earliest_prices AS (
        SELECT DISTINCT ON (token_address)
          token_address,
          usd_price as earliest_price
        FROM daily_token_prices
        ORDER BY token_address, price_date ASC
      ),
      latest_prices AS (
        SELECT DISTINCT ON (token_address)
          token_address,
          usd_price as latest_price
        FROM daily_token_prices
        ORDER BY token_address, price_date DESC
      )
      SELECT
        t.asset_address,
        t.symbol,
        t.name,
        COALESCE(SUM(ps.record_count), 0)::int as total_records,
        COALESCE(
          json_object_agg(ps.source, ps.record_count) FILTER (WHERE ps.source IS NOT NULL),
          '{}'::json
        ) as source_counts,
        MIN(ps.earliest_date) as earliest_date,
        MAX(ps.latest_date) as latest_date,
        ep.earliest_price,
        lp.latest_price
      FROM tokens t
      LEFT JOIN price_stats ps ON t.asset_address = ps.token_address
      LEFT JOIN earliest_prices ep ON t.asset_address = ep.token_address
      LEFT JOIN latest_prices lp ON t.asset_address = lp.token_address
      GROUP BY t.asset_address, t.symbol, t.name, ep.earliest_price, lp.latest_price
      ORDER BY t.symbol
    `;

    const statsResult = await pool.query(statsQuery);

    // Get all unique sources for the header
    const sourcesResult = await pool.query(`
      SELECT DISTINCT source FROM daily_token_prices ORDER BY source
    `);
    const sources: string[] = sourcesResult.rows.map(r => r.source);

    const statistics: TokenStatistic[] = statsResult.rows.map(row => ({
      asset_address: row.asset_address,
      symbol: row.symbol,
      name: row.name,
      total_records: row.total_records,
      source_counts: row.source_counts || {},
      earliest_date: row.earliest_date,
      latest_date: row.latest_date,
      earliest_price: row.earliest_price ? parseFloat(row.earliest_price) : null,
      latest_price: row.latest_price ? parseFloat(row.latest_price) : null,
    }));

    res.json({
      success: true,
      sources,
      statistics,
      count: statistics.length,
    });
  } catch (error) {
    console.error("Error fetching token statistics:", error);
    res.status(500).json({
      success: false,
      error: (error as Error).message,
    });
  }
});

export default router;
