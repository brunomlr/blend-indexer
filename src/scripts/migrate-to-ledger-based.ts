import { pool, testConnection, closePool } from '../config/database';

/**
 * Migration: Switch from date-based to ledger-based unique constraints
 *
 * This migration updates the user_positions table to:
 * 1. Add entry_hash and ledger_entry_change columns
 * 2. Change unique constraint from (pool_id, user_address, asset_address, snapshot_date)
 *    to (pool_id, user_address, asset_address, ledger_sequence)
 *
 * This allows multiple position changes per day to be tracked separately.
 */

async function migrateToLedgerBased() {
  console.log('🚀 Starting migration to ledger-based tracking...\n');

  try {
    // Test connection
    console.log('1. Testing database connection...');
    const connected = await testConnection();
    if (!connected) {
      throw new Error('Failed to connect to database');
    }
    console.log('✓ Database connection successful\n');

    // Check if migration is needed
    console.log('2. Checking current schema...');
    const columnCheck = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'user_positions'
        AND column_name IN ('entry_hash', 'ledger_entry_change')
    `);

    if (columnCheck.rows.length === 2) {
      console.log('⚠️  Migration already applied. Skipping...\n');
      console.log('✅ Database is up to date!');
      return;
    }

    // Start transaction
    console.log('3. Starting migration transaction...');
    await pool.query('BEGIN');

    // Drop old unique constraint
    console.log('4. Dropping old date-based unique constraint...');
    await pool.query(`
      ALTER TABLE user_positions
      DROP CONSTRAINT IF EXISTS user_positions_pool_id_user_address_asset_address_snapshot_key;
    `);
    console.log('✓ Old constraint dropped');

    // Add new columns
    console.log('5. Adding entry_hash column...');
    await pool.query(`
      ALTER TABLE user_positions
      ADD COLUMN IF NOT EXISTS entry_hash VARCHAR(255);
    `);
    console.log('✓ entry_hash column added');

    console.log('6. Adding ledger_entry_change column...');
    await pool.query(`
      ALTER TABLE user_positions
      ADD COLUMN IF NOT EXISTS ledger_entry_change BIGINT;
    `);
    console.log('✓ ledger_entry_change column added');

    // Add new unique constraint based on ledger_sequence
    console.log('7. Adding new ledger-based unique constraint...');
    await pool.query(`
      ALTER TABLE user_positions
      ADD CONSTRAINT user_positions_ledger_unique
      UNIQUE (pool_id, user_address, asset_address, ledger_sequence);
    `);
    console.log('✓ New ledger-based constraint added');

    // Add index on ledger_sequence for performance
    console.log('8. Adding index on ledger_sequence...');
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_user_positions_ledger
        ON user_positions(ledger_sequence);
    `);
    console.log('✓ Index added');

    // Commit transaction
    await pool.query('COMMIT');
    console.log('9. Transaction committed\n');

    // Verify schema
    console.log('10. Verifying new schema...');
    const schemaCheck = await pool.query(`
      SELECT
        column_name,
        data_type,
        is_nullable
      FROM information_schema.columns
      WHERE table_name = 'user_positions'
        AND column_name IN ('entry_hash', 'ledger_entry_change', 'ledger_sequence')
      ORDER BY column_name;
    `);

    console.log('New columns:');
    schemaCheck.rows.forEach(row => {
      console.log(`  - ${row.column_name} (${row.data_type}, nullable: ${row.is_nullable})`);
    });

    // Check constraints
    const constraintCheck = await pool.query(`
      SELECT constraint_name
      FROM information_schema.table_constraints
      WHERE table_name = 'user_positions'
        AND constraint_type = 'UNIQUE';
    `);

    console.log('\nUnique constraints:');
    constraintCheck.rows.forEach(row => {
      console.log(`  - ${row.constraint_name}`);
    });

    console.log('\n✅ Migration completed successfully!');
    console.log('\n⚠️  IMPORTANT: You may want to clear existing data before running backfill:');
    console.log('  DELETE FROM user_positions;');
    console.log('\nNext steps:');
    console.log('  1. Clear old data (optional): DELETE FROM user_positions;');
    console.log('  2. Run: npm run backfill:users');
    console.log('  3. Verify data in the UI');

  } catch (error) {
    console.error('❌ Migration failed:', error);
    try {
      await pool.query('ROLLBACK');
      console.log('Transaction rolled back');
    } catch (rollbackError) {
      console.error('Rollback failed:', rollbackError);
    }
    process.exit(1);
  } finally {
    await closePool();
  }
}

// Run migration
migrateToLedgerBased();
