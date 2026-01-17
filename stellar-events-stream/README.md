# Blend Protocol Events Stream

Goldsky-powered Blend Protocol action events streaming to Neon PostgreSQL with derived rates and calculated positions.

## Tracked Pools

| Pool | Address | Version |
|------|---------|---------|
| Blend Pool | `CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD` | V2 |
| YieldBlox | `CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS` | V1 |

## How It Works

Goldsky streams **action events** (supply, withdraw, borrow, repay, claim) from Blend pools. Each event contains:
- Amount in underlying tokens
- Amount in b-tokens (or d-tokens)

From this, we **derive rates** and **calculate positions**:

```
Event: supply 100 USDC → receive 96.8 b-USDC
       ↓
Derived b_rate = 100 / 96.8 = 1.033
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Blend Pools    │────▶│    Goldsky      │────▶│    Neon DB      │
│  (Stellar)      │     │   (Pipeline)    │     │   blend_actions │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
                                                        ▼
                                              ┌─────────────────────┐
                                              │   SQL Views         │
                                              │  - v_user_positions │
                                              │  - v_derived_rates  │
                                              │  - v_daily_rates    │
                                              │  - v_user_claims    │
                                              └─────────────────────┘
```

## Action Types Captured

| Action | Description | Derived Rate |
|--------|-------------|--------------|
| `supply` | User deposits to earn yield | b_rate |
| `withdraw` | User withdraws supply | b_rate |
| `supply_collateral` | User adds collateral | b_rate |
| `withdraw_collateral` | User removes collateral | b_rate |
| `borrow` | User borrows against collateral | d_rate |
| `repay` | User repays debt | d_rate |
| `claim` | User claims emissions/rewards | - (no rate) |

## Quick Start

```bash
# 1. Install Goldsky CLI
curl https://goldsky.com | sh
goldsky login

# 2. Create Neon PostgreSQL secret
goldsky secret create --name NEON_POSTGRES_SECRET --value '{
  "type": "jdbc",
  "protocol": "postgresql",
  "host": "ep-xxx.us-east-2.aws.neon.tech",
  "port": 5432,
  "databaseName": "neondb",
  "user": "your-user",
  "password": "your-password"
}'

# 3. Run database migrations
cp .env.example .env
# Edit .env with your DATABASE_URL
npm install
npm run db:migrate

# 4. Deploy the pipeline
goldsky pipeline apply goldsky/pipeline-blend-actions.yaml
goldsky pipeline start blend-actions

# 5. Monitor
goldsky pipeline monitor blend-actions
```

## Database Schema

### blend_actions (main table)
Stores all user actions from Blend pools.

```sql
CREATE TABLE blend_actions (
  id TEXT PRIMARY KEY,
  pool_id VARCHAR(56) NOT NULL,
  transaction_hash TEXT NOT NULL,
  ledger_sequence BIGINT NOT NULL,
  ledger_closed_at BIGINT NOT NULL,
  action_type VARCHAR(30) NOT NULL,
  asset_address VARCHAR(56),      -- Token address (NULL for some claims)
  user_address VARCHAR(56),       -- User address
  amount_underlying TEXT,         -- Raw tokens (or claim amount)
  amount_tokens TEXT              -- b-tokens or d-tokens (NULL for claims)
);
```

## SQL Views

### v_user_positions
Current user positions calculated from action history.

```sql
SELECT * FROM v_user_positions WHERE user_address = 'GXXX...';
```

Returns:
- `supply_btokens` - Net supply balance
- `collateral_btokens` - Net collateral balance
- `debt_dtokens` - Net debt balance
- `action_count` - Total actions
- `last_action_time` - Most recent activity

### v_derived_rates
Rates derived from each action event.

```sql
SELECT * FROM v_derived_rates
WHERE asset_address = 'CCW67...'
ORDER BY ledger_sequence DESC;
```

Returns:
- `implied_rate` - The b_rate or d_rate at time of action
- `rate_type` - Either 'b_rate' or 'd_rate'
- `event_time` - When the action occurred

### v_latest_rates
Most recent rate per asset.

```sql
SELECT * FROM v_latest_rates;
```

### v_daily_rates
Daily rate statistics (avg, min, max).

```sql
SELECT * FROM v_daily_rates
WHERE snapshot_date >= CURRENT_DATE - INTERVAL '7 days';
```

### v_user_claims
Individual claim events (emissions/rewards).

```sql
SELECT * FROM v_user_claims WHERE user_address = 'GXXX...';
```

Returns:
- `claim_amount` - Amount claimed
- `claim_time` - When the claim occurred
- `asset_address` - Token claimed (may be NULL)

### v_user_total_claims
Aggregated claims per user.

```sql
SELECT * FROM v_user_total_claims WHERE user_address = 'GXXX...';
```

Returns:
- `total_claimed` - Sum of all claims
- `claim_count` - Number of claims
- `first_claim` / `last_claim` - Time range

## Example Queries

### Get all positions for a user
```sql
SELECT * FROM v_user_positions
WHERE user_address = 'GXXX...';
```

### Get current rates
```sql
SELECT * FROM v_latest_rates
WHERE pool_id = 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD';
```

### Get rate history for an asset
```sql
SELECT
  DATE(event_time) AS date,
  AVG(implied_rate) AS avg_rate
FROM v_derived_rates
WHERE asset_address = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
  AND rate_type = 'b_rate'
GROUP BY DATE(event_time)
ORDER BY date DESC;
```

### Get user's action history
```sql
SELECT
  action_type,
  asset_address,
  amount_underlying,
  amount_tokens,
  TO_TIMESTAMP(ledger_closed_at / 1000) AS time
FROM blend_actions
WHERE user_address = 'GXXX...'
ORDER BY ledger_sequence DESC
LIMIT 50;
```

## Pipeline Files

| File | Description |
|------|-------------|
| `goldsky/pipeline-blend-actions.yaml` | **Main pipeline** - Actions with parsed fields |
| `goldsky/pipeline-postgres.yaml` | Raw events (no parsing) |
| `goldsky/pipeline-webhook.yaml` | Webhook mode (requires server) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Neon PostgreSQL connection string |

## Backfill Options

Full history (recommended for position calculation):
```yaml
start_at: earliest
```

Latest only (real-time streaming):
```yaml
start_at: latest
```

From specific ledger:
```yaml
start_at: 58000000
```

## Notes

- Rates are **derived from events**, so you only get rate samples when users interact
- For assets with low activity, rate samples may be sparse
- Positions are calculated by aggregating all historical actions
- Use `start_at: earliest` to ensure accurate position calculation
