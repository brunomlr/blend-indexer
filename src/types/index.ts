// Pool Snapshot Types
export interface PoolSnapshotRow {
  pool_id: string;
  asset_address: string;
  snapshot_date: string;
  snapshot_timestamp: string;
  ledger_sequence: number;
  b_rate: number;
  d_rate: number;
  b_supply: number;
  d_supply: number;
  last_time?: number; // Optional: Unix timestamp from blockchain
}

// Backstop Pool Snapshot Types (for Q4W percentage tracking)
export interface BackstopPoolSnapshotRow {
  pool_address: string;
  snapshot_date: string;
  snapshot_timestamp: string;
  ledger_sequence: number;
  shares: string;       // Total backstop shares (stored as string for bigint)
  tokens: string;       // Total LP tokens deposited
  q4w: string;          // Shares queued for withdrawal
  q4w_pct: number;      // (q4w / shares) * 100
  src?: string;         // 'bq' = BigQuery, 'gs' = Goldsky
}

// User Position Types
export interface UserPositionRow {
  pool_id: string;
  user_address: string;
  asset_address: string;
  snapshot_date: string;
  snapshot_timestamp: string;
  ledger_sequence: number;
  supply_btokens: number;
  collateral_btokens: number;
  liabilities_dtokens: number;
  b_rate?: number; // Supply rate index (optional - fetched with positions)
  d_rate?: number; // Borrow rate index (optional - fetched with positions)
  entry_hash?: string; // Ledger entry hash for deduplication
  ledger_entry_change?: number; // Change type metadata
}

// Balance Calculation Types
export interface UserBalance {
  pool_id: string;
  user_address: string;
  asset_address: string;
  snapshot_date: string;
  snapshot_timestamp: string;
  ledger_sequence: number;
  supply_balance: number;
  collateral_balance: number;
  debt_balance: number;
  net_balance: number;
  supply_btokens: number;
  collateral_btokens: number;
  liabilities_dtokens: number;
  entry_hash: string | null;
  ledger_entry_change: number | null;
  b_rate: number;
  d_rate: number;
  // Debug fields for rate comparison
  position_b_rate?: number | null;
  position_d_rate?: number | null;
  snapshot_b_rate?: number | null;
  snapshot_d_rate?: number | null;
  position_date?: string | null;
}

// API Response Types
export interface BackfillResult {
  success: boolean;
  rows_inserted: number;
  rows_updated: number;
  query_id: number;
  error?: string;
}

export interface StatsResponse {
  pool_snapshots: {
    total_rows: number;
    latest_date: string;
    unique_assets: number;
  };
  user_positions: {
    total_rows: number;
    latest_date: string;
    unique_users: number;
  };
}
