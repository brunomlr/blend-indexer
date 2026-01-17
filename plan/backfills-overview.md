# Backfills & Data Pipelines Overview

This document explains each backfill/data pipeline in the system, what data it captures, and what features it enables.

---

## 1. Blend Pool Events

**What it captures:**
- All user lending and borrowing actions across Blend pools
- Actions include: supply, withdraw, borrow, repay, claim, and liquidation auctions
- Tracks amounts, assets, and the rates at the time of each action

**What it enables:**
- Real-time tracking of user activity in lending pools
- Historical record of all protocol interactions
- Calculation of user earnings/costs between any two time periods
- Audit trail for all fund movements

---

## 2. Backstop Events

**What it captures:**
- All activity in the Backstop insurance fund
- Actions include: deposit, withdraw, queue/dequeue withdrawals, claims
- BLND emission distributions (gulp_emissions events)
- LP token share movements

**What it enables:**
- Tracking of backstop participant positions
- BLND rewards calculation for backstop depositors
- Monitoring of the protocol's insurance fund health
- Historical analysis of backstop participation

---

## 3. Pool Snapshots

**What it captures:**
- Daily state of each lending pool per asset
- Total token supply columns:
  - **b_supply**: total supplied tokens in the pool
  - **d_supply**: total borrowed tokens from the pool
- Interest rates for suppliers (b_rate) and borrowers (d_rate)

**What it enables:**
- TVL (Total Value Locked) history charts (b_supply × token price)
- Pool utilization tracking over time (d_supply / b_supply)
- Interest rate history and trends
- Emission APY calculations (BLND rewards divided by total supply)

---

## 4. LP Token Price Backfill

**What it captures:**
- Historical daily prices for the BLND-USDC LP token
- Derived from the backstop pool's total shares and USDC backing

**What it enables:**
- Accurate valuation of backstop positions in USD
- Portfolio value tracking for LP token holders
- Historical performance analysis of backstop investments

---

## 5. Token Prices Backfill

**What it captures:**
- Daily prices for all reserve assets (XLM, USDC, AQUA, etc.)
- BLND token price (derived from the 80/20 pool)
- Special asset prices (TESOURO Brazilian bonds from Etherfuse)
- Pegged currency rates (EUR, GBP stablecoins)

**What it enables:**
- USD valuation of all user positions
- Portfolio total value calculations
- Historical performance and P&L analysis
- APY calculations in dollar terms

---

## 6. Emission APY Backfill (daily_emission_apy table)

BLND tokens are distributed as incentives to protocol participants. This backfill calculates the APY from those incentives.

**What it captures:**
- Daily BLND emission APY for three participant types:
  - **Backstop depositors**: BLND rewards for providing insurance to pools
  - **Lending suppliers**: BLND rewards for depositing assets into pools
  - **Lending borrowers**: BLND rewards for borrowing (incentivized borrowing)
- For each day, stores: emission rate (EPS), total supply, BLND price, asset price, and calculated APY

**How it's calculated:**
- Formula: `(emissions per year / total supply) × BLND price / asset price`
- The more people participate, the lower the APY (rewards split among more users)
- The higher BLND price, the higher the APY value in dollar terms

**What it enables:**
- Display of incentive APY alongside base interest APY (so users see total yield)
- Historical charts showing how BLND rewards have changed over time
- Comparison of earning opportunities across pools and assets
- Understanding the "real" yield (base rate + BLND incentives)

---

## 7. Daily Price Capture

**What it captures:**
- Automated daily snapshot of all token prices
- LP token price from Backstop SDK
- BLND price from pool ratio
- Reserve token prices from oracles
- External prices from CoinGecko and Etherfuse

**What it enables:**
- Up-to-date portfolio valuations
- Continuous price history without gaps
- Reliable source of truth for current prices

---

## 8. Pools & Tokens Sync

**What it captures:**
- Reference data for all tracked pools
- Token metadata (symbol, name, decimals) discovered from events
- Asset addresses used across the protocol

**What it enables:**
- Proper display of token names and symbols in the UI
- Correct decimal handling for all assets
- Discovery of new assets as they're added to pools

---

## How They Work Together

```
Blockchain Events
       │
       ├── Pool Events ──────────┬──► User Activity History
       │                         │
       └── Backstop Events ──────┘
                │
                │
       Pool Snapshots ───────────┐
                │                │
       Token Prices ─────────────┼──► Portfolio Valuation
                │                │
       LP Token Prices ──────────┘
                │
                │
       Emission APY ─────────────────► Total Yield Calculations
```

---

## Key Use Cases Enabled

| Use Case | Required Backfills |
|----------|-------------------|
| Show user's current positions | Pool Events, Token Prices |
| Calculate earnings over time | Pool Events, Pool Snapshots, Token Prices |
| Display total APY (base + emissions) | Pool Snapshots, Emission APY, Token Prices |
| Track backstop rewards | Backstop Events, LP Prices, BLND Price |
| Historical portfolio value | Pool Events, Token Prices (all dates) |
| Liquidation monitoring | Pool Events (auction events) |
