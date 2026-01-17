# Blend Protocol Event Documentation

## Overview

This document describes all Blend Protocol events captured by the backfill system.

## Tracked Pools

| Pool Name | Contract Address |
|-----------|-----------------|
| Blend Pool V2 | `CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD` |
| YieldBlox V1 | `CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS` |
| Orbit | `CAE7QVOMBLZ53CDRGK3UNRRHG5EZ5NQA7HHTFASEMYBWHG6MDFZTYHXC` |
| Forex | `CBYOBT7ZCCLQCBUYYIABZLSEGDPEUWXCUXQTZYOG3YBDR7U357D5ZIRF` |
| Etherfuse | `CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI` |

---

## Standard Actions

### supply / withdraw

User deposits/withdraws assets to earn interest (non-collateral).

**Topics:**
- `[0]`: `{symbol: "supply"}` or `{symbol: "withdraw"}`
- `[1]`: `{address: "<asset_address>"}` - The reserve asset
- `[2]`: `{address: "<user_address>"}` - The user

**Data:**
```json
{
  "vec": [
    {"i128": "<amount_underlying>"},  // Actual asset amount
    {"i128": "<amount_tokens>"}       // b-token amount
  ]
}
```

**Derived Fields:**
- `implied_rate` = amount_underlying / amount_tokens (b_rate)

---

### supply_collateral / withdraw_collateral

User deposits/withdraws collateral (can be used for borrowing).

**Topics:**
- `[0]`: `{symbol: "supply_collateral"}` or `{symbol: "withdraw_collateral"}`
- `[1]`: `{address: "<asset_address>"}` - The reserve asset
- `[2]`: `{address: "<user_address>"}` - The user

**Data:**
```json
{
  "vec": [
    {"i128": "<amount_underlying>"},  // Actual asset amount
    {"i128": "<amount_tokens>"}       // b-token amount
  ]
}
```

**Derived Fields:**
- `implied_rate` = amount_underlying / amount_tokens (b_rate)

---

### borrow / repay

User borrows/repays assets from the pool.

**Topics:**
- `[0]`: `{symbol: "borrow"}` or `{symbol: "repay"}`
- `[1]`: `{address: "<asset_address>"}` - The reserve asset
- `[2]`: `{address: "<user_address>"}` - The user

**Data:**
```json
{
  "vec": [
    {"i128": "<amount_underlying>"},  // Actual asset amount
    {"i128": "<amount_tokens>"}       // d-token amount
  ]
}
```

**Derived Fields:**
- `implied_rate` = amount_underlying / amount_tokens (d_rate)

---

### claim

User claims BLND emission rewards.

**Topics:**
- `[0]`: `{symbol: "claim"}`
- `[1]`: `{address: "<user_address>"}` - The user claiming
- `[2]`: `{address: "<asset_address>"}` - (Note: May not contain BLND address)

**Data:**
```json
{
  "vec": [
    {"vec": [{"u32": 0}, {"u32": 3}]},  // Reserve indexes being claimed
    {"i128": "<claim_amount>"}          // BLND amount claimed
  ]
}
```

**Notes:**
- Amount is at `vec[1].i128` (NOT vec[0])
- `vec[0]` contains reserve indexes, not amounts
- BLND token address: `CD25MNVTZDL4Y3XMCGVZCERA3LIBSXQ64XTQM5HOJNMO6AB3ES2AG7W5`

---

## Auction Events

### Auction Types

| Value | Type | Description |
|-------|------|-------------|
| 0 | Liquidation | User position liquidated due to health factor |
| 1 | Bad Debt | Uncollateralized debt auction |
| 2 | Interest | Interest rate auction (backstop) |

---

### new_auction

A new auction is created for liquidation, bad debt, or interest.

**Topics:**
- `[0]`: `{symbol: "new_auction"}`
- `[1]`: `{u32: <auction_type>}` - 0=liquidation, 1=bad_debt, 2=interest
- `[2]`: `{address: "<user_address>"}` - The user being liquidated

**Data:**
```json
{
  "vec": [
    {"u32": <liquidation_percent>},  // % of position (0-100)
    {
      "map": [
        {
          "key": {"symbol": "bid"},
          "val": {
            "map": [
              {"key": {"address": "<bid_asset>"}, "val": {"i128": "<bid_amount>"}}
            ]
          }
        },
        {
          "key": {"symbol": "block"},
          "val": {"u32": <block_number>}
        },
        {
          "key": {"symbol": "lot"},
          "val": {
            "map": [
              {"key": {"address": "<lot_asset>"}, "val": {"i128": "<lot_amount>"}},
              // Can have multiple lot assets
            ]
          }
        }
      ]
    }
  ]
}
```

