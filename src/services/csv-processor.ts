import { parse } from 'csv-parse/sync';
import { BlendActionRow, actionsRepository } from '../repositories/actions-repository';
import { BackstopEventRow, backstopRepository } from '../repositories/backstop-repository';

// Type for parsed CSV rows
type CsvRow = Record<string, string>;

/**
 * Expected columns for Blend Actions CSV
 */
const ACTIONS_COLUMNS = [
  'id',
  'pool_id',
  'transaction_hash',
  'ledger_sequence',
  'ledger_closed_at',
  'action_type',
  'asset_address',
  'user_address',
  'amount_underlying',
  'amount_tokens',
  'implied_rate',
  'auction_type',
  'filler_address',
  'liquidation_percent',
  'bid_asset',
  'bid_amount',
  'lot_asset',
  'lot_amount',
];

/**
 * Expected columns for Backstop Events CSV
 */
const BACKSTOP_COLUMNS = [
  'id',
  'transaction_hash',
  'ledger_sequence',
  'ledger_closed_at',
  'action_type',
  'pool_address',
  'user_address',
  'lp_tokens',
  'shares',
  'q4w_exp',
];

export interface CsvProcessResult {
  success: boolean;
  rows_fetched: number;
  rows_inserted: number;
  rows_updated: number;
  error?: string;
}

/**
 * Process a CSV file containing Blend Actions data
 */
