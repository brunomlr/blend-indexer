# BigQuery Integration Setup Guide

Complete guide for backfilling user positions data with flexible pool, asset, date, and ledger configuration.

## Features

✅ **Multi-pool support** - Configure unlimited pools
✅ **Multi-asset support** - Each pool can have multiple assets
✅ **Flexible date ranges** - Days back, specific dates, or date ranges
✅ **Ledger filtering** - Filter by ledger sequence numbers
✅ **User filtering** - All users or specific user
✅ **Cost estimates** - See query costs before running
✅ **Handles 142k+ rows** - No pagination needed

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure pools/assets (edit src/config/bigquery-config.ts)

# 3. Authenticate
gcloud auth application-default login

# 4. Run backfill
npm run backfill:bigquery
```

---

## Step 1: Install Dependencies

```bash
cd backfill_backend
npm install
```

---

## Step 2: Configure Pools and Assets

Edit `src/config/bigquery-config.ts`:

```typescript
export const POOL_ASSET_CONFIG: PoolAssetConfig[] = [
  {
    poolId: 'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
    poolName: 'Main Pool',
    assets: [
      {
        address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
        name: 'USDC',
        reserveIndex: 0, // Position in pool's reserves array
      },
      // Add more assets
    ],
  },
  // Add more pools
];
```

**Reserve Index**: The position of the asset in the pool's reserves array (0-indexed).

---

## Step 3: Authenticate with Google Cloud

### Option A: User Account (Testing)

```bash
gcloud auth application-default login
```

### Option B: Service Account (Production)

1. Create service account at https://console.cloud.google.com/iam-admin/serviceaccounts
2. Add roles: "BigQuery Job User" and "BigQuery Data Viewer"
3. Create JSON key
4. Add to `.env`:

```bash
GOOGLE_CLOUD_PROJECT=your-project-id
GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
```

---

## Step 4: Run Backfill

### Basic Usage

```bash
npm run backfill:bigquery [OPTIONS]
```

### Date Range Examples

```bash
# Last 90 days (default)
npm run backfill:bigquery

# Last 30 days
npm run backfill:bigquery --days 30

# Specific date range
npm run backfill:bigquery --from 2024-01-01 --to 2024-12-31

# From date to today
npm run backfill:bigquery --from 2024-06-01

# Up to specific date
npm run backfill:bigquery --to 2024-12-31
```

### User Filter Examples

```bash
# Specific user, 90 days
npm run backfill:bigquery --user GAZN4BIQPNPPS2PW2NKAWW6K37RLRV47BWTLJACRZXQJ4DVBA3IFQMRY

# Specific user, date range
npm run backfill:bigquery -u GAZN4... --from 2024-01-01 --to 2024-12-31
```

### Ledger Range Examples

```bash
# Specific ledger range
npm run backfill:bigquery --start-ledger 1000000 --end-ledger 2000000

# From ledger to latest
npm run backfill:bigquery --start-ledger 1500000

# Combine date and ledger
npm run backfill:bigquery --from 2024-01-01 --start-ledger 1000000
```

### Incremental Backfill

```bash
# Daily incremental (2 days for overlap)
npm run backfill:bigquery --days 2

