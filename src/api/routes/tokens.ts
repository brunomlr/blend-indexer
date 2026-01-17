/**
 * Tokens API endpoints
 *
 * GET /api/tokens - List all tokens with metadata
 * POST /api/tokens/backfill-prices - Backfill CoinGecko prices for a date range
 */

import { Router } from "express";
import { Pool } from "pg";

const router = Router();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("neon") ? { rejectUnauthorized: false } : undefined,
});

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const RATE_LIMIT_MS = 2500; // 2.5 seconds between requests

// Etherfuse bond ID for TESOURO token
const ETHERFUSE_BOND_ID = "BRNTNaZeTJANz9PeuD8drNbBHwGgg7ZTjiQYrFgWQ48p";
const ETHERFUSE_API_URL = `https://api.etherfuse.com/lookup/bonds/history/${ETHERFUSE_BOND_ID}`;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch historical prices from Etherfuse for TESOURO
// Returns a map of date (YYYY-MM-DD) -> USD price
async function fetchEtherfuseHistory(): Promise<Map<string, number>> {
  const prices = new Map<string, number>();

  console.log(`[tokens] Fetching TESOURO prices from Etherfuse...`);

  const response = await fetch(ETHERFUSE_API_URL);
  if (!response.ok) {
    console.error(`[tokens] Failed to fetch Etherfuse: ${response.status}`);
    return prices;
  }

  const data = await response.json();
  const historyRange = data.historyRange;

  if (!historyRange || !Array.isArray(historyRange)) {
    return prices;
  }

  // Group by date and take the last entry for each day
  for (const point of historyRange) {
    const priceDate = point.date.split("T")[0];
    const tokenPrice = parseFloat(point.tokenPrice);
    const usdExchangeRate = parseFloat(point.usdExchangeRate);

    // Calculate USD price: tokenPrice (BRL) / usdExchangeRate (BRL/USD) = USD
    const usdPrice = tokenPrice / usdExchangeRate;
    prices.set(priceDate, usdPrice);
  }

  console.log(`[tokens] Got ${prices.size} TESOURO price points from Etherfuse`);
  return prices;
}

// Fetch historical USDC prices in a given fiat currency to derive exchange rates
// Returns a map of date (YYYY-MM-DD) -> USD value of 1 unit of that currency
async function fetchHistoricalForexRates(
  currency: string,
  fromTs: number,
  toTs: number
): Promise<Map<string, number>> {
  const rates = new Map<string, number>();
  const currencyLower = currency.toLowerCase();

  // Fetch USDC price in the target currency
  const url = `${COINGECKO_BASE}/coins/usd-coin/market_chart/range?vs_currency=${currencyLower}&from=${fromTs}&to=${toTs}`;

  console.log(`[tokens] Fetching USDC/${currency.toUpperCase()} historical rates...`);

  const response = await fetch(url);
  if (!response.ok) {
    console.error(`[tokens] Failed to fetch ${currency} rates: ${response.status}`);
    return rates;
  }

  const data = await response.json();
  const prices: Array<[number, number]> = data.prices || [];

  for (const [timestampMs, usdcInCurrency] of prices) {
    const date = new Date(timestampMs).toISOString().split("T")[0];
    // 1 USDC = X currency, so 1 currency = 1/X USD
    if (usdcInCurrency > 0) {
      rates.set(date, 1 / usdcInCurrency);
    }
  }

  console.log(`[tokens] Got ${rates.size} ${currency.toUpperCase()}/USD rate points`);
  return rates;
}

