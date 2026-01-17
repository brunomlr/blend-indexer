# Blend Protocol Indexer - Architecture Plan

## Overview

A TypeScript-based Blend Protocol indexer with:
- **Indexer Service**: Long-running Node.js process (Railway/Render/Fly.io)
- **Next.js App**: Monitoring UI + API routes (Vercel)
- **PostgreSQL**: Shared database (Neon/Supabase)

## Tech Stack

| Component | Technology |
|-----------|------------|
| Backend | TypeScript/Node.js |
| Database | PostgreSQL |
| Frontend | Next.js + shadcn/ui |
| Indexer Host | Railway/Render/Fly.io |
| UI Host | Vercel |
| ORM | Drizzle |
| Monorepo | Turborepo + pnpm |

---

## Project Structure

```
blend-indexer/
├── apps/
│   ├── indexer/                     # Long-running indexer service
│   │   ├── src/
│   │   │   ├── index.ts             # Entry point
│   │   │   ├── config/
│   │   │   │   └── index.ts         # Configuration loader
│   │   │   ├── ingestion/
│   │   │   │   ├── ingest-service.ts       # Main orchestrator
│   │   │   │   ├── live-ingestion.ts       # RPC-based live mode
│   │   │   │   ├── backfill-service.ts     # S3 batch backfill
│   │   │   │   └── gap-detector.ts         # Gap detection logic
│   │   │   ├── processors/
│   │   │   │   ├── blend-processor.ts      # XDR event parser
│   │   │   │   ├── pool-events.ts          # Pool event extraction
│   │   │   │   └── backstop-events.ts      # Backstop event extraction
│   │   │   └── health/
│   │   │       └── server.ts               # Health check HTTP server
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── Dockerfile
│   │
│   └── web/                         # Next.js application (Vercel)
│       ├── src/
│       │   ├── app/
│       │   │   ├── layout.tsx
│       │   │   ├── page.tsx                # Dashboard home
│       │   │   ├── api/
│       │   │   │   ├── blend/
│       │   │   │   │   ├── stats/route.ts
│       │   │   │   │   ├── pool-events/route.ts
│       │   │   │   │   └── backstop-events/route.ts
│       │   │   │   └── ingestion/
│       │   │   │       ├── status/route.ts
│       │   │   │       └── trigger-backfill/route.ts
│       │   │   └── monitoring/
│       │   │       ├── page.tsx            # Monitoring dashboard
│       │   │       └── components/
│       │   │           ├── stats-cards.tsx
│       │   │           ├── event-table.tsx
│       │   │           ├── ingestion-progress.tsx
│       │   │           └── gap-detector.tsx
│       │   ├── components/ui/              # shadcn/ui components
│       │   └── lib/
│       │       ├── db.ts                   # Database connection
│       │       └── queries.ts              # SQL query helpers
│       ├── package.json
│       ├── next.config.js
│       └── vercel.json
│
├── packages/
│   ├── database/                    # Shared database package
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── client.ts            # Postgres client
│   │   │   ├── schema.ts            # Drizzle schema definitions
│   │   │   └── migrations/
│   │   │       ├── 0001_initial.sql
│   │   │       └── 0002_blend_events.sql
│   │   └── package.json
│   │
│   ├── blend-types/                 # Shared TypeScript types
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── pool-events.ts
│   │   │   ├── backstop-events.ts
│   │   │   └── ingestion.ts
│   │   └── package.json
│   │
│   └── stellar-utils/               # XDR parsing utilities
│       ├── src/
│       │   ├── index.ts
│       │   ├── xdr-parser.ts
│       │   ├── address-utils.ts
│       │   └── i128-utils.ts
│       └── package.json
│
├── turbo.json
├── package.json
├── pnpm-workspace.yaml
└── README.md
```

---

## Database Schema

### Table: `ingest_store`

Cursor tracking for ingestion progress.

```sql
CREATE TABLE ingest_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ingest_store (key, value) VALUES
    ('latest_ingest_ledger', '0'),
    ('oldest_ingest_ledger', '0');
```

### Table: `pool_events`

Pool protocol events (supply, withdraw, borrow, repay, claim, auctions).

```sql
CREATE TABLE pool_events (
    id TEXT PRIMARY KEY,                          -- Composite: {ledger}-{hash16}
    pool_id TEXT NOT NULL,                        -- Pool contract ID
    transaction_hash TEXT NOT NULL,
    ledger_sequence INTEGER NOT NULL,
    ledger_closed_at TIMESTAMPTZ NOT NULL,
    action_type TEXT NOT NULL,                    -- supply, withdraw, supply_collateral,
                                                  -- withdraw_collateral, borrow, repay,
                                                  -- claim, new_auction, fill_auction
    asset_address TEXT,
    user_address TEXT,
    amount_underlying NUMERIC(78, 0),             -- i128 as string
    amount_tokens NUMERIC(78, 0),                 -- b-tokens or d-tokens
    implied_rate NUMERIC(30, 18),                 -- amount_underlying / amount_tokens

    -- Auction fields
    auction_type INTEGER,                         -- 0=liquidation, 1=bad_debt, 2=interest
    filler_address TEXT,
    liquidation_percent INTEGER,
    bid_asset TEXT,
    bid_amount NUMERIC(78, 0),
    lot_asset TEXT,
    lot_amount NUMERIC(78, 0),

    src TEXT DEFAULT 'indexer',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_pool_events_user ON pool_events(user_address);
CREATE INDEX idx_pool_events_pool ON pool_events(pool_id);
CREATE INDEX idx_pool_events_ledger ON pool_events(ledger_sequence);
CREATE INDEX idx_pool_events_action ON pool_events(action_type);
CREATE INDEX idx_pool_events_asset ON pool_events(asset_address);
CREATE INDEX idx_pool_events_closed_at ON pool_events(ledger_closed_at);
CREATE INDEX idx_pool_events_ledger_id ON pool_events(ledger_sequence DESC, id DESC);
```

### Table: `backstop_events`

Backstop protocol events (deposit, withdraw, claim, emissions).

```sql
CREATE TABLE backstop_events (
    id TEXT PRIMARY KEY,                          -- Composite: {ledger}-{hash16}
    transaction_hash TEXT NOT NULL,
    ledger_sequence INTEGER NOT NULL,
    ledger_closed_at TIMESTAMPTZ NOT NULL,
    action_type TEXT NOT NULL,                    -- deposit, withdraw, queue_withdrawal,
                                                  -- dequeue_withdrawal, claim, donate,
                                                  -- draw, gulp_emissions
    pool_address TEXT,
    user_address TEXT,
    lp_tokens NUMERIC(78, 0),
    shares NUMERIC(78, 0),
    q4w_exp BIGINT,                               -- Queue withdrawal expiration
    emissions_amount NUMERIC(78, 0),
    emissions_shares NUMERIC(78, 0),

    src TEXT DEFAULT 'indexer',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_backstop_events_user ON backstop_events(user_address);
CREATE INDEX idx_backstop_events_pool ON backstop_events(pool_address);
CREATE INDEX idx_backstop_events_ledger ON backstop_events(ledger_sequence);
CREATE INDEX idx_backstop_events_action ON backstop_events(action_type);
CREATE INDEX idx_backstop_events_closed_at ON backstop_events(ledger_closed_at);
CREATE INDEX idx_backstop_events_ledger_id ON backstop_events(ledger_sequence DESC, id DESC);
```

### Table: `blend_contracts`

Registry of tracked Blend contracts.

