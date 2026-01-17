# Goldsky Streaming Configuration Guide

This document provides the complete configuration specification for setting up Goldsky streaming to ingest real-time position and pool changes into your Blend Protocol backfill database.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Prerequisites](#prerequisites)
4. [Environment Setup](#environment-setup)
5. [Goldsky Pipeline Configuration](#goldsky-pipeline-configuration)
6. [Webhook Security](#webhook-security)
7. [Testing & Validation](#testing--validation)
8. [Monitoring & Operations](#monitoring--operations)
9. [Troubleshooting](#troubleshooting)

---

## Overview

### What This Does

Goldsky streaming complements your BigQuery backfill by providing:
- **Real-time updates**: Position and pool changes streamed within seconds of on-chain events
- **Continuous sync**: Automatically keeps your database up-to-date with new ledger entries
- **Cost optimization**: Reduces BigQuery query frequency by streaming incremental updates

### Data Flow

```
Stellar Blockchain
    ↓
Goldsky Stream (monitors contract events)
    ↓
HTTP Webhook → Your API (/api/goldsky/webhook)
    ↓
Webhook Handler (processes events)
    ↓
PostgreSQL Database (user_positions, pool_snapshots)
```

---

## Architecture

### Components

1. **Goldsky Pipeline**: Monitors Stellar blockchain for contract data changes
2. **Webhook Endpoint**: `/api/goldsky/webhook` receives events
3. **Webhook Handler**: Parses and processes events
4. **Reserve Mapping Cache**: In-memory cache for reserve index → asset mapping
5. **Database Repositories**: Insert position and pool data with deduplication

### Event Types

| Event Type | Description | Database Table | Deduplication Key |
|------------|-------------|----------------|-------------------|
| `Positions` | User position changes (supply, collateral, liabilities) | `user_positions` | `(pool_id, user_address, asset_address, ledger_sequence)` |
| `ResData` | Pool rate and supply updates | `pool_snapshots` | `(pool_id, asset_address, snapshot_date)` |
| `ResConfig` | Asset configuration (reserve index mapping) | In-memory cache | N/A |

---

## Prerequisites

### 1. Goldsky Account

- Sign up at [goldsky.com](https://goldsky.com)
- Request access to Stellar blockchain indexing
- Obtain API key for configuration

### 2. Deployed Backend

- Your API server must be publicly accessible
- HTTPS endpoint required for production
- Webhook endpoint: `https://your-domain.com/api/goldsky/webhook`

### 3. Environment Variables

Add to your `.env` file:

```bash
# Goldsky webhook authentication
GOLDSKY_WEBHOOK_SECRET=your_webhook_secret_here

# Server configuration (if not already set)
PORT=3000
NODE_ENV=production
```

**Generating a secure webhook secret:**

```bash
# Generate a random 32-byte secret
openssl rand -hex 32
```

---

## Environment Setup

### 1. Update `.env` File

```bash
# Copy example and edit
cp .env.example .env

# Add Goldsky configuration
echo "GOLDSKY_WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env
```

### 2. Install Dependencies (if needed)

No additional dependencies required - all webhook handling uses built-in Node.js modules.

### 3. Build and Deploy

```bash
# Build TypeScript
npm run build

# Start server
npm start

# Or for development
npm run dev
```

### 4. Verify Webhook Endpoint

```bash
# Check webhook status
curl http://localhost:3000/api/goldsky/status

# Expected response:
# {
#   "status": "operational",
#   "webhook_url": "/api/goldsky/webhook",
#   "authentication": "enabled",
#   "timestamp": "2025-01-22T..."
# }
```

---

## Goldsky Pipeline Configuration

### Step 1: Create Goldsky Pipeline

Log into Goldsky console and create a new pipeline with these settings:

**Pipeline Name:** `blend-protocol-positions`

**Blockchain:** Stellar (Mainnet)

**Event Source:** Contract Data Changes

### Step 2: Contract Filter Configuration

Configure the pipeline to monitor your Blend pool contracts:

```json
{
  "network": "stellar-mainnet",
  "contracts": [
    "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
    "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS"
  ],
  "event_types": [
    "contract_data"
  ],
  "filters": {
    "key_symbols": ["Positions", "ResData", "ResConfig"]
  }
}
```

**Explanation:**
- `contracts`: Your pool addresses (add all pools you want to monitor)
- `event_types`: Monitor contract data ledger entries
- `key_symbols`: Only send events for these contract data types

### Step 3: Webhook Configuration

In the Goldsky pipeline settings, configure the webhook destination:

**Webhook URL:** `https://your-domain.com/api/goldsky/webhook`

**Method:** `POST`

**Headers:**
```json
{
  "Content-Type": "application/json",
  "X-Goldsky-Signature": "${signature}"
}
```

**Signing Configuration:**
- **Algorithm:** `HMAC-SHA256`
- **Secret:** Use the `GOLDSKY_WEBHOOK_SECRET` from your `.env` file
- **Signature Format:** `sha256=<hex_digest>`

**Payload Format:**
```json
{
  "events": [...],
  "timestamp": "ISO-8601 timestamp",
  "network": "stellar-mainnet"
}
```

### Step 4: Event Payload Structure

Each event in the `events` array will have this structure:

```typescript
{
  "ledger_sequence": 12345678,
  "closed_at": "2025-01-22T10:30:00Z",
  "contract_id": "CAJJZSG...",  // Pool address
  "ledger_key_hash": "abc123...",
  "ledger_entry_change": 1,     // 0=created, 1=updated, 2=deleted
  "deleted": false,
  "key_decoded": {
    "vec": [
      { "symbol": "Positions" },
      { "address": "GD7X..." }  // User or asset address
    ]
  },
  "val_decoded": {
    "map": [
      // Decoded contract data value (structure varies by event type)
    ]
  }
}
```

### Step 5: Batching Configuration (Recommended)

Configure batching to optimize webhook delivery:

```json
{
  "batching": {
    "max_events": 100,           // Send up to 100 events per webhook
    "max_wait_seconds": 5,       // Or send after 5 seconds
    "max_retries": 3,            // Retry failed webhooks 3 times
    "retry_backoff": "exponential"
  }
}
```

### Step 6: Historical Backfill

**Important:** Configure the pipeline start point:

```json
{
  "start_from": {
    "type": "ledger_sequence",
    "value": 12345678  // Start from your last BigQuery backfill ledger
  }
}
```

**To find your last backfill ledger:**

```bash
# Query your database
psql $DATABASE_URL -c "SELECT MAX(ledger_sequence) FROM user_positions;"
```

**Alternative:** Start from a specific date:

```json
{
  "start_from": {
    "type": "timestamp",
    "value": "2025-01-22T00:00:00Z"
  }
}
```

---

## Webhook Security

### Signature Verification

Your webhook endpoint automatically verifies signatures using the `GOLDSKY_WEBHOOK_SECRET`. Here's how it works:

1. Goldsky signs the webhook payload with HMAC-SHA256
2. Signature is sent in `X-Goldsky-Signature` header
3. Your endpoint recomputes the signature and compares
4. Rejects requests with invalid signatures (401 Unauthorized)

**Signature Format:**
```
X-Goldsky-Signature: sha256=<hex_digest>
```

**Manual Verification (for testing):**

```bash
# Compute expected signature
echo -n '{"events":[...]}' | openssl dgst -sha256 -hmac "your_secret" | sed 's/^.* /sha256=/'
```

### Security Best Practices

1. **Keep Webhook Secret Safe**
   - Never commit to version control
   - Rotate periodically (update both `.env` and Goldsky config)
   - Use environment-specific secrets (dev/staging/prod)

2. **Network Security**
   - Use HTTPS in production (required)
   - Consider IP whitelisting for Goldsky's webhook source IPs
   - Rate limit the webhook endpoint if needed

3. **Monitoring**
   - Log all webhook requests (successful and failed)
   - Alert on repeated authentication failures
   - Monitor for unusual event volumes

---

## Testing & Validation

### 1. Test Endpoint Availability

```bash
# Check if webhook is accessible
curl -X POST https://your-domain.com/api/goldsky/webhook \
  -H "Content-Type: application/json" \
  -d '{"events":[],"timestamp":"2025-01-22T10:00:00Z","network":"stellar-mainnet"}'

# Should return 401 (missing/invalid signature) or 200 (if no secret configured)
```

### 2. Test with Sample Payload

Use the `/api/goldsky/test` endpoint (development only):

```bash
# Create test payload file
cat > test-webhook.json << 'EOF'
{
  "events": [
    {
      "ledger_sequence": 12345678,
      "closed_at": "2025-01-22T10:30:00Z",
      "contract_id": "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
      "ledger_key_hash": "test_hash_123",
      "ledger_entry_change": 1,
      "deleted": false,
      "key_decoded": {
        "vec": [
          { "symbol": "ResData" },
          { "address": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" }
        ]
      },
      "val_decoded": {
        "map": [
          { "key": { "u32": 0 }, "val": { "i128": "1050000000000" } },
          { "key": { "u32": 1 }, "val": { "i128": "10000000000000" } },
          { "key": { "u32": 3 }, "val": { "i128": "1100000000000" } },
          { "key": { "u32": 4 }, "val": { "i128": "5000000000000" } },
          { "key": { "u32": 6 }, "val": { "u64": "1705920600" } }
        ]
      }
    }
  ],
  "timestamp": "2025-01-22T10:30:00Z",
  "network": "stellar-mainnet"
}
EOF

# Send test webhook
curl -X POST http://localhost:3000/api/goldsky/test \
  -H "Content-Type: application/json" \
  -d @test-webhook.json
```

### 3. Verify Database Insertion

```sql
-- Check if test data was inserted
SELECT * FROM pool_snapshots
WHERE ledger_sequence = 12345678
ORDER BY snapshot_timestamp DESC
LIMIT 10;
```

### 4. Test Position Event

```bash
cat > test-position.json << 'EOF'
{
  "events": [
    {
      "ledger_sequence": 12345679,
      "closed_at": "2025-01-22T10:31:00Z",
      "contract_id": "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
      "ledger_key_hash": "test_pos_hash_456",
      "ledger_entry_change": 1,
      "deleted": false,
      "key_decoded": {
        "vec": [
          { "symbol": "Positions" },
          { "address": "GD7XNMKA7LHZ6RNPBHWH3MJBVMTQ5DDYJ3HQMEMGJ6MZW5RNQMGJ6MZW" }
        ]
      },
      "val_decoded": {
        "map": [
          {
            "key": { "u32": 0 },
            "val": {
              "map": [
                { "key": { "u32": 0 }, "val": { "i128": "5000000000" } }
              ]
            }
          },
          {
            "key": { "u32": 1 },
            "val": {
              "map": [
                { "key": { "u32": 0 }, "val": { "i128": "2000000000" } }
              ]
            }
          },
          {
            "key": { "u32": 2 },
            "val": {
              "map": [
                { "key": { "u32": 0 }, "val": { "i128": "10000000000" } }
              ]
            }
          }
        ]
      }
    }
  ],
  "timestamp": "2025-01-22T10:31:00Z",
  "network": "stellar-mainnet"
}
EOF

# Send test position webhook
curl -X POST http://localhost:3000/api/goldsky/test \
  -H "Content-Type: application/json" \
  -d @test-position.json
```

---

## Monitoring & Operations

### 1. Application Logs

Monitor your application logs for webhook activity:

```bash
# Follow logs
tail -f logs/app.log | grep GOLDSKY

# Or if using PM2
pm2 logs your-app --lines 100 | grep GOLDSKY
```

**Key log messages:**
- `📥 GOLDSKY WEBHOOK RECEIVED` - Webhook received
- `✓ Updated reserve mapping` - ResConfig processed
- `✓ Inserted X rows, updated Y rows` - Database operations
- `❌ Invalid webhook signature` - Authentication failure
- `⚠️ Failed to get rates` - Missing pool snapshot data

### 2. Database Monitoring

```sql
-- Check recent webhook ingestion
SELECT
  DATE(snapshot_timestamp) as date,
  COUNT(*) as events,
  COUNT(DISTINCT user_address) as unique_users
FROM user_positions
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY DATE(snapshot_timestamp)
ORDER BY date DESC;

-- Check pool snapshot updates
SELECT
  pool_id,
  asset_address,
  MAX(ledger_sequence) as latest_ledger,
  MAX(snapshot_timestamp) as latest_update
FROM pool_snapshots
GROUP BY pool_id, asset_address
ORDER BY latest_update DESC;
```

### 3. Health Checks

```bash
# Check webhook status
curl https://your-domain.com/api/goldsky/status

# Check database connection
curl https://your-domain.com/health
```

### 4. Alerting (Recommended)

Set up alerts for:
- Webhook endpoint downtime
- Repeated authentication failures (potential security issue)
- No events received for > 1 hour (pipeline issue)
- High error rate in event processing
- Database connection failures

**Example with Datadog/New Relic:**
```javascript
// Add to webhook handler
if (result.errors.length > 10) {
  alerting.send({
    level: 'warning',
    message: `High error rate in Goldsky webhook: ${result.errors.length} errors`,
    details: result.errors
  });
}
```

---

## Troubleshooting

### Problem: Webhook Returns 401 Unauthorized

**Symptoms:**
- Goldsky dashboard shows webhook failures
- Logs show "Invalid webhook signature"

**Solutions:**
1. Verify `GOLDSKY_WEBHOOK_SECRET` matches in both `.env` and Goldsky config
2. Check signature format in Goldsky (should be `sha256=<hex>`)
3. Ensure Goldsky is computing signature over raw request body
4. Test locally with `/api/goldsky/test` endpoint (no auth required)

### Problem: Position Events Fail with "No asset mapping found"

**Symptoms:**
- Logs show `No asset mapping found for pool ... reserve index X`
- Position events are skipped

**Solutions:**
1. Check if ResConfig events are being received:
   ```sql
   -- Verify pool snapshots exist for this pool/asset
   SELECT * FROM pool_snapshots WHERE pool_id = 'POOL_ID_HERE';
   ```
2. Ensure ResConfig events are included in Goldsky filter
3. Restart server to preload reserve mappings
4. Manually populate cache by running BigQuery backfill first

### Problem: Rates Missing on Position Events

**Symptoms:**
- Position rows have `b_rate` and `d_rate` as `NULL`
- Warning: `Failed to get rates for ... at ledger X`

**Solutions:**
1. Ensure ResData events are being processed before Positions
2. Run pool snapshot backfill to populate historical rates
3. Check ledger_sequence ordering (should process in ascending order)
4. Verify `pool_snapshots` table has data:
   ```sql
   SELECT COUNT(*) FROM pool_snapshots;
   ```

### Problem: Duplicate Events

**Symptoms:**
- Same ledger_sequence appears multiple times
- Database shows many "updated" instead of "inserted"

**Solutions:**
- This is expected behavior! The `UNIQUE` constraints handle deduplication
- Goldsky may replay events during recovery
- Updates are idempotent and safe
- No action needed

### Problem: Events Arriving Out of Order

**Symptoms:**
- Ledger sequences not in ascending order
- ResConfig arrives after Positions

**Solutions:**
- Webhook handler sorts events by `ledger_sequence` before processing
- ResConfig is processed first, then ResData, then Positions
- This is handled automatically - no action needed
- If issues persist, increase Goldsky batching delay to 10+ seconds

### Problem: High Memory Usage

**Symptoms:**
- Node.js process using excessive RAM
- `reserveMappingCache` growing large

**Solutions:**
1. Restart application to clear cache
2. Implement cache eviction policy (LRU)
3. Limit cache size to active pools only
4. Consider storing mapping in Redis for multi-instance deployments

---

## Advanced Configuration

### Multi-Pool Setup

To monitor many pools, use Goldsky's dynamic contract discovery:

```json
{
  "contract_discovery": {
    "enabled": true,
    "pattern": {
      "pool_factory": "FACTORY_ADDRESS_HERE",
      "event_type": "PoolCreated"
    }
  }
}
```

### Scaling for High Volume

For high-volume deployments:

1. **Increase Batching:**
   ```json
   {
     "batching": {
       "max_events": 500,
       "max_wait_seconds": 10
     }
   }
   ```

2. **Use Queue System:**
   - Add Redis queue between webhook and processing
   - Process events asynchronously
   - Prevents webhook timeout on large batches

3. **Database Connection Pooling:**
   - Already configured in `config/database.ts`
   - Increase pool size if needed: `max: 20`

### Monitoring Multiple Environments

Configure separate webhooks for dev/staging/prod:

```
Dev:     https://dev.your-domain.com/api/goldsky/webhook
Staging: https://staging.your-domain.com/api/goldsky/webhook
Prod:    https://your-domain.com/api/goldsky/webhook
```

Use different secrets for each environment.

---

## Summary Checklist

Before going live:

- [ ] Goldsky account created and Stellar access enabled
- [ ] `.env` file configured with `GOLDSKY_WEBHOOK_SECRET`
- [ ] Webhook endpoint deployed and publicly accessible (HTTPS)
- [ ] Goldsky pipeline created with correct contract filters
- [ ] Webhook URL configured in Goldsky with signature
- [ ] Test webhook successful with sample data
- [ ] Database tables populated with initial backfill
- [ ] Monitoring and alerting configured
- [ ] Logs verified showing successful event processing
- [ ] Reserve mapping cache populated (via ResConfig events)

---

## Support

For issues or questions:

1. **Goldsky Issues:** Contact Goldsky support or check their documentation
2. **Webhook Issues:** Check application logs and database
3. **Database Issues:** Verify PostgreSQL connection and table structure
4. **Development Questions:** Review code in `src/services/goldsky-webhook-handler.ts`

---

**Last Updated:** January 2025
**Version:** 1.0.0