/**
 * GET /api/tokens
 * List all tokens with their metadata
 */
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        asset_address,
        symbol,
        name,
        decimals,
        coingecko_id,
        pegged_currency,
        is_native,
        created_at,
        updated_at
      FROM tokens
      ORDER BY symbol ASC
    `);

    res.json({
      success: true,
      count: result.rows.length,
      tokens: result.rows,
    });
  } catch (error: any) {
    console.error("[tokens] Failed to fetch tokens:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/tokens/backfill-prices
 * Backfill CoinGecko prices for a date range
 */
router.post("/backfill-prices", async (req, res) => {
  const { startDate, endDate, tokenAddress } = req.body;

  if (!startDate || !endDate) {
    return res.status(400).json({
      success: false,
      error: "startDate and endDate are required",
    });
  }

  try {
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        success: false,
        error: "Invalid date format",
      });
    }

    // Get tokens with coingecko_id (excluding pegged tokens)
    // If tokenAddress is provided, filter to just that token
    let tokensQuery = `
      SELECT asset_address, coingecko_id, symbol
      FROM tokens
      WHERE coingecko_id IS NOT NULL
        AND coingecko_id != ''
        AND pegged_currency IS NULL
    `;
    const queryParams: string[] = [];

    if (tokenAddress) {
      tokensQuery += ` AND asset_address = $1`;
      queryParams.push(tokenAddress);
    }

    const tokensResult = await pool.query(tokensQuery, queryParams);

    const tokens = tokensResult.rows;
    const results: Array<{ symbol: string; coingeckoId: string; inserted: number; error?: string }> = [];

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];

      try {
        // Fetch from CoinGecko
        const fromTs = Math.floor(start.getTime() / 1000);
        const toTs = Math.floor(end.getTime() / 1000);
        const url = `${COINGECKO_BASE}/coins/${token.coingecko_id}/market_chart/range?vs_currency=usd&from=${fromTs}&to=${toTs}`;

        const response = await fetch(url);

        if (!response.ok) {
          const text = await response.text();
          results.push({
            symbol: token.symbol,
            coingeckoId: token.coingecko_id,
            inserted: 0,
            error: `CoinGecko API error ${response.status}: ${text}`,
          });
          continue;
        }

        const data = await response.json();
        const prices: Array<[number, number]> = data.prices || [];

        // Get existing dates
        const existingResult = await pool.query(`
          SELECT price_date::text FROM daily_token_prices WHERE token_address = $1
        `, [token.asset_address]);
        const existingDates = new Set(existingResult.rows.map((r: any) => r.price_date.split('T')[0]));

        let inserted = 0;
        for (const [timestampMs, price] of prices) {
          const priceDate = new Date(timestampMs).toISOString().split("T")[0];

          if (existingDates.has(priceDate)) continue;

          await pool.query(`
            INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
            VALUES ($1, $2, $3, 'coingecko')
            ON CONFLICT (token_address, price_date)
            DO UPDATE SET usd_price = EXCLUDED.usd_price, source = 'coingecko'
          `, [token.asset_address, priceDate, price]);

          inserted++;
        }

        results.push({
          symbol: token.symbol,
          coingeckoId: token.coingecko_id,
          inserted,
        });

        // Rate limit between requests
        if (i < tokens.length - 1) {
          await sleep(RATE_LIMIT_MS);
        }
      } catch (error: any) {
        results.push({
          symbol: token.symbol,
          coingeckoId: token.coingecko_id,
          inserted: 0,
          error: error.message,
        });
      }
    }

    // Also backfill pegged tokens
    let peggedQuery = `
      SELECT asset_address, symbol, pegged_currency
      FROM tokens
      WHERE pegged_currency IS NOT NULL
    `;
    const peggedParams: string[] = [];

    // If a specific token was requested, check if it's a pegged token
    if (tokenAddress) {
      peggedQuery += ` AND asset_address = $1`;
      peggedParams.push(tokenAddress);
    }

    const peggedResult = await pool.query(peggedQuery, peggedParams);

    // Get unique currencies that need forex rates (excluding USD)
    const currenciesNeeded = new Set<string>();
    for (const token of peggedResult.rows) {
      if (token.pegged_currency.toUpperCase() !== "USD") {
        currenciesNeeded.add(token.pegged_currency.toUpperCase());
      }
    }

    // Fetch historical forex rates for each currency
    const forexRates: Map<string, Map<string, number>> = new Map();
    const fromTs = Math.floor(start.getTime() / 1000);
    const toTs = Math.floor(end.getTime() / 1000);

    for (const currency of currenciesNeeded) {
      await sleep(RATE_LIMIT_MS); // Rate limit between requests
      const rates = await fetchHistoricalForexRates(currency, fromTs, toTs);
      forexRates.set(currency, rates);
    }

    let peggedInserted = 0;
    for (const token of peggedResult.rows) {
      const currency = token.pegged_currency.toUpperCase();

      if (currency === "USD") {
        // USD pegged tokens are always $1.00
        const insertResult = await pool.query(`
          INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
          SELECT $1, d::date, 1.0, 'pegged'
          FROM generate_series($2::date, $3::date, '1 day'::interval) d
          ON CONFLICT (token_address, price_date)
          DO UPDATE SET usd_price = EXCLUDED.usd_price, source = EXCLUDED.source
        `, [token.asset_address, startDate, endDate]);
        peggedInserted += insertResult.rowCount || 0;
      } else {
        // Non-USD pegged tokens use historical forex rates
        const rates = forexRates.get(currency);
        if (!rates || rates.size === 0) {
          console.error(`[tokens] No forex rates for ${token.symbol} (${currency})`);
          continue;
        }

        for (const [date, usdValue] of rates) {
          await pool.query(`
            INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
            VALUES ($1, $2, $3, 'pegged')
            ON CONFLICT (token_address, price_date)
            DO UPDATE SET usd_price = EXCLUDED.usd_price, source = EXCLUDED.source
          `, [token.asset_address, date, usdValue]);
          peggedInserted++;
        }
        console.log(`[tokens] ${token.symbol}: updated ${peggedInserted} rates from ${currency}/USD`);
      }
    }

    // Also backfill TESOURO from Etherfuse
    let etherfuseInserted = 0;

    // Check if we should backfill TESOURO
    const tesouroQuery = tokenAddress
      ? `SELECT asset_address, symbol FROM tokens WHERE symbol = 'TESOURO' AND asset_address = $1`
      : `SELECT asset_address, symbol FROM tokens WHERE symbol = 'TESOURO'`;
    const tesouroParams = tokenAddress ? [tokenAddress] : [];
    const tesouroResult = await pool.query(tesouroQuery, tesouroParams);

    if (tesouroResult.rows.length > 0) {
      const tesouro = tesouroResult.rows[0];
      console.log(`[tokens] Backfilling TESOURO from Etherfuse...`);

      try {
        const etherfusePrices = await fetchEtherfuseHistory();

        // Get existing dates
        const existingResult = await pool.query(`
          SELECT price_date::text FROM daily_token_prices WHERE token_address = $1
        `, [tesouro.asset_address]);
        const existingDates = new Set(existingResult.rows.map((r: any) => r.price_date.split('T')[0]));

        // Filter to date range and insert
        for (const [priceDate, usdPrice] of etherfusePrices) {
          const priceDateObj = new Date(priceDate);
          if (priceDateObj < start || priceDateObj > end) continue;
          if (existingDates.has(priceDate)) continue;

          await pool.query(`
            INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
            VALUES ($1, $2, $3, 'etherfuse')
            ON CONFLICT (token_address, price_date)
            DO UPDATE SET usd_price = EXCLUDED.usd_price, source = 'etherfuse'
          `, [tesouro.asset_address, priceDate, usdPrice]);

          etherfuseInserted++;
        }

        console.log(`[tokens] TESOURO: inserted ${etherfuseInserted} prices from Etherfuse`);
      } catch (error: any) {
        console.error(`[tokens] Etherfuse backfill failed: ${error.message}`);
      }
    }

    const totalInserted = results.reduce((sum, r) => sum + r.inserted, 0) + peggedInserted + etherfuseInserted;

    res.json({
      success: true,
      dateRange: { startDate, endDate },
      tokens: results,
      peggedTokensInserted: peggedInserted,
      etherfuseInserted,
      totalInserted,
    });
  } catch (error: any) {
    console.error("[tokens] Backfill prices failed:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