# From last known ledger
npm run backfill:bigquery --start-ledger 1234567
```

### Get Help

```bash
npm run backfill:bigquery --help
```

---

## Command Line Options

| Option | Short | Description | Example |
|--------|-------|-------------|---------|
| `--user` | `-u` | Filter for specific user | `--user GAZN4...` |
| `--days` | `-d` | Days to backfill (default 90) | `--days 30` |
| `--start-date` | `--from` | Start date (YYYY-MM-DD) | `--from 2024-01-01` |
| `--end-date` | `--to` | End date (YYYY-MM-DD) | `--to 2024-12-31` |
| `--start-ledger` | | Minimum ledger sequence | `--start-ledger 1000000` |
| `--end-ledger` | | Maximum ledger sequence | `--end-ledger 2000000` |
| `--help` | `-h` | Show help message | `--help` |

**Notes:**
- `--start-date` and `--end-date` override `--days`
- All ranges are inclusive
- Date and ledger filters can be combined

---

## Understanding Costs

### Pricing
- **First 1TB/month**: FREE
- **After 1TB**: $5 per TB
- **Typical query**: 5-50 GB (~$0.025-$0.25)

### Cost Factors
- Number of pool-asset combinations
- Date range (longer = more data)
- Ledger range (more ledgers = more data)
- User filter (single user = less data)

### Example Costs

| Scenario | Data | Cost |
|----------|------|------|
| 1 pool, 1 asset, 90 days, all users | ~50 GB | ~$0.25 |
| 1 pool, 1 asset, 90 days, 1 user | ~5 GB | ~$0.025 |
| 2 pools, 3 assets each, 30 days | ~100 GB | ~$0.50 |
| Ledger range (1M ledgers) | ~20 GB | ~$0.10 |

---

## Configuration Details

### Pool-Asset Structure

```typescript
interface PoolAssetConfig {
  poolId: string;          // Contract address
  poolName: string;        // Display name
  assets: {
    address: string;       // Asset contract address
    name: string;          // Display name
    reserveIndex: number;  // Position in reserves (0, 1, 2...)
  }[];
}
```

### Multiple Pools Example

```typescript
export const POOL_ASSET_CONFIG: PoolAssetConfig[] = [
  {
    poolId: 'POOL_1',
    poolName: 'USDC Pool',
    assets: [
      { address: 'USDC_ADDR', name: 'USDC', reserveIndex: 0 },
    ],
  },
  {
    poolId: 'POOL_2',
    poolName: 'Multi-Asset Pool',
    assets: [
      { address: 'USDC_ADDR', name: 'USDC', reserveIndex: 0 },
      { address: 'XLM_ADDR', name: 'XLM', reserveIndex: 1 },
      { address: 'BTC_ADDR', name: 'BTC', reserveIndex: 2 },
    ],
  },
];
```

This runs **4 queries** total (1 + 3 assets).

---

## Verify Data

```sql
-- Total rows
SELECT COUNT(*) FROM user_positions;

-- Rows per pool-asset
SELECT pool_id, asset_address, COUNT(*)
FROM user_positions
GROUP BY pool_id, asset_address;

-- Date range coverage
SELECT MIN(snapshot_date), MAX(snapshot_date)
FROM user_positions;

-- Ledger range coverage
SELECT MIN(ledger_sequence), MAX(ledger_sequence)
FROM user_positions;

-- Latest positions for user
SELECT snapshot_date, ledger_sequence,
       supply_btokens, collateral_btokens, liabilities_dtokens
FROM user_positions
WHERE user_address = 'YOUR_ADDRESS'
ORDER BY ledger_sequence DESC
LIMIT 10;
```

---

## Troubleshooting

### "Permission denied"
```bash
gcloud auth application-default login
```

### "Table not found"
```bash
bq show crypto-stellar:crypto_stellar.contract_data
```

### "Invalid reserve index"
- Verify `reserveIndex` matches pool structure
- Check pool contract data for asset positions

### No data returned
- Verify pool ID and asset address
- Check date/ledger ranges have data
- Increase range or remove filters

### Date validation error
- Ensure dates are YYYY-MM-DD format
- Check start date is before end date

### Ledger validation error
- Ensure start ledger < end ledger
- Check ledger numbers are valid integers

---

## Use Cases

### Initial Historical Backfill
```bash
npm run backfill:bigquery --from 2024-01-01
```

### Daily Incremental Updates
```bash
# Run daily via cron
npm run backfill:bigquery --days 2
```

### Backfill Specific User
```bash
npm run backfill:bigquery --user <ADDRESS> --from 2024-01-01
```

### Backfill Specific Time Period
```bash
npm run backfill:bigquery --from 2024-06-01 --to 2024-06-30
```

### Catch Up from Last Known Ledger
```bash
# Query DB for max ledger, then:
npm run backfill:bigquery --start-ledger <MAX_LEDGER>
```

### Backfill Missing Ledger Range
```bash
npm run backfill:bigquery --start-ledger 1000000 --end-ledger 1500000
```

---

## Files Reference

- `src/config/bigquery-config.ts` - Pool/asset configuration
- `src/services/bigquery-client.ts` - BigQuery API client
- `src/services/bigquery-backfill.ts` - Backfill orchestration
- `src/scripts/run-bigquery-backfill.ts` - CLI script
- `context/bigqueryqueries/bigquery_single_user_backfill.sql` - SQL reference

---

## Quick Reference

```bash
# Configure
# Edit: src/config/bigquery-config.ts

# Authenticate
gcloud auth application-default login

# Run (various examples)
npm run backfill:bigquery                           # Default (90 days)
npm run backfill:bigquery --days 30                 # Last 30 days
npm run backfill:bigquery --from 2024-01-01         # From date
npm run backfill:bigquery --user <ADDR>             # Specific user
npm run backfill:bigquery --start-ledger 1000000    # From ledger
npm run backfill:bigquery --help                    # Help
```
