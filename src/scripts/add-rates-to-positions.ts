import { pool, testConnection, closePool } from '../config/database';

/**
 * Migration: Add b_rate and d_rate columns to user_positions table
 * This allows storing rates alongside position data for faster queries
 */

const ADD_RATE_COLUMNS = `
ALTER TABLE user_positions
ADD COLUMN IF NOT EXISTS b_rate NUMERIC(20, 12),
ADD COLUMN IF NOT EXISTS d_rate NUMERIC(20, 12);
`;

async function migrate() {
  console.log('🚀 Starting migration: Add b_rate and d_rate to user_positions...\n');

  try {
    // Test connection
    console.log('1. Testing database connection...');
    const connected = await testConnection();
    if (!connected) {
      throw new Error('Failed to connect to database');
    }
    console.log('✓ Database connection successful\n');

    // Add columns
    console.log('2. Adding b_rate and d_rate columns to user_positions...');
    await pool.query(ADD_RATE_COLUMNS);
    console.log('✓ Columns added successfully\n');

    // Verify columns exist
    console.log('3. Verifying columns...');
    const columnsResult = await pool.query(`
      SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_positions'
        AND column_name IN ('b_rate', 'd_rate')
      ORDER BY column_name;
    `);

    if (columnsResult.rows.length === 2) {
      console.log('✓ Columns verified:');
      columnsResult.rows.forEach(row => {
        console.log(`  - ${row.column_name}: ${row.data_type}(${row.numeric_precision}, ${row.numeric_scale})`);
      });
    } else {
      throw new Error('Column verification failed - expected 2 columns');
    }

    console.log('\n✅ Migration completed successfully!');
    console.log('\nNext steps:');
    console.log('  1. Rebuild TypeScript: npm run build');
    console.log('  2. Re-run backfill to populate rates: npm run backfill:bigquery');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

// Run migration
migrate();
