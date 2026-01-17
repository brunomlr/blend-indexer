# SubQuery Migration Feasibility Plan

## Executive Summary

**SubQuery CAN replace the current BigQuery + Goldsky architecture** for indexing Blend Protocol data on Stellar/Soroban.

The current backfill only ingests **contract events** from `history_contract_events` - the same data that Goldsky streams. SubQuery fully supports Soroban event indexing.

## Current Architecture

### Data Sources
1. **Goldsky (Real-time)** - Streams from `stellar.events` dataset
2. **BigQuery (Historical Backfill)** - Queries from `crypto-stellar.crypto_stellar.history_contract_events`

Both sources provide the **same data type**: Soroban contract events.

### Data Being Indexed

#### 1. Backstop Events (Contract: `CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7`)
| Event Type | Data Extracted |
|------------|----------------|
| deposit | pool_address, user_address, lp_tokens, shares |
| withdraw | pool_address, user_address, lp_tokens, shares |
| queue_withdrawal | pool_address, user_address, shares, q4w_exp |
| dequeue_withdrawal | pool_address, user_address, shares |
| claim | user_address, lp_tokens |
| donate | pool_address, lp_tokens |
| draw | pool_address |
| gulp_emissions | pool_address, emissions_amount, emissions_shares |

#### 2. Blend Pool Events (5 Pool Contracts)
| Event Type | Data Extracted |
|------------|----------------|
| supply | pool_id, asset_address, user_address, amount_underlying, amount_tokens |
| withdraw | pool_id, asset_address, user_address, amount_underlying, amount_tokens |
| supply_collateral | pool_id, asset_address, user_address, amount_underlying, amount_tokens |
| withdraw_collateral | pool_id, asset_address, user_address, amount_underlying, amount_tokens |
| borrow | pool_id, asset_address, user_address, amount_underlying, amount_tokens |
| repay | pool_id, asset_address, user_address, amount_underlying, amount_tokens |
| claim | pool_id, user_address, asset_address, amount_underlying |
| new_auction | pool_id, user_address, auction_type, liquidation_percent, bid/lot data |
| fill_auction | pool_id, user_address, filler_address, auction_type, bid/lot data |

#### 3. Contract State Data (NOT CURRENTLY USED)

The codebase contains `bigquery-client.ts` with queries for contract state (`contract_data` table), but these are **not used by the active backfill services**:

| Data Type | Status |
|-----------|--------|
| Positions | ⚠️ Code exists but unused |
| ResData | ⚠️ Code exists but unused |
| ResConfig | ⚠️ Code exists but unused |

Active backfill only uses events from `history_contract_events`.

---

## SubQuery Capabilities

Based on the documentation, SubQuery supports:

| Handler Type | Description | Use Case |
|--------------|-------------|----------|
| **EventHandler** | Soroban contract events | ✅ Your primary use case |
| **TransactionHandler** | Stellar transactions | Optional |
| **OperationHandler** | Stellar operations | Optional |
| **EffectHandler** | Stellar effects | Optional |
| **BlockHandler** | Every block | Optional |

For your needs (contract events only), the **EventHandler** is sufficient.

---

## Feasibility Assessment

### ✅ SubQuery Can Replace Current Setup

| Current Source | SubQuery Equivalent |
|----------------|---------------------|
| Goldsky `stellar.events` → Backstop Events | ✅ EventHandler filtered by backstop contract_id |
| Goldsky `stellar.events` → Blend Pool Events | ✅ EventHandler filtered by pool contract_ids |
| BigQuery `history_contract_events` → Backstop Events | ✅ EventHandler (historical sync on deploy) |
| BigQuery `history_contract_events` → Pool Events | ✅ EventHandler (historical sync on deploy) |

**Note**: The `bigquery-client.ts` contains code for Positions/ResData/ResConfig queries, but these appear to be legacy/unused. The active backfill services (`bigquery-actions-backfill.ts`, `bigquery-backstop-backfill.ts`) only query events.

---

## Recommendation

### ✅ Migration is Feasible

SubQuery can replace both Goldsky and BigQuery for your current use case:

1. **Real-time indexing**: SubQuery indexes events as they happen (replaces Goldsky)
2. **Historical backfill**: SubQuery syncs from genesis on first deploy (replaces BigQuery backfill)
3. **GraphQL API**: Built-in query interface for your data
4. **Self-hosted or managed**: Run your own node or use SubQuery's managed service

### Benefits of Migration

| Aspect | Current (Goldsky + BQ) | SubQuery |
|--------|------------------------|----------|
| Data sources | 2 (Goldsky + BigQuery) | 1 |
| Cost model | Per-query (BQ) + streaming (GS) | Fixed hosting |
| Backfill | Manual BQ queries | Automatic on deploy |
| Query interface | Custom API + SQL | GraphQL |
| Event parsing | SQL transforms | TypeScript handlers |

