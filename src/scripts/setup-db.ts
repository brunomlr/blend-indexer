import { pool, testConnection, closePool } from '../config/database';

const CREATE_POOL_SNAPSHOTS_TABLE = `
CREATE TABLE IF NOT EXISTS pool_snapshots (
  id SERIAL PRIMARY KEY,
  pool_id VARCHAR(56) NOT NULL,
  asset_address VARCHAR(56) NOT NULL,
  snapshot_date DATE NOT NULL,
  snapshot_timestamp TIMESTAMP NOT NULL,
  ledger_sequence BIGINT NOT NULL,
  b_rate NUMERIC(20, 12) NOT NULL,
  d_rate NUMERIC(20, 12) NOT NULL,
  b_supply NUMERIC(20, 7),
  d_supply NUMERIC(20, 7),
  last_time BIGINT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(pool_id, asset_address, snapshot_date)
);
`;

const CREATE_POOL_SNAPSHOTS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_pool_snapshots_lookup
  ON pool_snapshots(pool_id, asset_address, snapshot_date);
`;

async function setupDatabase() {
  console.log('🚀 Starting database setup...\n');

  try {
    // Test connection
    console.log('1. Testing database connection...');
    const connected = await testConnection();
    if (!connected) {
      throw new Error('Failed to connect to database');
    }
    console.log('✓ Database connection successful\n');

    // Create pool_snapshots table
    console.log('2. Creating pool_snapshots table...');
    await pool.query(CREATE_POOL_SNAPSHOTS_TABLE);
    console.log('✓ pool_snapshots table created');

    console.log('3. Creating pool_snapshots index...');
    await pool.query(CREATE_POOL_SNAPSHOTS_INDEX);
    console.log('✓ pool_snapshots index created\n');

    // Verify tables exist
    console.log('4. Verifying tables...');
    const tablesResult = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'pool_snapshots'
      ORDER BY table_name;
    `);

    console.log('Tables found:');
    tablesResult.rows.forEach(row => {
      console.log(`  - ${row.table_name}`);
    });

    console.log('\n✅ Database setup completed successfully!');
    console.log('\nNext steps:');
    console.log('  1. Run: npm run backfill:pool');
    console.log('  2. Run: npm run dev');

  } catch (error) {
    console.error('❌ Database setup failed:', error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

// Run setup
setupDatabase();