```sql
CREATE TABLE blend_contracts (
    id SERIAL PRIMARY KEY,
    contract_id TEXT UNIQUE NOT NULL,             -- Contract address (C...)
    contract_type TEXT NOT NULL,                  -- 'pool' or 'backstop'
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Table: `ingestion_jobs`

Backfill job tracking.

```sql
CREATE TABLE ingestion_jobs (
    id SERIAL PRIMARY KEY,
    job_type TEXT NOT NULL,                       -- 'backfill' or 'gap_fill'
    start_ledger INTEGER NOT NULL,
    end_ledger INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',       -- pending, running, completed, failed
    progress_ledger INTEGER,
    error_message TEXT,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ingestion_jobs_status ON ingestion_jobs(status);
```

### Table: `emission_configs`

Stores BLND emission rates per pool/asset. Fetched from SDK and cached.

```sql
CREATE TABLE emission_configs (
    id SERIAL PRIMARY KEY,
    config_type TEXT NOT NULL,               -- 'backstop', 'lending_supply', 'lending_borrow'
    pool_address TEXT NOT NULL,
    asset_address TEXT,                       -- NULL for backstop
    eps NUMERIC(78, 0) NOT NULL,             -- Emissions per second (raw i128)
    eps_decimals INTEGER NOT NULL DEFAULT 14,
    expiration BIGINT,                        -- Unix timestamp when emissions end (NULL = no expiry)
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (config_type, pool_address, asset_address)
);

CREATE INDEX idx_emission_configs_pool ON emission_configs(pool_address);
CREATE INDEX idx_emission_configs_type ON emission_configs(config_type);
```

**Sync Job (run periodically or on-demand):**

```typescript
// apps/indexer/src/jobs/sync-emission-configs.ts
async function syncEmissionConfigs(): Promise<void> {
  for (const trackedPool of TRACKED_POOLS) {
    const pool = await PoolV2.load(network, trackedPool.id);
    const backstopPool = await BackstopPoolV2.load(network, BACKSTOP_ID, trackedPool.id);

    // Backstop emissions
    const backstopEmissions = backstopPool.emissions;
    if (backstopEmissions) {
      await db.query(`
        INSERT INTO emission_configs (config_type, pool_address, eps, eps_decimals, expiration)
        VALUES ('backstop', $1, $2, $3, $4)
        ON CONFLICT (config_type, pool_address, asset_address)
        DO UPDATE SET eps = EXCLUDED.eps, expiration = EXCLUDED.expiration, fetched_at = NOW()
      `, [trackedPool.id, backstopEmissions.eps.toString(), 14, backstopEmissions.expiration || null]);
    }

    // Supply/Borrow emissions per reserve
    for (const reserve of pool.reserves.values()) {
      if (reserve.supplyEmissions?.eps) {
        await db.query(`
          INSERT INTO emission_configs (config_type, pool_address, asset_address, eps, eps_decimals, expiration)
          VALUES ('lending_supply', $1, $2, $3, $4, $5)
          ON CONFLICT (config_type, pool_address, asset_address)
          DO UPDATE SET eps = EXCLUDED.eps, expiration = EXCLUDED.expiration, fetched_at = NOW()
        `, [trackedPool.id, reserve.assetId, reserve.supplyEmissions.eps.toString(), 14, reserve.supplyEmissions.expiration || null]);
      }
      if (reserve.borrowEmissions?.eps) {
        await db.query(`
          INSERT INTO emission_configs (config_type, pool_address, asset_address, eps, eps_decimals, expiration)
          VALUES ('lending_borrow', $1, $2, $3, $4, $5)
          ON CONFLICT (config_type, pool_address, asset_address)
          DO UPDATE SET eps = EXCLUDED.eps, expiration = EXCLUDED.expiration, fetched_at = NOW()
        `, [trackedPool.id, reserve.assetId, reserve.borrowEmissions.eps.toString(), 14, reserve.borrowEmissions.expiration || null]);
      }
    }
  }
}
```

### View: `ledger_gaps`

Gap detection via SQL window function.

```sql
CREATE OR REPLACE VIEW ledger_gaps AS
SELECT gap_start, gap_end FROM (
    SELECT
        ledger_sequence + 1 AS gap_start,
        LEAD(ledger_sequence) OVER (ORDER BY ledger_sequence) - 1 AS gap_end
    FROM (
        SELECT DISTINCT ledger_sequence FROM pool_events
        UNION
        SELECT DISTINCT ledger_sequence FROM backstop_events
    ) combined
) gaps
WHERE gap_start <= gap_end
ORDER BY gap_start;
```

---

## Data Sources

### 1. S3 Ledger Data Lake (Backfill)

- **Bucket**: `s3://aws-public-blockchain/v1.1/stellar/ledgers/pubnet`
- **Format**: Zstandard compressed XDR (`.xdr.zst`)
- **Content**: `LedgerCloseMeta` with full transaction data and Soroban diagnostic events
- **Region**: `us-east-2`

**URL Structure:**
```
https://aws-public-blockchain.s3.us-east-2.amazonaws.com/v1.1/stellar/ledgers/pubnet/{PARTITION}/{BATCH}.xdr.zst
```

### 2. Stellar RPC (Live Ingestion)

- **Method**: `getLedgers` endpoint for batch fetching
- **Example**: `https://soroban-rpc.mainnet.stellar.gateway.fm`

---

## Indexer Service Architecture

### Processing Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         Configuration                            │
│  - Start ledger/date    - Pool contract IDs                     │
│  - End ledger/date      - Backstop contract IDs                 │
│  - Backfill workers     - Batch sizes                           │
└───────────────────────────────┬─────────────────────────────────┘
                                │
            ┌───────────────────┴───────────────────┐
            │                                       │
            v                                       v
┌───────────────────────┐               ┌───────────────────────┐
│   S3 Data Lake        │               │   Stellar RPC         │
│   (Backfill Mode)     │               │   (Live Mode)         │
│                       │               │                       │
│   - Parallel batches  │               │   - Poll for new      │
│   - Zstd decompress   │               │     ledgers           │
│   - XDR parse         │               │   - Real-time events  │
└───────────┬───────────┘               └───────────┬───────────┘
            │                                       │
            └───────────────────┬───────────────────┘
                                │
                                v
┌─────────────────────────────────────────────────────────────────┐
│                      Blend Processor                             │
│                                                                  │
│  1. Parse XDR LedgerCloseMeta                                   │
│  2. Extract Soroban contract diagnostic events                  │
│  3. Filter by pool/backstop contract IDs                        │
│  4. Parse event topics (action type, addresses)                 │
│  5. Parse event data (amounts, auction details)                 │
│  6. Generate deterministic event ID: {ledger}-{sha256[:16]}     │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                v
┌─────────────────────────────────────────────────────────────────┐
│                        PostgreSQL                                │
│                                                                  │
│  - Batch insert (ON CONFLICT DO NOTHING)                        │
│  - Atomic cursor updates                                        │
│  - Gap detection via ledger_gaps view                           │
└─────────────────────────────────────────────────────────────────┘
```

### Backfill Service

```typescript
// Key configuration
const BACKFILL_WORKERS = 8;           // Parallel batch processors
const BACKFILL_BATCH_SIZE = 250;      // Ledgers per batch
const DB_INSERT_BATCH_SIZE = 100;     // Ledgers before DB flush
const MAX_RETRIES = 10;               // S3 fetch retries
const MAX_RETRY_BACKOFF = 30000;      // 30 seconds

// Batch processing
async function processBatch(batch: BackfillBatch): Promise<void> {
  const events = { pool: [], backstop: [] };

  for (const s3Key of batch.s3Keys) {
    // 1. Download from S3
    const compressed = await s3.getObject(s3Key);

    // 2. Decompress with zstd
    const decompressed = zstd.decompress(compressed);

    // 3. Parse XDR batch (multiple ledgers per file)
    const ledgers = parseLedgerXDR(decompressed);

    // 4. Process each ledger
    for (const ledger of ledgers) {
      const result = blendProcessor.processLedger(ledger);
      events.pool.push(...result.poolEvents);
      events.backstop.push(...result.backstopEvents);

      // 5. Periodic flush to control memory
      if (events.pool.length > DB_INSERT_BATCH_SIZE * 100) {
        await flushToDatabase(events);
        events.pool = [];
        events.backstop = [];
      }
    }
  }

  // 6. Final flush with cursor update
  await flushToDatabase(events);
}
```

### Gap Detection

```typescript
interface LedgerGap {
  start: number;
  end: number;
}

async function detectGaps(config: Config): Promise<LedgerGap[]> {
  // Resolve effective start ledger
  const effectiveStart = config.startLedger
    || convertDateToLedger(config.startDate);

  const gaps: LedgerGap[] = [];

  // 1. Gap before oldest ingested ledger
  const { oldest, latest } = await getCursors();
  if (effectiveStart < oldest) {
    gaps.push({ start: effectiveStart, end: oldest - 1 });
  }

  // 2. Internal gaps (from ledger_gaps view)
  const internalGaps = await db.query('SELECT * FROM ledger_gaps');
  gaps.push(...internalGaps.filter(g =>
    g.start >= effectiveStart && g.end <= latest
  ));

  return gaps;
}

// Date to ledger conversion (approximate)
function convertDateToLedger(date: string): number {
  const targetDate = new Date(date);
  const genesisDate = new Date('2015-09-30T16:46:54Z');
  const secondsSinceGenesis = (targetDate.getTime() - genesisDate.getTime()) / 1000;
  return Math.floor(secondsSinceGenesis / 5); // ~5 seconds per ledger
}
```

### Live Ingestion

```typescript
async function runLiveIngestion(): Promise<void> {
  let currentLedger = await getLatestCursor();

  if (currentLedger === 0) {
    // First run - start from network's latest
    const latestInfo = await rpc.getLatestLedger();
    currentLedger = latestInfo.sequence - 1;
    await updateLatestCursor(currentLedger);
  }

  while (running) {
    try {
      // Fetch batch of ledgers
      const ledgers = await rpc.getLedgers({
        startLedger: currentLedger + 1,
        limit: 100,
      });

      if (ledgers.length === 0) {
        await sleep(5000); // Wait for new ledgers
        continue;
      }

      // Process and persist atomically
      const events = await processLedgers(ledgers);
      await persistWithCursorUpdate(events, lastLedger);

      currentLedger = lastLedger;
    } catch (error) {
      console.error('Live ingestion error:', error);
      await sleep(10000);
    }
  }
}
```

---

## Blend Event Parsing

### Pool Event Types

| Action | Topics | Data |
|--------|--------|------|
| `supply` | [action, asset, user] | [underlying_amount, token_amount] |
| `withdraw` | [action, asset, user] | [underlying_amount, token_amount] |
| `supply_collateral` | [action, asset, user] | [underlying_amount, token_amount] |
| `withdraw_collateral` | [action, asset, user] | [underlying_amount, token_amount] |
| `borrow` | [action, asset, user] | [underlying_amount, token_amount] |
| `repay` | [action, asset, user] | [underlying_amount, token_amount] |
| `claim` | [action, user, asset?] | [_, amount] |
| `new_auction` | [action, auction_type, user] | [liquidation_pct, auction_data] |
| `fill_auction` | [action, auction_type, user] | [filler, fill_pct, auction_data] |

### Backstop Event Types

| Action | Topics | Data |
|--------|--------|------|
| `deposit` | [action, pool, user] | [lp_tokens, shares] |
| `withdraw` | [action, pool, user] | [shares, lp_tokens] |
| `queue_withdrawal` | [action, pool, user] | [shares, q4w_exp] |
| `dequeue_withdrawal` | [action, pool, user] | shares (scalar) |
| `claim` | [action, user] | lp_tokens (scalar) |
| `donate` | [action, pool, user] | lp_tokens (scalar) |
| `draw` | [action, pool] | - |
| `gulp_emissions` | [action, pool] | [emissions_amount, emissions_shares] |

### Event ID Generation

Deterministic ID for deduplication:

```typescript
function generatePoolEventId(event: PoolEvent): string {
  const hashInput = [
    event.transactionHash,
    event.poolId,
    event.actionType,
    event.assetAddress || '',
    event.userAddress || '',
    event.amountUnderlying || '',
    event.amountTokens || '',
    event.auctionType?.toString() || '',
    event.fillerAddress || '',
    event.liquidationPercent?.toString() || '',
    event.bidAsset || '',
    event.bidAmount || '',
    event.lotAsset || '',
    event.lotAmount || '',
  ].join('');

  const hash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
  return `${event.ledgerSequence}-${hash}`;
}
```

---

## API Endpoints

### GET `/api/blend/stats`

Returns event counts and progress information.

```json
{
  "poolEvents": [
    { "action": "supply", "count": 12500 },
    { "action": "borrow", "count": 8200 }
  ],
  "backstopEvents": [
    { "action": "deposit", "count": 3400 }
  ],
  "progress": {
    "earliestLedger": 50000000,
    "latestLedger": 60739391,
    "earliestTime": "2024-01-15T00:00:00Z",
    "latestTime": "2025-01-12T12:00:00Z"
  },
  "cursors": {
    "oldest_ingest_ledger": 50000000,
    "latest_ingest_ledger": 60739391
  }
}
```

### GET `/api/blend/pool-events`

Query pool events with pagination.

**Parameters:**
- `userAddress` - Filter by user
- `poolId` - Filter by pool
- `actionTypes` - Comma-separated action types
- `limit` - Page size (default: 50)
- `cursor` - Ledger sequence for pagination
- `order` - `asc` or `desc`

```json
{
  "events": [...],
  "pageInfo": {
    "hasNextPage": true,
    "endCursor": "60739000"
  }
}
```

### GET `/api/ingestion/status`

Returns ingestion status, gaps, and active jobs.

```json
{
  "cursors": {
    "oldest_ingest_ledger": { "value": 50000000, "updatedAt": "..." },
    "latest_ingest_ledger": { "value": 60739391, "updatedAt": "..." }
  },
  "gaps": [
    { "gap_start": 55000000, "gap_end": 55000100, "size": 101 }
  ],
  "totalGaps": 1,
  "totalMissingLedgers": 101,
  "activeJobs": []
}
```

### POST `/api/ingestion/trigger-backfill`

Trigger a backfill job.

**Body:**
```json
{
  "startLedger": 50000000,
  "endLedger": 50100000
}
```
or
```json
{
  "startDate": "2024-01-01",
  "endDate": "2024-06-01"
}
```
or
```json
{
  "fillGaps": true
}
```

---

## Monitoring UI Components

### 1. Stats Cards

Display key metrics:
- Total pool events (by action type)
- Total backstop events (by action type)
- Ledgers indexed (range)
- Time range covered

### 2. Ingestion Progress

Show real-time status:
- Oldest/latest cursors
- Gap warnings with count
- Active backfill jobs with progress bars
- Last updated timestamp

### 3. Event Table

Paginated, filterable event list:
- Filter by user address
- Filter by pool
- Action type badges with colors
- Infinite scroll pagination

### 4. Gap Detector

List detected gaps:
- Start/end ledger for each gap
- Size (missing ledger count)
- "Fill Gap" button per gap
- "Fill All Gaps" bulk action

---

## Environment Variables

### Indexer Service

```bash
# Database
DATABASE_URL=postgresql://user:password@host:5432/blend_indexer

# Ingestion Mode
INGESTION_MODE=live                    # 'live' or 'backfill'

# Cursor Names
LATEST_LEDGER_CURSOR_NAME=latest_ingest_ledger
OLDEST_LEDGER_CURSOR_NAME=oldest_ingest_ledger

# Stellar Network
NETWORK=mainnet
NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"
RPC_URL=https://soroban-rpc.mainnet.stellar.gateway.fm

# S3 Data Lake
AWS_REGION=us-east-2
S3_BUCKET=aws-public-blockchain
S3_PREFIX=v1.1/stellar/ledgers/pubnet

# Backfill Options
START_LEDGER=                          # Optional: starting ledger
END_LEDGER=                            # Optional: ending ledger
START_DATE=                            # Optional: ISO date (alternative to ledger)
END_DATE=                              # Optional: ISO date
BACKFILL_WORKERS=8                     # Parallel batch count
BACKFILL_BATCH_SIZE=250                # Ledgers per batch
BACKFILL_DB_INSERT_BATCH_SIZE=100      # Ledgers before DB flush

# Blend Contracts
POOL_CONTRACT_IDS=CDVQVKOY2YSXS2IC7KN6MNASSHPAO7UN2UR2ON4OIMWEFKQY3FSQPZKT
BACKSTOP_CONTRACT_IDS=CAO3AGAMZVRMHITL36EJ2VZQWKYRPWMQAPDQD5YEOF3GIF7T44U4JAL3

# Server
HEALTH_PORT=8080
METRICS_PORT=9090
```

### Next.js App

```bash
# Database (same as indexer)
DATABASE_URL=postgresql://user:password@host:5432/blend_indexer

# Optional: Admin API key for protected endpoints
ADMIN_API_KEY=your-secret-key
```

---

## Deployment

### Indexer Service (Railway/Render)

**Dockerfile:**
```dockerfile
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages ./packages
COPY apps/indexer ./apps/indexer

RUN npm install -g pnpm
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=indexer...

FROM node:20-alpine
WORKDIR /app

COPY --from=builder /app/apps/indexer/dist ./dist
COPY --from=builder /app/apps/indexer/package.json ./
COPY --from=builder /app/node_modules ./node_modules

ENV NODE_ENV=production
EXPOSE 8080 9090

CMD ["node", "dist/index.js"]
```

**Railway config:**
```toml
[build]
builder = "DOCKERFILE"
dockerfilePath = "apps/indexer/Dockerfile"

[deploy]
healthcheckPath = "/health"
restartPolicyType = "ON_FAILURE"
```

### Next.js App (Vercel)

**vercel.json:**
```json
{
  "buildCommand": "cd ../.. && pnpm turbo run build --filter=web...",
  "outputDirectory": ".next",
  "framework": "nextjs",
  "functions": {
    "app/api/**/*.ts": {
      "maxDuration": 30
    }
  }
}
```

### Database (Neon)

Serverless PostgreSQL with connection pooling:
```bash
DATABASE_URL=postgresql://user:pass@ep-xxx.us-east-1.aws.neon.tech/blend_indexer?sslmode=require
```

---

## Infrastructure Diagram

```
                                    ┌──────────────────┐
                                    │   S3 Data Lake   │
                                    │  (AWS Public     │
                                    │   Blockchain)    │
                                    └────────┬─────────┘
                                             │ Backfill
                                             │
┌──────────────────┐    ┌──────────────────┐ │  ┌──────────────────┐
│   Stellar RPC    │    │     Indexer      │◄┘  │   PostgreSQL     │
│   (Mainnet)      │───►│   Service        │───►│   (Neon)         │
│                  │    │ (Railway/Render) │    │                  │
└──────────────────┘    └──────────────────┘    └────────┬─────────┘
                                                         │
                                                         │
                              ┌──────────────────────────┘
                              │
                              ▼
                       ┌──────────────────┐
                       │   Next.js App    │
                       │   (Vercel)       │
                       │                  │
                       │  • API Routes    │
                       │  • Monitoring UI │
                       └──────────────────┘
```

---

## Key Dependencies

```json
{
  "dependencies": {
    "@stellar/stellar-sdk": "^12.x",
    "@aws-sdk/client-s3": "^3.x",
    "@bokuweb/zstd-wasm": "^0.x",
    "drizzle-orm": "^0.x",
    "pg": "^8.x",
    "p-limit": "^5.x"
  },
  "devDependencies": {
    "turbo": "^2.x",
    "typescript": "^5.x",
    "drizzle-kit": "^0.x"
  }
}
```

**Next.js app additional:**
```json
{
  "dependencies": {
    "next": "^14.x",
    "react": "^18.x",
    "@radix-ui/react-*": "latest",
    "tailwindcss": "^3.x",
    "class-variance-authority": "^0.x",
    "lucide-react": "^0.x"
  }
}
```

---

## Daily Scheduled Jobs (GitHub Actions / Vercel Cron)

These jobs run daily and are **not part of the event indexer** - they use the Blend SDK to capture current on-chain state.

### 1. Daily Price Capture

Captures token prices from Blend SDK oracle and CoinGecko.

**Table: `daily_token_prices`**

```sql
CREATE TABLE daily_token_prices (
    id SERIAL PRIMARY KEY,
    price_date DATE NOT NULL,
    token_address TEXT NOT NULL,
    token_symbol TEXT,
    usd_price NUMERIC(30, 18) NOT NULL,
    source TEXT DEFAULT 'sdk',              -- 'sdk', 'coingecko', 'etherfuse'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (price_date, token_address)
);

CREATE INDEX idx_daily_token_prices_date ON daily_token_prices(price_date);
CREATE INDEX idx_daily_token_prices_token ON daily_token_prices(token_address);
```

**Implementation:**

```typescript
// apps/indexer/src/jobs/capture-daily-prices.ts
import { PoolV2, PoolMetadata, BackstopPoolV2 } from '@blend-capital/blend-sdk';
import { rpc } from '@stellar/stellar-sdk';

async function captureDailyPrices(): Promise<void> {
  const network = getBlendNetwork();
  const today = new Date().toISOString().split('T')[0];

  // 1. Get BLND/LP prices from backstop
  const backstop = await BackstopPoolV2.load(network, BACKSTOP_ID, TRACKED_POOLS[0].id);
  const blndPrice = backstop.backstopToken.lpTokenPrice; // From oracle

  // 2. Get asset prices from each pool's oracle
  for (const trackedPool of TRACKED_POOLS) {
    const pool = await PoolV2.load(network, trackedPool.id);
    for (const reserve of pool.reserves.values()) {
      const price = reserve.oraclePrice; // From pool oracle
      await db.query(`
        INSERT INTO daily_token_prices (price_date, token_address, usd_price, source)
        VALUES ($1, $2, $3, 'sdk')
        ON CONFLICT (price_date, token_address) DO UPDATE SET usd_price = EXCLUDED.usd_price
      `, [today, reserve.assetId, price]);
    }
  }
}
```

### 2. Daily Pool Snapshots

Captures current interest rates and supply totals from Blend SDK (not from events).

**Table: `pool_snapshots`**

```sql
CREATE TABLE pool_snapshots (
    id SERIAL PRIMARY KEY,
    pool_id TEXT NOT NULL,
    asset_address TEXT NOT NULL,
    snapshot_date DATE NOT NULL,
    snapshot_timestamp TIMESTAMPTZ NOT NULL,
    ledger_sequence INTEGER NOT NULL,
    b_rate NUMERIC(30, 18) NOT NULL,        -- Supply rate index (divide raw by 10^12)
    d_rate NUMERIC(30, 18) NOT NULL,        -- Debt rate index (divide raw by 10^12)
    b_supply NUMERIC(30, 18) NOT NULL,      -- Total b-tokens (divide raw by 10^7)
    d_supply NUMERIC(30, 18) NOT NULL,      -- Total d-tokens (divide raw by 10^7)
    last_time INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (pool_id, asset_address, snapshot_date)
);

CREATE INDEX idx_pool_snapshots_lookup ON pool_snapshots(pool_id, asset_address, snapshot_date);
```

**Implementation:**

```typescript
// Captured as part of daily emission APY job
for (const reserve of pool.reserves.values()) {
  const snapshot = {
    pool_id: poolId,
    asset_address: reserve.assetId,
    snapshot_date: today,
    ledger_sequence: currentLedger,
    b_rate: Number(reserve.data.bRate) / 1e12,
    d_rate: Number(reserve.data.dRate) / 1e12,
    b_supply: Number(reserve.data.bSupply) / 1e7,
    d_supply: Number(reserve.data.dSupply) / 1e7,
  };
  await poolRepository.upsert(snapshot);
}
```

### 3. Daily Emission APY Calculation

Calculates BLND emission APY for backstop, supply, and borrow positions.

**Table: `daily_emission_apy`**

```sql
CREATE TABLE daily_emission_apy (
    id SERIAL PRIMARY KEY,
    rate_date DATE NOT NULL,
    apy_type TEXT NOT NULL,                 -- 'backstop', 'lending_supply', 'lending_borrow'
    pool_address TEXT NOT NULL,
    asset_address TEXT,                     -- NULL for backstop
    eps NUMERIC(78, 0) NOT NULL,            -- Emissions per second (raw)
    eps_decimals INTEGER NOT NULL DEFAULT 14,
    total_supply NUMERIC(78, 0) NOT NULL,   -- Total tokens in pool
    blnd_price_usd NUMERIC(30, 18),
    asset_price_usd NUMERIC(30, 18),
    emissions_per_year_per_token NUMERIC(30, 18),
    emission_apy NUMERIC(30, 18),           -- Final APY percentage
    source TEXT DEFAULT 'sdk',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT daily_emission_apy_unique UNIQUE (rate_date, apy_type, pool_address, asset_address)
);
```

**Implementation:**

```typescript
// apps/indexer/src/jobs/calculate-emission-apy.ts
const SECONDS_PER_YEAR = 31_536_000;

async function calculateEmissionApy(): Promise<void> {
  const today = new Date().toISOString().split('T')[0];

  for (const trackedPool of TRACKED_POOLS) {
    const pool = await PoolV2.load(network, trackedPool.id);
    const backstopPool = await BackstopPoolV2.load(network, BACKSTOP_ID, trackedPool.id);

    // Backstop APY
    const backstopEmissions = backstopPool.emissions;
    if (backstopEmissions?.eps > 0n) {
      const { tokens } = backstopPool.poolBalance;
      const epsFloat = Number(backstopEmissions.eps) / 1e14;
      const tokensFloat = Number(tokens) / 1e7;
      const emissionsPerYear = epsFloat * SECONDS_PER_YEAR / tokensFloat;
      const apy = emissionsPerYear * blndPrice / lpPrice * 100;

      await db.insert('daily_emission_apy', {
        rate_date: today,
        apy_type: 'backstop',
        pool_address: trackedPool.id,
        emission_apy: apy,
        // ... other fields
      });
    }

    // Supply/Borrow APY for each reserve
    for (const reserve of pool.reserves.values()) {
      // Similar calculation using reserve.supplyEmissions and reserve.borrowEmissions
    }
  }
}
```

### 4. GitHub Action / Vercel Cron

```yaml
# .github/workflows/daily-jobs.yml
name: Daily Jobs

on:
  schedule:
    - cron: '0 0 * * *'  # Daily at midnight UTC
  workflow_dispatch:

jobs:
  daily-capture:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: pnpm install
      - name: Capture daily prices
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          STELLAR_RPC_URL: ${{ secrets.STELLAR_RPC_URL }}
        run: pnpm --filter indexer run job:daily-prices
      - name: Calculate emission APY
        run: pnpm --filter indexer run job:emission-apy
```

**Alternative: Vercel Cron (in Next.js app)**

```typescript
// apps/web/src/app/api/cron/daily-capture/route.ts
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: Request) {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  await captureDailyPrices();
  await calculateEmissionApy();

  return Response.json({ success: true });
}
```

```json
// vercel.json
{
  "crons": [
    {
      "path": "/api/cron/daily-capture",
      "schedule": "0 0 * * *"
    }
  ]
}
```

---

## RPC Live Ingestion (Detailed)

Replaces Goldsky webhooks with direct RPC polling. More control, no vendor dependency.

### RPC Methods Used

```typescript
// 1. Get latest ledger sequence
const { sequence } = await rpc.getLatestLedger();