export async function processActionsCsv(csvContent: string): Promise<CsvProcessResult> {
  try {
    console.log('\n📄 Processing Blend Actions CSV...');

    // Parse CSV
    const records: CsvRow[] = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      cast: false, // Keep as strings, we'll handle conversion
    });

    console.log(`✓ Parsed ${records.length} rows from CSV`);

    if (records.length === 0) {
      return {
        success: true,
        rows_fetched: 0,
        rows_inserted: 0,
        rows_updated: 0,
      };
    }

    // Validate columns
    const firstRow = records[0];
    const missingColumns = ACTIONS_COLUMNS.filter(col =>
      !Object.keys(firstRow).some(k => k.toLowerCase() === col.toLowerCase())
    );

    if (missingColumns.length > 0) {
      // Only require essential columns
      const essentialColumns = ['id', 'pool_id', 'action_type', 'ledger_sequence'];
      const missingEssential = essentialColumns.filter(col =>
        !Object.keys(firstRow).some(k => k.toLowerCase() === col.toLowerCase())
      );

      if (missingEssential.length > 0) {
        return {
          success: false,
          rows_fetched: records.length,
          rows_inserted: 0,
          rows_updated: 0,
          error: `Missing required columns: ${missingEssential.join(', ')}`,
        };
      }

      console.log(`⚠️  Optional columns not found: ${missingColumns.join(', ')}`);
    }

    // Transform rows to BlendActionRow format
    const validRows: BlendActionRow[] = [];
    const errors: string[] = [];

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      try {
        // Normalize column names to lowercase
        const normalizedRow: Record<string, string> = {};
        for (const key of Object.keys(row)) {
          normalizedRow[key.toLowerCase()] = row[key];
        }

        // Basic validation
        if (!normalizedRow.id || !normalizedRow.pool_id || !normalizedRow.action_type) {
          errors.push(`Row ${i + 1}: Missing required fields (id, pool_id, or action_type)`);
          continue;
        }

        const transformedRow: BlendActionRow = {
          id: normalizedRow.id,
          pool_id: normalizedRow.pool_id,
          transaction_hash: normalizedRow.transaction_hash || '',
          ledger_sequence: parseInt(normalizedRow.ledger_sequence) || 0,
          ledger_closed_at: normalizedRow.ledger_closed_at || new Date().toISOString(),
          action_type: normalizedRow.action_type,
          asset_address: normalizedRow.asset_address || null,
          user_address: normalizedRow.user_address || null,
          amount_underlying: normalizedRow.amount_underlying || null,
          amount_tokens: normalizedRow.amount_tokens || null,
          implied_rate: normalizedRow.implied_rate || null,
          auction_type: normalizedRow.auction_type || null,
          filler_address: normalizedRow.filler_address || null,
          liquidation_percent: normalizedRow.liquidation_percent || null,
          bid_asset: normalizedRow.bid_asset || null,
          bid_amount: normalizedRow.bid_amount || null,
          lot_asset: normalizedRow.lot_asset || null,
          lot_amount: normalizedRow.lot_amount || null,
          src: 'csv',
        };

        validRows.push(transformedRow);

      } catch (error) {
        errors.push(`Row ${i + 1}: Transform error - ${error}`);
      }
    }

    if (errors.length > 0 && errors.length <= 5) {
      console.log(`⚠️  Validation warnings: ${errors.length} rows skipped`);
      errors.forEach(err => console.log(`   - ${err}`));
    } else if (errors.length > 5) {
      console.log(`⚠️  Validation warnings: ${errors.length} rows skipped (showing first 5)`);
      errors.slice(0, 5).forEach(err => console.log(`   - ${err}`));
    }

    console.log(`✓ ${validRows.length} valid rows ready for insertion`);

    if (validRows.length === 0) {
      return {
        success: false,
        rows_fetched: records.length,
        rows_inserted: 0,
        rows_updated: 0,
        error: 'No valid rows after transformation',
      };
    }

    // Insert into database
    console.log('Inserting into database...');
    const result = await actionsRepository.insertBatch(validRows);
    console.log(`✓ Inserted ${result.inserted} rows, updated ${result.updated} rows`);

    return {
      success: true,
      rows_fetched: records.length,
      rows_inserted: result.inserted,
      rows_updated: result.updated,
    };

  } catch (error) {
    console.error('❌ CSV processing failed:', error);
    return {
      success: false,
      rows_fetched: 0,
      rows_inserted: 0,
      rows_updated: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Process a CSV file containing Backstop Events data
 */
export async function processBackstopCsv(csvContent: string): Promise<CsvProcessResult> {
  try {
    console.log('\n📄 Processing Backstop Events CSV...');

    // Parse CSV
    const records: CsvRow[] = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      cast: false,
    });

    console.log(`✓ Parsed ${records.length} rows from CSV`);

    if (records.length === 0) {
      return {
        success: true,
        rows_fetched: 0,
        rows_inserted: 0,
        rows_updated: 0,
      };
    }

    // Validate columns
    const firstRow = records[0];
    const essentialColumns = ['id', 'action_type', 'ledger_sequence'];
    const missingEssential = essentialColumns.filter(col =>
      !Object.keys(firstRow).some(k => k.toLowerCase() === col.toLowerCase())
    );

    if (missingEssential.length > 0) {
      return {
        success: false,
        rows_fetched: records.length,
        rows_inserted: 0,
        rows_updated: 0,
        error: `Missing required columns: ${missingEssential.join(', ')}`,
      };
    }

    // Transform rows to BackstopEventRow format
    const validRows: BackstopEventRow[] = [];
    const errors: string[] = [];

    for (let i = 0; i < records.length; i++) {
      const row = records[i];
      try {
        // Normalize column names to lowercase
        const normalizedRow: Record<string, string> = {};
        for (const key of Object.keys(row)) {
          normalizedRow[key.toLowerCase()] = row[key];
        }

        // Basic validation
        if (!normalizedRow.id || !normalizedRow.action_type) {
          errors.push(`Row ${i + 1}: Missing required fields (id or action_type)`);
          continue;
        }

        const transformedRow: BackstopEventRow = {
          id: normalizedRow.id,
          transaction_hash: normalizedRow.transaction_hash || '',
          ledger_sequence: parseInt(normalizedRow.ledger_sequence) || 0,
          ledger_closed_at: normalizedRow.ledger_closed_at || new Date().toISOString(),
          action_type: normalizedRow.action_type,
          pool_address: normalizedRow.pool_address || null,
          user_address: normalizedRow.user_address || null,
          lp_tokens: normalizedRow.lp_tokens || null,
          shares: normalizedRow.shares || null,
          q4w_exp: normalizedRow.q4w_exp ? parseInt(normalizedRow.q4w_exp) : null,
          emissions_amount: normalizedRow.emissions_amount || null,
          emissions_shares: normalizedRow.emissions_shares || null,
          src: 'csv',
        };

        validRows.push(transformedRow);

      } catch (error) {
        errors.push(`Row ${i + 1}: Transform error - ${error}`);
      }
    }

    if (errors.length > 0 && errors.length <= 5) {
      console.log(`⚠️  Validation warnings: ${errors.length} rows skipped`);
      errors.forEach(err => console.log(`   - ${err}`));
    } else if (errors.length > 5) {
      console.log(`⚠️  Validation warnings: ${errors.length} rows skipped (showing first 5)`);
      errors.slice(0, 5).forEach(err => console.log(`   - ${err}`));
    }

    console.log(`✓ ${validRows.length} valid rows ready for insertion`);

    if (validRows.length === 0) {
      return {
        success: false,
        rows_fetched: records.length,
        rows_inserted: 0,
        rows_updated: 0,
        error: 'No valid rows after transformation',
      };
    }

    // Insert into database
    console.log('Inserting into database...');
    const result = await backstopRepository.insertBatch(validRows);
    console.log(`✓ Inserted ${result.inserted} rows, updated ${result.updated} rows`);

    return {
      success: true,
      rows_fetched: records.length,
      rows_inserted: result.inserted,
      rows_updated: result.updated,
    };

  } catch (error) {
    console.error('❌ CSV processing failed:', error);
    return {
      success: false,
      rows_fetched: 0,
      rows_inserted: 0,
      rows_updated: 0,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
