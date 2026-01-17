/**
 * Daily Price Capture Service
 *
 * Captures current token prices from:
 * - SDK Backstop: For LP token (BLNDUSDCLP) and BLND token (derived from 80/20 pool)
 * - SDK Oracle: For reserve tokens (XLM, USDC, AQUA, etc.)
 * - CoinGecko Exchange Rates: For pegged tokens (stablecoins)
 * - Etherfuse: For TESOURO bond token
 */

import { Pool as PgPool } from "pg";
import { Backstop, FixedMath, Pool, PoolMetadata, PoolV1, PoolV2, Version } from "@blend-capital/blend-sdk";
import { getBlendNetwork } from "../lib/blend/network";
import { TRACKED_POOLS } from "../lib/blend/pools";

const BACKSTOP_ID = "CAO3AGAMZVRMHITL36EJ2VZQWKYRPWMQAPDQD5YEOF3GIF7T44U4JAL3";
const LP_TOKEN_ADDRESS = "CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM";
const BLND_TOKEN_ADDRESS = "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY";
const COINGECKO_EXCHANGE_RATES_URL = "https://api.coingecko.com/api/v3/exchange_rates";

// Etherfuse bond ID for TESOURO token
const ETHERFUSE_BOND_ID = "BRNTNaZeTJANz9PeuD8drNbBHwGgg7ZTjiQYrFgWQ48p";
const ETHERFUSE_API_URL = `https://api.etherfuse.com/lookup/bonds/history/${ETHERFUSE_BOND_ID}`;

export interface CaptureResult {
  date: string;
  captured: string[];
  errors: string[];
  pricesInserted: number;
}

interface PeggedToken {
  asset_address: string;
  symbol: string;
  pegged_currency: string;
}

interface ExchangeRates {
  [currency: string]: number; // USD value of 1 unit of the currency
}

export class DailyPriceCaptureService {
  private db: PgPool;
  private exchangeRates: ExchangeRates | null = null;

  constructor(db: PgPool) {
    this.db = db;
  }