// 2. Fetch ledgers with full transaction data
const response = await rpc.getLedgers({
  startLedger: currentLedger + 1,
  limit: 100,  // Max batch size
});

// Response includes LedgerInfo with:
// - sequence, hash, closeTime
// - transactions[] with envelopeXdr, resultXdr, resultMetaXdr
```

### Live Ingestion Service

```typescript
// apps/indexer/src/ingestion/live-ingestion.ts
import { rpc } from '@stellar/stellar-sdk';

interface LiveIngestionConfig {
  rpcUrl: string;
  pollIntervalMs: number;      // Default: 5000 (one ledger)
  batchSize: number;           // Default: 100
  maxRetries: number;          // Default: 5
  retryBackoffMs: number;      // Default: 1000
}

export class LiveIngestionService {
  private running = false;
  private rpcServer: rpc.Server;

  constructor(private config: LiveIngestionConfig, private processor: BlendProcessor) {
    this.rpcServer = new rpc.Server(config.rpcUrl);
  }

  async start(): Promise<void> {
    this.running = true;
    let currentLedger = await this.getLatestCursor();

    // If first run, start from network's latest
    if (currentLedger === 0) {
      const latestInfo = await this.rpcServer.getLatestLedger();
      currentLedger = latestInfo.sequence - 1;
      await this.updateLatestCursor(currentLedger);
      console.log(`First run - starting from ledger ${currentLedger}`);
    }

    console.log(`Live ingestion starting from ledger ${currentLedger + 1}`);

    while (this.running) {
      try {
        // Check for new ledgers
        const latestInfo = await this.rpcServer.getLatestLedger();
        const networkLatest = latestInfo.sequence;

        if (currentLedger >= networkLatest) {
          // Caught up - wait for next ledger
          await this.sleep(this.config.pollIntervalMs);
          continue;
        }

        // Fetch batch of ledgers
        const ledgersToFetch = Math.min(
          networkLatest - currentLedger,
          this.config.batchSize
        );

        console.log(`Fetching ledgers ${currentLedger + 1} to ${currentLedger + ledgersToFetch}`);

        const response = await this.rpcServer.getLedgers({
          startLedger: currentLedger + 1,
          limit: ledgersToFetch,
        });

        if (response.ledgers.length === 0) {
          await this.sleep(this.config.pollIntervalMs);
          continue;
        }

        // Process ledgers
        const events = { pool: [], backstop: [] };

        for (const ledger of response.ledgers) {
          const result = await this.processor.processLedger(ledger);
          events.pool.push(...result.poolEvents);
          events.backstop.push(...result.backstopEvents);
        }

        // Persist atomically with cursor update
        const lastLedger = response.ledgers[response.ledgers.length - 1].sequence;
        await this.persistWithCursorUpdate(events, lastLedger);

        currentLedger = lastLedger;
        console.log(`Processed up to ledger ${currentLedger} (${events.pool.length} pool, ${events.backstop.length} backstop events)`);

      } catch (error) {
        console.error('Live ingestion error:', error);
        await this.sleep(this.config.retryBackoffMs);
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async persistWithCursorUpdate(
    events: { pool: PoolEvent[], backstop: BackstopEvent[] },
    ledger: number
  ): Promise<void> {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      if (events.pool.length > 0) {
        await poolEventsRepository.insertBatch(events.pool, client);
      }
      if (events.backstop.length > 0) {
        await backstopEventsRepository.insertBatch(events.backstop, client);
      }

      // Update cursor
      await client.query(`
        UPDATE ingest_store SET value = $1, updated_at = NOW()
        WHERE key = 'latest_ingest_ledger'
      `, [ledger.toString()]);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async getLatestCursor(): Promise<number> {
    const result = await db.query(`
      SELECT value FROM ingest_store WHERE key = 'latest_ingest_ledger'
    `);
    return parseInt(result.rows[0]?.value || '0');
  }

  private async updateLatestCursor(ledger: number): Promise<void> {
    await db.query(`
      UPDATE ingest_store SET value = $1, updated_at = NOW()
      WHERE key = 'latest_ingest_ledger'
    `, [ledger.toString()]);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

### Processing Ledger Data from RPC

```typescript
// apps/indexer/src/processors/blend-processor.ts
import { xdr } from '@stellar/stellar-sdk';

export class BlendProcessor {
  constructor(
    private poolContractIds: Set<string>,
    private backstopContractId: string
  ) {}

  async processLedger(ledger: LedgerInfo): Promise<ProcessResult> {
    const poolEvents: PoolEvent[] = [];
    const backstopEvents: BackstopEvent[] = [];

    for (const tx of ledger.transactions || []) {
      // Parse transaction result meta XDR
      const metaXdr = xdr.TransactionMeta.fromXDR(tx.resultMetaXdr, 'base64');

      // Extract Soroban events from meta
      const sorobanMeta = metaXdr.v3()?.sorobanMeta();
      if (!sorobanMeta) continue;

      const diagnosticEvents = sorobanMeta.diagnosticEvents();

      for (const event of diagnosticEvents) {
        const contractId = event.event().contractId()?.toString('hex');
        if (!contractId) continue;

        // Convert to C... format
        const contractAddress = StrKey.encodeContract(Buffer.from(contractId, 'hex'));

        if (this.poolContractIds.has(contractAddress)) {
          const parsed = this.parsePoolEvent(event, ledger, tx.hash);
          if (parsed) poolEvents.push(parsed);
        } else if (contractAddress === this.backstopContractId) {
          const parsed = this.parseBackstopEvent(event, ledger, tx.hash);
          if (parsed) backstopEvents.push(parsed);
        }
      }
    }

    return { poolEvents, backstopEvents };
  }

  private parsePoolEvent(event: DiagnosticEvent, ledger: LedgerInfo, txHash: string): PoolEvent | null {
    const topics = event.event().body().v0().topics();
    const data = event.event().body().v0().data();

    // First topic is action type (Symbol)
    const actionType = topics[0]?.sym()?.toString();
    if (!actionType) return null;

    // Parse based on action type
    // (Same logic as current blend_events_processor.go)
    // ...
  }
}
```

---

## User Balance Queries (Derived from Events)

User positions can be derived from `pool_events` by summing all supply/withdraw/borrow/repay events per user.

### Option A: Real-time Query (Simpler)

```sql
-- Get user's current position for an asset
SELECT
  user_address,
  asset_address,
  SUM(CASE
    WHEN action_type IN ('supply', 'supply_collateral') THEN amount_tokens
    WHEN action_type IN ('withdraw', 'withdraw_collateral') THEN -amount_tokens
    ELSE 0
  END) AS net_supply_tokens,
  SUM(CASE
    WHEN action_type = 'borrow' THEN amount_tokens
    WHEN action_type = 'repay' THEN -amount_tokens
    ELSE 0
  END) AS net_debt_tokens
FROM pool_events
WHERE user_address = $1 AND asset_address = $2
GROUP BY user_address, asset_address;
```

### Option B: Materialized View (Better Performance)

```sql
CREATE MATERIALIZED VIEW user_balances AS
SELECT
  pool_id,
  user_address,
  asset_address,
  SUM(CASE
    WHEN action_type = 'supply' THEN amount_tokens
    WHEN action_type = 'withdraw' THEN -amount_tokens
    ELSE 0
  END) AS supply_tokens,
  SUM(CASE
    WHEN action_type = 'supply_collateral' THEN amount_tokens
    WHEN action_type = 'withdraw_collateral' THEN -amount_tokens
    ELSE 0
  END) AS collateral_tokens,
  SUM(CASE
    WHEN action_type = 'borrow' THEN amount_tokens
    WHEN action_type = 'repay' THEN -amount_tokens
    ELSE 0
  END) AS debt_tokens,
  MAX(ledger_closed_at) AS last_activity
FROM pool_events
WHERE user_address IS NOT NULL
GROUP BY pool_id, user_address, asset_address;

CREATE UNIQUE INDEX idx_user_balances_pk ON user_balances(pool_id, user_address, asset_address);

-- Refresh periodically or after backfills
REFRESH MATERIALIZED VIEW CONCURRENTLY user_balances;
```

### Balance with Current Rates

```typescript
// apps/web/src/app/api/blend/balance/route.ts
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userAddress = searchParams.get('user');
  const assetAddress = searchParams.get('asset');

  // Get user's token balances from events
  const balances = await db.query(`
    SELECT * FROM user_balances
    WHERE user_address = $1 AND asset_address = $2
  `, [userAddress, assetAddress]);

  // Get latest rates from pool_snapshots
  const rates = await db.query(`
    SELECT b_rate, d_rate FROM pool_snapshots
    WHERE pool_id = $1 AND asset_address = $2
    ORDER BY snapshot_date DESC LIMIT 1
  `, [balances.rows[0]?.pool_id, assetAddress]);

  // Calculate actual balances
  const supplyBalance = balances.rows[0].supply_tokens * rates.rows[0].b_rate;
  const collateralBalance = balances.rows[0].collateral_tokens * rates.rows[0].b_rate;
  const debtBalance = balances.rows[0].debt_tokens * rates.rows[0].d_rate;

  return Response.json({
    supply: supplyBalance,
    collateral: collateralBalance,
    debt: debtBalance,
    netBalance: supplyBalance + collateralBalance - debtBalance,
  });
}
```

---

## Historical Backfill for Daily Data

The daily jobs capture **today's** data via SDK. For historical data, we backfill from the **S3 Ledger Data Lake**.

### S3 Backfill - What Gets Extracted

The S3 Ledger Data Lake contains full `LedgerCloseMeta` which includes:

1. **Contract Call Events** (Soroban diagnostic events) → `pool_events`, `backstop_events`
2. **Contract State Changes** (ledger entry changes) → `pool_snapshots`

Both are extracted from the same S3 XDR files during backfill:

```
S3 Ledger XDR (.xdr.zst)
├── TransactionMeta.v3().sorobanMeta().diagnosticEvents()
│   └── Pool/Backstop contract events → pool_events, backstop_events
│
└── TransactionMeta.v3().sorobanMeta().ledgerEntryChanges()
    └── ResData contract state changes → pool_snapshots
```

### Unified S3 Backfill Service

```typescript
// apps/indexer/src/backfill/s3-backfill-service.ts
interface BackfillResult {
  poolEvents: number;
  backstopEvents: number;
  poolSnapshots: number;
}

async function backfillFromS3(
  startLedger: number,
  endLedger: number,
  options: { includeSnapshots?: boolean } = { includeSnapshots: true }
): Promise<BackfillResult> {
  const result: BackfillResult = { poolEvents: 0, backstopEvents: 0, poolSnapshots: 0 };

  for await (const ledger of fetchLedgersFromS3(startLedger, endLedger)) {
    const meta = parseLedgerMeta(ledger);

    // 1. Extract contract call events → pool_events, backstop_events
    const sorobanMeta = meta.v3()?.sorobanMeta();
    if (sorobanMeta) {
      for (const event of sorobanMeta.diagnosticEvents()) {
        const contractId = event.event().contractId();
        if (!contractId) continue;

        const contractAddress = StrKey.encodeContract(contractId);

        if (POOL_CONTRACT_IDS.has(contractAddress)) {
          const parsed = parsePoolEvent(event, ledger);
          if (parsed) {
            await poolEventsRepository.insert(parsed);
            result.poolEvents++;
          }
        } else if (contractAddress === BACKSTOP_CONTRACT_ID) {
          const parsed = parseBackstopEvent(event, ledger);
          if (parsed) {
            await backstopEventsRepository.insert(parsed);
            result.backstopEvents++;
          }
        }
      }
    }

    // 2. Extract contract state changes → pool_snapshots (ResData)
    if (options.includeSnapshots && sorobanMeta) {
      for (const change of sorobanMeta.ledgerEntryChanges()) {
        if (change.type !== 'contractData') continue;

        const key = parseContractDataKey(change.key);
        if (key.symbol === 'ResData' && POOL_CONTRACT_IDS.has(key.contractId)) {
          const resData = parseResData(change.val);
          await poolSnapshotsRepository.upsert({
            pool_id: key.contractId,
            asset_address: key.assetAddress,
            snapshot_date: new Date(ledger.closeTime * 1000).toISOString().split('T')[0],
            snapshot_timestamp: new Date(ledger.closeTime * 1000).toISOString(),
            ledger_sequence: ledger.sequence,
            b_rate: Number(resData.bRate) / 1e12,
            d_rate: Number(resData.dRate) / 1e12,
            b_supply: Number(resData.bSupply) / 1e7,
            d_supply: Number(resData.dSupply) / 1e7,
            last_time: resData.lastTime,
          });
          result.poolSnapshots++;
        }
      }
    }
  }

  return result;
}
```

### ResData Contract State Parsing

```typescript
// apps/indexer/src/processors/res-data-parser.ts
interface ResData {
  bRate: bigint;      // Index 0 in map
  bSupply: bigint;    // Index 1 in map
  dRate: bigint;      // Index 3 in map
  dSupply: bigint;    // Index 4 in map
  lastTime: number;   // Index 6 in map
}

function parseResData(val: xdr.ScVal): ResData {
  const map = val.map();
  if (!map) throw new Error('ResData value is not a map');

  return {
    bRate: map.find(e => e.key().u32() === 0)?.val().i128() ?? 0n,
    bSupply: map.find(e => e.key().u32() === 1)?.val().i128() ?? 0n,
    dRate: map.find(e => e.key().u32() === 3)?.val().i128() ?? 0n,
    dSupply: map.find(e => e.key().u32() === 4)?.val().i128() ?? 0n,
    lastTime: Number(map.find(e => e.key().u32() === 6)?.val().u64() ?? 0n),
  };
}

function parseContractDataKey(key: xdr.ScVal): { symbol: string; contractId: string; assetAddress?: string } {
  const vec = key.vec();
  if (!vec || vec.length < 1) throw new Error('Invalid contract data key');

  const symbol = vec[0].sym().toString();
  const contractId = StrKey.encodeContract(/* from ledger entry key */);

  // ResData key structure: [Symbol("ResData"), Address(asset)]
  const assetAddress = vec.length > 1 ? Address.fromScVal(vec[1]).toString() : undefined;

  return { symbol, contractId, assetAddress };
}
```

### Backfill Daily Token Prices

Historical prices can be backfilled from:

1. **CoinGecko API** (has historical prices for most tokens)
2. **DeFiLlama API** (alternative source)

```typescript
// apps/indexer/src/backfill/prices-backfill.ts
async function backfillPricesFromCoingecko(
  tokenAddress: string,
  coingeckoId: string,
  startDate: string,
  endDate: string
): Promise<void> {
  const url = `https://api.coingecko.com/api/v3/coins/${coingeckoId}/market_chart/range`;
  const response = await fetch(`${url}?vs_currency=usd&from=${startTs}&to=${endTs}`);
  const data = await response.json();

  for (const [timestamp, price] of data.prices) {
    const date = new Date(timestamp).toISOString().split('T')[0];
    await db.query(`
      INSERT INTO daily_token_prices (price_date, token_address, usd_price, source)
      VALUES ($1, $2, $3, 'coingecko')
      ON CONFLICT (price_date, token_address) DO NOTHING
    `, [date, tokenAddress, price]);
  }
}
```

### Backfill Emission APY

Once `pool_snapshots`, `daily_token_prices`, and `emission_configs` are populated, historical APY can be calculated:

```typescript
// apps/indexer/src/backfill/emission-apy-backfill.ts
async function backfillEmissionApy(startDate: string, endDate: string): Promise<void> {
  // Uses the same SQL as current system - joins pool_snapshots with emission_configs and daily_token_prices
  await db.query(`
    INSERT INTO daily_emission_apy (rate_date, apy_type, pool_address, asset_address, ...)
    SELECT
      ps.snapshot_date AS rate_date,
      'lending_supply' AS apy_type,
      ps.pool_id AS pool_address,
      ps.asset_address,
      c.eps,
      c.eps_decimals,
      ps.b_supply AS total_supply,
      blnd.usd_price AS blnd_price_usd,
      asset.usd_price AS asset_price_usd,
      CASE WHEN ps.b_supply > 0 THEN
        (c.eps::numeric / POWER(10, c.eps_decimals)) * 31536000 / ps.b_supply::numeric
      ELSE 0 END AS emissions_per_year_per_token,
      CASE WHEN ps.b_supply > 0 AND asset.usd_price > 0 THEN
        ((c.eps::numeric / POWER(10, c.eps_decimals)) * 31536000 / ps.b_supply::numeric)
        * blnd.usd_price / asset.usd_price * 100
      ELSE NULL END AS emission_apy,
      'backfill' AS source
    FROM pool_snapshots ps
    JOIN emission_configs c ON c.pool_address = ps.pool_id AND c.asset_address = ps.asset_address AND c.config_type = 'lending_supply'
    LEFT JOIN daily_token_prices blnd ON blnd.price_date = ps.snapshot_date AND blnd.token_address = $1
    LEFT JOIN daily_token_prices asset ON asset.price_date = ps.snapshot_date AND asset.token_address = ps.asset_address
    WHERE ps.snapshot_date BETWEEN $2 AND $3
    ON CONFLICT ON CONSTRAINT daily_emission_apy_unique DO NOTHING
  `, [BLND_TOKEN, startDate, endDate]);
}
```

### Backfill API Endpoints

```typescript
// apps/web/src/app/api/backfill/pool-snapshots/route.ts
export async function POST(request: Request) {
  const { startLedger, endLedger, startDate, endDate, deriveFromEvents } = await request.json();

  // Convert dates to ledgers if needed
  const start = startLedger || dateToLedger(startDate);
  const end = endLedger || dateToLedger(endDate);

  // Create backfill job
  const job = await db.query(`
    INSERT INTO ingestion_jobs (job_type, start_ledger, end_ledger, status)
    VALUES ('pool_snapshots_backfill', $1, $2, 'pending')
    RETURNING id
  `, [start, end]);

  // Trigger async backfill
  if (deriveFromEvents) {
    triggerBackfillFromEvents(job.rows[0].id, start, end);
  } else {
    triggerBackfillFromS3(job.rows[0].id, start, end);
  }

  return Response.json({ jobId: job.rows[0].id, status: 'started' });
}
```

---

## Monitoring & Alerting

### Health Check Endpoint

```typescript
// apps/indexer/src/health/server.ts
import express from 'express';

const app = express();

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: {
    database: boolean;
    ingestionLag: number;      // Ledgers behind network
    lastIngestionTime: string;
    gapCount: number;
  };
}

app.get('/health', async (req, res) => {
  const health: HealthStatus = {
    status: 'healthy',
    checks: {
      database: false,
      ingestionLag: 0,
      lastIngestionTime: '',
      gapCount: 0,
    },
  };

  try {
    // Check database connection
    await db.query('SELECT 1');
    health.checks.database = true;

    // Check ingestion lag
    const cursor = await db.query(`SELECT value, updated_at FROM ingest_store WHERE key = 'latest_ingest_ledger'`);
    const latestIngested = parseInt(cursor.rows[0]?.value || '0');
    health.checks.lastIngestionTime = cursor.rows[0]?.updated_at;

    const networkLatest = await rpc.getLatestLedger();
    health.checks.ingestionLag = networkLatest.sequence - latestIngested;

    // Check for gaps
    const gaps = await db.query(`SELECT COUNT(*) FROM ledger_gaps`);
    health.checks.gapCount = parseInt(gaps.rows[0].count);

    // Determine overall status
    if (!health.checks.database) {
      health.status = 'unhealthy';
    } else if (health.checks.ingestionLag > 100 || health.checks.gapCount > 0) {
      health.status = 'degraded';
    }

  } catch (error) {
    health.status = 'unhealthy';
  }

  const statusCode = health.status === 'unhealthy' ? 503 : 200;
  res.status(statusCode).json(health);
});

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  const metrics = [];

  // Ingestion metrics
  const cursor = await db.query(`SELECT value FROM ingest_store WHERE key = 'latest_ingest_ledger'`);
  metrics.push(`blend_indexer_latest_ledger ${cursor.rows[0]?.value || 0}`);

  const networkLatest = await rpc.getLatestLedger();
  metrics.push(`blend_indexer_network_ledger ${networkLatest.sequence}`);
  metrics.push(`blend_indexer_lag ${networkLatest.sequence - parseInt(cursor.rows[0]?.value || '0')}`);

  // Event counts
  const poolCount = await db.query(`SELECT COUNT(*) FROM pool_events`);
  metrics.push(`blend_indexer_pool_events_total ${poolCount.rows[0].count}`);

  const backstopCount = await db.query(`SELECT COUNT(*) FROM backstop_events`);
  metrics.push(`blend_indexer_backstop_events_total ${backstopCount.rows[0].count}`);

  // Gap count
  const gaps = await db.query(`SELECT COUNT(*) FROM ledger_gaps`);
  metrics.push(`blend_indexer_gaps_total ${gaps.rows[0].count}`);

  res.type('text/plain').send(metrics.join('\n'));
});

app.listen(process.env.HEALTH_PORT || 8080);
```

### Monitoring Dashboard UI

The Next.js monitoring dashboard should display:

```typescript
// apps/web/src/app/monitoring/page.tsx
export default async function MonitoringPage() {
  return (
    <div className="container mx-auto p-4 space-y-6">
      {/* Ingestion Status Cards */}
      <div className="grid grid-cols-4 gap-4">
        <StatusCard title="Latest Ledger" value={latestLedger} />
        <StatusCard title="Network Ledger" value={networkLedger} />
        <StatusCard title="Lag" value={lag} status={lag > 100 ? 'warning' : 'ok'} />
        <StatusCard title="Gaps" value={gapCount} status={gapCount > 0 ? 'error' : 'ok'} />
      </div>

      {/* Ingestion Progress */}
      <Card>
        <CardHeader>Ingestion Progress</CardHeader>
        <CardContent>
          <ProgressBar start={oldestLedger} current={latestLedger} end={networkLedger} />
          <div className="text-sm text-muted-foreground">
            Last updated: {lastUpdated}
          </div>
        </CardContent>
      </Card>

      {/* Gap Detector */}
      <Card>
        <CardHeader>
          <div className="flex justify-between">
            <span>Detected Gaps</span>
            <Button onClick={fillAllGaps}>Fill All Gaps</Button>
          </div>
        </CardHeader>
        <CardContent>
          <GapTable gaps={gaps} onFillGap={fillGap} />
        </CardContent>
      </Card>

      {/* Active Jobs */}
      <Card>
        <CardHeader>Active Jobs</CardHeader>
        <CardContent>
          <JobsTable jobs={activeJobs} />
        </CardContent>
      </Card>

      {/* Event Stats */}
      <Card>
        <CardHeader>Event Statistics</CardHeader>
        <CardContent>
          <EventStatsChart poolEvents={poolEventStats} backstopEvents={backstopEventStats} />
        </CardContent>
      </Card>

      {/* Backfill Trigger */}
      <Card>
        <CardHeader>Trigger Backfill</CardHeader>
        <CardContent>
          <BackfillForm onSubmit={triggerBackfill} />
        </CardContent>
      </Card>
    </div>
  );
}
```

### Alerting (Optional)

If deploying to Railway/Render, use their built-in alerting. For custom alerts:

```typescript
// apps/indexer/src/monitoring/alerts.ts
async function checkAndAlert(): Promise<void> {
  const health = await getHealthStatus();

  if (health.checks.ingestionLag > 500) {
    await sendAlert({
      severity: 'critical',
      message: `Indexer is ${health.checks.ingestionLag} ledgers behind network`,
    });
  }

  if (health.checks.gapCount > 0) {
    await sendAlert({
      severity: 'warning',
      message: `${health.checks.gapCount} gaps detected in indexed data`,
    });
  }
}

async function sendAlert(alert: Alert): Promise<void> {
  // Option 1: Slack webhook
  if (process.env.SLACK_WEBHOOK_URL) {
    await fetch(process.env.SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `[${alert.severity.toUpperCase()}] ${alert.message}`,
      }),
    });
  }

  // Option 2: PagerDuty
  // Option 3: Email via SendGrid
  // etc.
}

