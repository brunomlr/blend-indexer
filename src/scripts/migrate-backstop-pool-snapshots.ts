/**
 * Migration: Create backstop_pool_snapshots table
 *
 * This table stores historical daily snapshots of backstop pool balance data:
 * - shares: Total backstop shares
 * - tokens: Total LP tokens deposited
 * - q4w: Shares queued for withdrawal
 * - q4w_pct: (q4w / shares) * 100
 *
 * Usage:
 *   npx ts-node src/scripts/migrate-backstop-pool-snapshots.ts
 */

import { pool, testConnection, closePool } from '../config/database';

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS backstop_pool_snapshots (
  id SERIAL PRIMARY KEY,
  pool_address VARCHAR(56) NOT NULL,
  snapshot_date DATE NOT NULL,
  snapshot_timestamp TIMESTAMP NOT NULL,
  ledger_sequence BIGINT NOT NULL,
  shares NUMERIC(38, 0) NOT NULL,
  tokens NUMERIC(38, 0) NOT NULL,
  q4w NUMERIC(38, 0) NOT NULL,
  q4w_pct NUMERIC(10, 4),
  src VARCHAR(10) DEFAULT 'bq',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(pool_address, snapshot_date)
);
`;

const CREATE_INDEX_LOOKUP = `
CREATE INDEX IF NOT EXISTS idx_backstop_pool_snapshots_lookup
  ON backstop_pool_snapshots(pool_address, snapshot_date);
`;

const CREATE_INDEX_DATE = `
CREATE INDEX IF NOT EXISTS idx_backstop_pool_snapshots_date
  ON backstop_pool_snapshots(snapshot_date DESC);
`;

async function migrate() {
  console.log('═'.repeat(60));
  console.log('  Migration: backstop_pool_snapshots table');
  console.log('═'.repeat(60));

  try {
    // Test connection
    console.log('\n1. Testing database connection...');
    const connected = await testConnection();
    if (!connected) {
      throw new Error('Failed to connect to database');
    }
    console.log('   ✓ Connected');

    // Check if table exists
    console.log('\n2. Checking if table exists...');
    const checkResult = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'backstop_pool_snapshots'
      );
    `);
    const tableExists = checkResult.rows[0].exists;

    if (tableExists) {
      console.log('   ⚠️  Table already exists');

      // Show current stats
      const statsResult = await pool.query(`
        SELECT
          COUNT(*) as total_rows,
          COUNT(DISTINCT pool_address) as unique_pools,
          MIN(snapshot_date)::text as earliest_date,
          MAX(snapshot_date)::text as latest_date
        FROM backstop_pool_snapshots
      `);
      const stats = statsResult.rows[0];
      console.log(`   Current data: ${stats.total_rows} rows, ${stats.unique_pools} pools`);
      console.log(`   Date range: ${stats.earliest_date || 'N/A'} to ${stats.latest_date || 'N/A'}`);
    } else {
      // Create table
      console.log('\n3. Creating table...');
      await pool.query(CREATE_TABLE);
      console.log('   ✓ Table created');

      // Create indexes
      console.log('\n4. Creating indexes...');
      await pool.query(CREATE_INDEX_LOOKUP);
      console.log('   ✓ Lookup index created');
      await pool.query(CREATE_INDEX_DATE);
      console.log('   ✓ Date index created');
    }

    // Verify table structure
    console.log('\n5. Verifying table structure...');
    const columnsResult = await pool.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'backstop_pool_snapshots'
      ORDER BY ordinal_position
    `);

    console.log('   Columns:');
    columnsResult.rows.forEach(col => {
      console.log(`     - ${col.column_name}: ${col.data_type} (${col.is_nullable === 'YES' ? 'nullable' : 'not null'})`);
    });

    console.log('\n' + '═'.repeat(60));
    console.log('  ✅ Migration completed successfully');
    console.log('═'.repeat(60));
    console.log('\nNext steps:');
    console.log('  npm run backfill:backstop-q4w -- --dry-run   # Preview data');
    console.log('  npm run backfill:backstop-q4w -- --yes       # Run backfill');
    console.log('');

  } catch (error) {
    console.error('\n❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

migrate();