  async captureDailyPrices(): Promise<CaptureResult> {
    const network = getBlendNetwork();
    const today = new Date().toISOString().split("T")[0];
    const captured: string[] = [];
    const errors: string[] = [];
    let pricesInserted = 0;

    console.log(`\n[price-capture] Starting daily price capture for ${today}`);

    // 1. Capture LP token price and BLND price from Backstop
    try {
      console.log("[price-capture] Loading Backstop for LP and BLND prices...");
      const backstop = await Backstop.load(network, BACKSTOP_ID);
      const bt = backstop.backstopToken;

      // LP token price
      const lpPrice = bt.lpTokenPrice;
      await this.saveDailyPrice(LP_TOKEN_ADDRESS, today, lpPrice, "sdk_backstop");
      captured.push(`BLNDUSDCLP: $${lpPrice.toFixed(6)}`);
      pricesInserted++;
      console.log(`[price-capture] LP token: $${lpPrice.toFixed(6)}`);

      // BLND price derived from 80/20 pool
      const usdcAmount = FixedMath.toFloat(bt.usdc, 7);
      const blndAmount = FixedMath.toFloat(bt.blnd, 7);
      const blndPrice = (usdcAmount / 0.2) / (blndAmount / 0.8);
      await this.saveDailyPrice(BLND_TOKEN_ADDRESS, today, blndPrice, "sdk_backstop");
      captured.push(`BLND: $${blndPrice.toFixed(6)}`);
      pricesInserted++;
      console.log(`[price-capture] BLND: $${blndPrice.toFixed(6)}`);
    } catch (error: any) {
      const msg = `Backstop: ${error.message}`;
      errors.push(msg);
      console.error(`[price-capture] ERROR ${msg}`);
    }

    // 2. Get pegged tokens from database and fetch exchange rates
    const peggedTokens = await this.getPeggedTokens();
    if (peggedTokens.length > 0) {
      await this.fetchExchangeRates();
    }

    for (const token of peggedTokens) {
      try {
        const pegValue = this.getPegValue(token.pegged_currency);
        await this.saveDailyPrice(token.asset_address, today, pegValue, "pegged");
        captured.push(`${token.symbol}: $${pegValue.toFixed(4)} (pegged to ${token.pegged_currency})`);
        pricesInserted++;
        console.log(`[price-capture] ${token.symbol}: $${pegValue.toFixed(4)} (pegged to ${token.pegged_currency})`);
      } catch (error: any) {
        errors.push(`${token.symbol}: ${error.message}`);
        console.error(`[price-capture] ERROR ${token.symbol}: ${error.message}`);
      }
    }

    // 3. Capture TESOURO price from Etherfuse
    try {
      const tesouroResult = await this.captureEtherfusePrice(today);
      if (tesouroResult) {
        captured.push(tesouroResult.message);
        pricesInserted++;
      }
    } catch (error: any) {
      const msg = `TESOURO: ${error.message}`;
      errors.push(msg);
      console.error(`[price-capture] ERROR ${msg}`);
    }

    // 4. Capture reserve token prices from each pool
    const seenTokens = new Set<string>();

    for (const trackedPool of TRACKED_POOLS) {
      try {
        console.log(`[price-capture] Loading pool ${trackedPool.name}...`);
        const metadata = await PoolMetadata.load(network, trackedPool.id);
        const pool: Pool = trackedPool.version === Version.V2
          ? await PoolV2.loadWithMetadata(network, trackedPool.id, metadata)
          : await PoolV1.loadWithMetadata(network, trackedPool.id, metadata);

        // Load the oracle to get prices
        const oracle = await pool.loadOracle();

        for (const [assetId, reserve] of pool.reserves) {
          // Skip if already captured (from another pool or pegged)
          if (seenTokens.has(assetId)) {
            continue;
          }
          seenTokens.add(assetId);

          // Skip pegged tokens (already handled above)
          const isPegged = peggedTokens.some(t => t.asset_address === assetId);
          if (isPegged) {
            continue;
          }

          // Get oracle price
          const oraclePrice = oracle.getPriceFloat(assetId);
          if (oraclePrice && oraclePrice > 0) {
            await this.saveDailyPrice(assetId, today, oraclePrice, "sdk_oracle");

            // Get symbol for logging
            const tokenInfo = await this.getTokenSymbol(assetId);
            const symbol = tokenInfo || assetId.slice(0, 8);
            captured.push(`${symbol}: $${oraclePrice.toFixed(6)}`);
            pricesInserted++;
            console.log(`[price-capture] ${symbol}: $${oraclePrice.toFixed(6)}`);
          }
        }
      } catch (error: any) {
        const msg = `Pool ${trackedPool.name}: ${error.message}`;
        errors.push(msg);
        console.error(`[price-capture] ERROR ${msg}`);
      }
    }

    console.log(`[price-capture] Completed: ${pricesInserted} prices captured, ${errors.length} errors`);

    return {
      date: today,
      captured,
      errors,
      pricesInserted,
    };
  }

  private async getPeggedTokens(): Promise<PeggedToken[]> {
    const result = await this.db.query(`
      SELECT asset_address, symbol, pegged_currency
      FROM tokens
      WHERE pegged_currency IS NOT NULL
    `);
    return result.rows;
  }

  private async getTokenSymbol(assetAddress: string): Promise<string | null> {
    const result = await this.db.query(
      `SELECT symbol FROM tokens WHERE asset_address = $1`,
      [assetAddress]
    );
    return result.rows[0]?.symbol || null;
  }