// Run alert check every 5 minutes
setInterval(checkAndAlert, 5 * 60 * 1000);
```

---

## Updated Implementation Phases

### Phase 1: Project Setup
- [ ] Initialize Turborepo monorepo with pnpm
- [ ] Set up shared packages (database, blend-types, stellar-utils)
- [ ] Configure Drizzle ORM and migrations
- [ ] Set up TypeScript configs
- [ ] Create all database tables and indexes

### Phase 2: Indexer Core - Event Ingestion
- [ ] Implement XDR parsing utilities (i128, addresses, contract events)
- [ ] Implement BlendProcessor (pool events + backstop events extraction)
- [ ] Implement S3 backfill service with parallel batch processing
- [ ] Implement RPC live ingestion service (polling loop)
- [ ] Add gap detection logic (SQL view + service)
- [ ] Add health check endpoint (/health, /metrics)
- [ ] Implement date ↔ ledger conversion utilities

### Phase 3: Backfill Services
- [ ] Implement pool_snapshots backfill (Option A: from events, Option B: from S3 ResData)
- [ ] Implement daily_token_prices backfill (CoinGecko API)
- [ ] Implement emission_configs sync job (from SDK)
- [ ] Implement emission_apy backfill (joins snapshots + prices + configs)
- [ ] Create backfill API endpoints with job tracking

### Phase 4: Daily Jobs
- [ ] Implement daily price capture (SDK-based)
- [ ] Implement daily pool snapshots capture (SDK-based)
- [ ] Implement daily emission APY calculation
- [ ] Implement emission_configs sync
- [ ] Set up GitHub Action or Vercel Cron

### Phase 5: Next.js App
- [ ] Initialize Next.js with shadcn/ui
- [ ] Create API routes:
  - [ ] `/api/blend/stats` - Event counts and progress
  - [ ] `/api/blend/pool-events` - Paginated pool events
  - [ ] `/api/blend/backstop-events` - Paginated backstop events
  - [ ] `/api/blend/balance` - User balance (derived from events + rates)
  - [ ] `/api/ingestion/status` - Cursors, gaps, jobs
  - [ ] `/api/ingestion/trigger-backfill` - Start backfill jobs
  - [ ] `/api/backfill/*` - Pool snapshots, prices, APY backfill
- [ ] Build monitoring dashboard UI:
  - [ ] Status cards (ledger, lag, gaps)
  - [ ] Ingestion progress bar
  - [ ] Gap detector with fill actions
  - [ ] Active jobs table
  - [ ] Event statistics chart
  - [ ] Backfill trigger form

### Phase 6: Monitoring & Alerting
- [ ] Health check endpoint with degraded/unhealthy states
- [ ] Prometheus metrics endpoint
- [ ] Optional: Slack/PagerDuty alerting integration
- [ ] Dashboard real-time refresh

### Phase 7: Deployment
- [ ] Create Dockerfile for indexer service
- [ ] Deploy indexer to Railway/Render/Fly.io
- [ ] Deploy Next.js app to Vercel
- [ ] Provision Neon PostgreSQL
- [ ] Configure environment variables
- [ ] Configure daily cron jobs
- [ ] Run initial backfill to populate historical data
- [ ] Verify live ingestion is working

---

## Reference Files (from wallet-backend)

For implementation reference, see these files in the original Go project:

| File | Purpose |
|------|---------|
| `internal/indexer/processors/blend/blend_events_processor.go` | XDR parsing and event extraction logic |
| `internal/indexer/types/blend.go` | Data type definitions |
| `internal/data/blend_events.go` | Database operations |
| `internal/db/migrations/2025-12-15.0-blend_events.sql` | Database schema |
| `internal/services/ingest_backfill.go` | Parallel batch processing patterns |
| `internal/services/ingest_live.go` | Live ingestion patterns |
| `internal/ingest/ledger_backend.go` | S3 datastore configuration |
| `config/datastore-pubnet.toml` | S3 bucket configuration |
