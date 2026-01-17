import { bigQueryBackfillService, BackfillOptions } from '../services/bigquery-backfill';
import { closePool } from '../config/database';

async function main() {
  try {
    // Parse command line arguments
    const args = process.argv.slice(2);

    // Check for help flag
    if (args.includes('--help') || args.includes('-h')) {
      printHelp();
      process.exit(0);
    }

    // Parse options
    const options: BackfillOptions = {};

    // Skip confirmation flag
    if (args.includes('--yes') || args.includes('-y')) {
      options.skipConfirmation = true;
    }

    // All-assets mode flag
    if (args.includes('--all-assets') || args.includes('-a')) {
      options.allAssets = true;
    }

    // User filter
    const userIndex = args.findIndex(arg => arg === '--user' || arg === '-u');
    if (userIndex !== -1 && args[userIndex + 1]) {
      options.targetUser = args[userIndex + 1];
    }

    // Days back (backward compatible)
    const daysIndex = args.findIndex(arg => arg === '--days' || arg === '-d');
    if (daysIndex !== -1 && args[daysIndex + 1]) {
      options.daysBack = parseInt(args[daysIndex + 1]);
    }

    // Start date
    const startDateIndex = args.findIndex(arg => arg === '--start-date' || arg === '--from');
    if (startDateIndex !== -1 && args[startDateIndex + 1]) {
      options.startDate = args[startDateIndex + 1];
    }

    // End date
    const endDateIndex = args.findIndex(arg => arg === '--end-date' || arg === '--to');
    if (endDateIndex !== -1 && args[endDateIndex + 1]) {
      options.endDate = args[endDateIndex + 1];
    }

    // Start ledger
    const startLedgerIndex = args.findIndex(arg => arg === '--start-ledger');
    if (startLedgerIndex !== -1 && args[startLedgerIndex + 1]) {
      options.startLedger = parseInt(args[startLedgerIndex + 1]);
    }

    // End ledger
    const endLedgerIndex = args.findIndex(arg => arg === '--end-ledger');
    if (endLedgerIndex !== -1 && args[endLedgerIndex + 1]) {
      options.endLedger = parseInt(args[endLedgerIndex + 1]);
    }

    // Validation
    if (options.startLedger && options.endLedger && options.startLedger > options.endLedger) {
      console.error('❌ Error: --start-ledger must be less than or equal to --end-ledger');
      process.exit(1);
    }

    if (options.startDate && options.endDate && options.startDate > options.endDate) {
      console.error('❌ Error: --start-date must be before or equal to --end-date');
      process.exit(1);
    }

    console.log('='.repeat(60));
    console.log('  USER POSITIONS BACKFILL - BIGQUERY');
    console.log('='.repeat(60));

    const result = await bigQueryBackfillService.runBackfillAll(options);

    if (!result.success) {
      console.error('\n❌ Backfill failed:', result.error);
      process.exit(1);
    }

    console.log('='.repeat(60));
    console.log('✅ BigQuery backfill complete!');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

function printHelp() {
  console.log(`
BigQuery Backfill Tool - Flexible Pool & Asset Configuration

USAGE:
  npm run backfill:bigquery [OPTIONS]

OPTIONS:
  -a, --all-assets             Fetch all assets per pool in a single query (more efficient)
  -u, --user <ADDRESS>         Optional: Filter for a specific user address
  -d, --days <NUMBER>          Number of days to backfill (default: 90)
  --start-date, --from <DATE>  Start date in YYYY-MM-DD format (overrides --days)
  --end-date, --to <DATE>      End date in YYYY-MM-DD format (default: today)
  --start-ledger <NUMBER>      Minimum ledger sequence to include
  --end-ledger <NUMBER>        Maximum ledger sequence to include
  -y, --yes                    Skip cost confirmation prompts (auto-approve)
  -h, --help                   Show this help message

DATE RANGE EXAMPLES:

  1. Last 90 days (default):
     npm run backfill:bigquery

  2. Last 30 days:
     npm run backfill:bigquery --days 30

  3. Specific date range:
     npm run backfill:bigquery --from 2024-01-01 --to 2024-12-31

  4. From specific date to today:
     npm run backfill:bigquery --from 2024-06-01

  5. Everything up to specific date (with lookback):
     npm run backfill:bigquery --to 2024-12-31 --days 90

USER FILTER EXAMPLES:

  6. Specific user, last 90 days:
     npm run backfill:bigquery --user GAZN4BIQPNPPS2PW2NKAWW6K37RLRV47BWTLJACRZXQJ4DVBA3IFQMRY

  7. Specific user, specific date range:
     npm run backfill:bigquery -u GAZN4BIQPNPPS2PW2NKAWW6K37RLRV47BWTLJACRZXQJ4DVBA3IFQMRY --from 2024-01-01 --to 2024-12-31

LEDGER RANGE EXAMPLES:

  8. Specific ledger range:
     npm run backfill:bigquery --start-ledger 1000000 --end-ledger 2000000

  9. From specific ledger to latest:
     npm run backfill:bigquery --start-ledger 1500000

  10. Combine date and ledger filters:
      npm run backfill:bigquery --from 2024-01-01 --start-ledger 1000000

INCREMENTAL BACKFILL:

  11. Daily incremental (run as cron job):
      npm run backfill:bigquery --days 2

  12. Backfill from last known ledger:
      npm run backfill:bigquery --start-ledger 1234567

ALL-ASSETS MODE (OPTIMIZED):

  13. Fetch all assets per pool in single queries (recommended):
      npm run backfill:bigquery --all-assets

  14. All-assets mode with auto-approve:
      npm run backfill:bigquery --all-assets --yes

  15. All-assets mode for specific date range:
      npm run backfill:bigquery --all-assets --from 2024-01-01 --to 2024-12-31

  Note: --all-assets mode is more efficient as it runs one query per pool
  instead of one query per asset, reducing API calls and potential costs.

CONFIGURATION:

  Pools and assets are configured in:
  src/config/bigquery-config.ts

  Edit this file to add/remove pools and assets to backfill.

NOTES:

  - Date ranges are inclusive
  - Ledger ranges are inclusive
  - Date and ledger filters can be combined
  - --start-date and --end-date override --days
  - Each pool-asset combination runs as a separate BigQuery query
  - Cost estimates are shown before running each query
  - Results are automatically inserted into PostgreSQL with upsert logic

COST ESTIMATES:

  - First 1TB per month is free
  - After that: $5 per TB
  - Typical query: 5-50 GB (~$0.025-$0.25)
  - Total cost depends on:
    * Number of pool-asset combinations
    * Date range (longer = more data)
    * Ledger range (more ledgers = more data)
    * User filter (one user = less data)
  `);
}

main();