  private async fetchExchangeRates(): Promise<void> {
    if (this.exchangeRates) {
      return; // Already fetched
    }

    console.log("[price-capture] Fetching exchange rates from CoinGecko...");

    try {
      const response = await fetch(COINGECKO_EXCHANGE_RATES_URL);
      if (!response.ok) {
        throw new Error(`CoinGecko API error: ${response.status}`);
      }

      const data = await response.json() as { rates: Record<string, { value: number; type: string }> };
      const rates = data.rates;

      if (!rates || !rates.usd || !rates.usd.value) {
        throw new Error("Invalid exchange rates response");
      }

      const usdValue = rates.usd.value;
      this.exchangeRates = {
        USD: 1.0,
      };

      // Calculate USD value for each currency
      // rates are relative to BTC, so: currency_usd = usd_rate / currency_rate
      for (const [currency, info] of Object.entries(rates)) {
        const currencyInfo = info as { value: number; type: string };
        if (currencyInfo.type === "fiat" && currencyInfo.value > 0) {
          this.exchangeRates[currency.toUpperCase()] = usdValue / currencyInfo.value;
        }
      }

      console.log(`[price-capture] Exchange rates: EUR=$${this.exchangeRates.EUR?.toFixed(4)}, GBP=$${this.exchangeRates.GBP?.toFixed(4)}`);
    } catch (error: any) {
      console.error(`[price-capture] Failed to fetch exchange rates: ${error.message}`);
      // Fallback to hardcoded values if API fails
      this.exchangeRates = {
        USD: 1.0,
        EUR: 1.05,
        GBP: 1.27,
      };
      console.log("[price-capture] Using fallback exchange rates");
    }
  }

  private getPegValue(currency: string): number {
    const upperCurrency = currency.toUpperCase();

    // Use fetched exchange rates if available
    if (this.exchangeRates && this.exchangeRates[upperCurrency]) {
      return this.exchangeRates[upperCurrency];
    }

    // Fallback for USD or unknown currencies
    if (upperCurrency === "USD") {
      return 1.0;
    }

    throw new Error(`No exchange rate available for ${currency}`);
  }

  private async saveDailyPrice(
    tokenAddress: string,
    date: string,
    price: number,
    source: string
  ): Promise<void> {
    await this.db.query(`
      INSERT INTO daily_token_prices (token_address, price_date, usd_price, source)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (token_address, price_date)
      DO UPDATE SET usd_price = EXCLUDED.usd_price, source = EXCLUDED.source
    `, [tokenAddress, date, price, source]);
  }

  private async captureEtherfusePrice(today: string): Promise<{ message: string } | null> {
    // Get TESOURO token address from database
    const tokenResult = await this.db.query(`
      SELECT asset_address FROM tokens WHERE symbol = 'TESOURO'
    `);

    if (tokenResult.rows.length === 0) {
      console.log("[price-capture] TESOURO token not found in database, skipping Etherfuse");
      return null;
    }

    const tokenAddress = tokenResult.rows[0].asset_address;

    console.log("[price-capture] Fetching TESOURO price from Etherfuse...");

    const response = await fetch(ETHERFUSE_API_URL);
    if (!response.ok) {
      throw new Error(`Etherfuse API error: ${response.status}`);
    }

    const data = await response.json() as { historyRange: Array<{ tokenPrice: string; usdExchangeRate: string }> };
    const historyRange = data.historyRange;

    if (!historyRange || !Array.isArray(historyRange) || historyRange.length === 0) {
      throw new Error("No price data in Etherfuse response");
    }

    // Get the most recent entry (last in array)
    const latest = historyRange[historyRange.length - 1];
    const tokenPrice = parseFloat(latest.tokenPrice);
    const usdExchangeRate = parseFloat(latest.usdExchangeRate);

    // Calculate USD price: tokenPrice (BRL) / usdExchangeRate (BRL/USD) = USD
    const usdPrice = tokenPrice / usdExchangeRate;

    await this.saveDailyPrice(tokenAddress, today, usdPrice, "etherfuse");

    const message = `TESOURO: $${usdPrice.toFixed(6)} (Etherfuse)`;
    console.log(`[price-capture] ${message}`);

    return { message };
  }
}