---

## Implementation Plan

### Phase 1: Project Setup
1. Initialize SubQuery Stellar project: `subql init --specVersion=stellar`
2. Configure `project.ts` with Stellar mainnet endpoint
3. Define GraphQL schema matching current PostgreSQL tables

### Phase 2: Schema Design
```graphql
# schema.graphql
type BackstopEvent @entity {
  id: ID!
  transactionHash: String!
  ledgerSequence: Int!
  ledgerClosedAt: DateTime!
  actionType: String!
  poolAddress: String
  userAddress: String
  lpTokens: BigInt
  shares: BigInt
  q4wExp: BigInt
  emissionsAmount: BigInt
  emissionsShares: BigInt
}

type BlendAction @entity {
  id: ID!
  poolId: String!
  transactionHash: String!
  ledgerSequence: Int!
  ledgerClosedAt: DateTime!
  actionType: String!
  assetAddress: String
  userAddress: String
  amountUnderlying: BigInt
  amountTokens: BigInt
  impliedRate: BigInt
  auctionType: Int
  fillerAddress: String
  liquidationPercent: Int
  bidAsset: String
  bidAmount: BigInt
  lotAsset: String
  lotAmount: BigInt
}
```

### Phase 3: Handler Implementation
```typescript
// src/mappings/handlers.ts
import { SorobanEvent } from "@subql/types-stellar";
import { BackstopEvent, BlendAction } from "../types";

const BACKSTOP_CONTRACT = "CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7";
const POOL_CONTRACTS = [
  "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
  "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS",
  // ... other pools
];

export async function handleBackstopEvent(event: SorobanEvent): Promise<void> {
  const actionType = event.topic[0]?.toString();

  const record = BackstopEvent.create({
    id: `${event.ledger}-${event.transaction.hash}`,
    transactionHash: event.transaction.hash,
    ledgerSequence: event.ledger,
    ledgerClosedAt: event.ledgerClosedAt,
    actionType,
    poolAddress: parseAddress(event.topic[1]),
    userAddress: parseAddress(event.topic[2]),
    // ... parse event.data for amounts
  });

  await record.save();
}

export async function handlePoolEvent(event: SorobanEvent): Promise<void> {
  // Similar parsing logic for pool events
}
```

### Phase 4: Manifest Configuration
```typescript
// project.ts
export const project = {
  specVersion: "1.0.0",
  name: "blend-protocol-indexer",
  version: "1.0.0",
  runner: {
    node: { name: "@subql/node-stellar", version: "*" },
    query: { name: "@subql/query", version: "*" },
  },
  schema: { file: "./schema.graphql" },
  network: {
    chainId: "mainnet",
    endpoint: ["https://horizon.stellar.org"],
    sorobanEndpoint: "https://soroban-rpc.mainnet.stellar.gateway.fm",
  },
  dataSources: [
    {
      kind: "stellar/Runtime",
      startBlock: 56627571, // Blend contracts start ledger
      mapping: {
        file: "./dist/index.js",
        handlers: [
          {
            kind: "stellar/EventHandler",
            handler: "handleBackstopEvent",
            filter: {
              contractId: BACKSTOP_CONTRACT,
              topics: ["deposit", "withdraw", "queue_withdrawal",
                       "dequeue_withdrawal", "claim", "donate",
                       "draw", "gulp_emissions"],
            },
          },
          // Add handlers for each pool contract
        ],
      },
    },
  ],
};
```

### Phase 5: Deployment & Migration
1. Deploy SubQuery project (Docker or managed service)
2. Wait for initial sync (may take hours/days depending on start block)
3. Validate data matches current PostgreSQL data
4. Switch API consumers to SubQuery GraphQL endpoint
5. Deprecate Goldsky pipeline and BigQuery backfill

---

## Configuration Decisions

| Question | Answer |
|----------|--------|
| Start block | **56,627,571** |
| Hosting | **Self-hosted Docker** |
| Query interface | GraphQL (no REST wrapper needed initially) |

---

## Sync Time Estimate

| Metric | Value |
|--------|-------|
| Start ledger | 56,627,571 |
| Current ledger | ~60,303,636 |
| Ledgers to sync | **~3.7 million** |

Estimated sync time (filtering 6 contracts):

| Scenario | Blocks/sec | Time |
|----------|------------|------|
| Optimistic | 500 | ~2 hours |
| Realistic | 100 | ~10 hours |
| Conservative | 50 | ~20 hours |

Bottleneck is RPC archive data speed, not event processing.