**Extracted Fields:**
- `auction_type`: From topics[1].u32
- `user_address`: From topics[2].address (user being liquidated)
- `liquidation_percent`: From data.vec[0].u32
- `bid_asset`: First asset in bid map
- `bid_amount`: Amount of bid asset
- `lot_asset`: First asset in lot map
- `lot_amount`: Amount of lot asset

**AuctionData Map Structure:**
- `map[0]` = bid (what filler pays)
- `map[1]` = block (auction block number)
- `map[2]` = lot (what filler receives)

---

### fill_auction

An auction is filled (partially or fully).

**Topics:**
- `[0]`: `{symbol: "fill_auction"}`
- `[1]`: `{u32: <auction_type>}` - 0=liquidation, 1=bad_debt, 2=interest
- `[2]`: `{address: "<user_address>"}` - The user whose auction was filled

**Data:**
```json
{
  "vec": [
    {"address": "<filler_address>"},  // Who filled the auction
    {"i128": <fill_percent>},         // % filled (0-100)
    {
      "map": [
        {
          "key": {"symbol": "bid"},
          "val": {
            "map": [
              {"key": {"address": "<bid_asset>"}, "val": {"i128": "<bid_amount>"}}
            ]
          }
        },
        {
          "key": {"symbol": "block"},
          "val": {"u32": <block_number>}
        },
        {
          "key": {"symbol": "lot"},
          "val": {
            "map": [
              {"key": {"address": "<lot_asset>"}, "val": {"i128": "<lot_amount>"}}
            ]
          }
        }
      ]
    }
  ]
}
```

**Extracted Fields:**
- `auction_type`: From topics[1].u32
- `user_address`: From topics[2].address
- `filler_address`: From data.vec[0].address (who filled)
- `liquidation_percent`: From data.vec[1].i128 (fill %)
- `bid_asset`: First asset in bid map (at vec[2])
- `bid_amount`: Amount of bid asset
- `lot_asset`: First asset in lot map
- `lot_amount`: Amount of lot asset

---

## Database Schema

### parsed_events Table

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT | Unique event ID |
| pool_id | VARCHAR(56) | Pool contract address |
| transaction_hash | TEXT | Transaction hash |
| ledger_sequence | BIGINT | Ledger number |
| ledger_closed_at | TIMESTAMP | Event timestamp |
| action_type | VARCHAR(30) | Event type |
| asset_address | VARCHAR(56) | Asset involved (NULL for auctions) |
| user_address | VARCHAR(56) | User address |
| amount_underlying | NUMERIC | Raw asset amount |
| amount_tokens | NUMERIC | b-token or d-token amount |
| implied_rate | NUMERIC | Calculated rate |
| auction_type | INTEGER | 0=liquidation, 1=bad_debt, 2=interest |
| filler_address | VARCHAR(56) | Who filled auction |
| liquidation_percent | INTEGER | % of position/fill |
| bid_asset | VARCHAR(56) | First bid asset address |
| bid_amount | NUMERIC | First bid amount |
| lot_asset | VARCHAR(56) | First lot asset address |
| lot_amount | NUMERIC | First lot amount |

---

## Rate Calculations

### b_rate (Supply Rate)
Used for: `supply`, `withdraw`, `supply_collateral`, `withdraw_collateral`
```
b_rate = amount_underlying / amount_tokens
```
Converts b-tokens to underlying asset value.

### d_rate (Borrow Rate)
Used for: `borrow`, `repay`
```
d_rate = amount_underlying / amount_tokens
```
Converts d-tokens to underlying liability value.

---

## BigQuery Source

Table: `crypto-stellar.crypto_stellar.history_contract_events`

Key columns:
- `topics_decoded`: JSON array of decoded topic values
- `data_decoded`: JSON decoded event data
- `contract_id`: Pool contract address
- `ledger_sequence`: Block number
- `closed_at`: Event timestamp
- `operation_id`: Operation ID within the transaction
- `transaction_id`: Transaction ID

### Event ID Construction

Event IDs follow the Goldsky format: `{ledger}-{tx_hash}-op-{op_idx}-event-{event_idx}`

**Important**: A single operation can emit multiple events (e.g., `fill_auction` triggers `repay` and `supply_collateral`). Each event within an operation is assigned a unique index using `ROW_NUMBER()` to ensure all events are stored separately.

Example for a `fill_auction` transaction:
- `57684987-a3e7...858f-op-0-event-0` (fill_auction)
- `57684987-a3e7...858f-op-0-event-1` (repay)
- `57684987-a3e7...858f-op-0-event-2` (supply_collateral)
