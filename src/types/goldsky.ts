/**
 * Goldsky Webhook Event Types
 *
 * These types represent the data structure sent by Goldsky webhooks
 * for Stellar blockchain events related to Blend Protocol.
 */

// Base event structure from Goldsky
export interface GoldskyWebhookPayload {
  events: GoldskyEvent[];
  timestamp: string; // ISO timestamp when webhook was sent
  network: string; // e.g., "stellar-mainnet"
}

// Individual blockchain event
export interface GoldskyEvent {
  ledger_sequence: number;
  closed_at: string; // ISO timestamp
  contract_id: string; // Pool address
  ledger_key_hash: string; // Unique identifier for this ledger entry
  ledger_entry_change: number; // 0=created, 1=updated, 2=deleted
  deleted: boolean;
  key_decoded: GoldskyKeyDecoded;
  val_decoded?: GoldskyValueDecoded; // Only present if not deleted
}

// Decoded contract data key
export type GoldskyKeyDecoded =
  | PositionsKeyDecoded
  | ResDataKeyDecoded
  | ResConfigKeyDecoded;

interface PositionsKeyDecoded {
  vec: [
    { symbol: "Positions" },
    { address: string } // user_address
  ];
}

interface ResDataKeyDecoded {
  vec: [
    { symbol: "ResData" },
    { address: string } // asset_address
  ];
}

interface ResConfigKeyDecoded {
  vec: [
    { symbol: "ResConfig" },
    { address: string } // asset_address
  ];
}

// Decoded contract data value (complex nested structure)
export interface GoldskyValueDecoded {
  map?: GoldskyMapEntry[];
  vec?: any[];
  [key: string]: any;
}

export interface GoldskyMapEntry {
  key: GoldskyScVal;
  val: GoldskyScVal;
}

export interface GoldskyScVal {
  u32?: number;
  u64?: string;
  i128?: string;
  symbol?: string;
  address?: string;
  map?: GoldskyMapEntry[];
  vec?: any[];
  [key: string]: any;
}

/**
 * Parsed Position Change Event
 * After extracting relevant data from Goldsky event
 */
export interface ParsedPositionChange {
  pool_id: string;
  user_address: string;
  reserve_index: number;
  snapshot_timestamp: string;
  ledger_sequence: number;
  entry_hash: string;
  ledger_entry_change: number;
  supply_btokens_raw: string | null;
  collateral_btokens_raw: string | null;
  liabilities_dtokens_raw: string | null;
  deleted: boolean;
}

/**
 * Parsed Pool/Rate Change Event
 * After extracting relevant data from Goldsky event
 */
export interface ParsedPoolChange {
  pool_id: string;
  asset_address: string;
  snapshot_timestamp: string;
  ledger_sequence: number;
  b_rate_raw: string | null;
  d_rate_raw: string | null;
  b_supply_raw: string | null;
  d_supply_raw: string | null;
  last_time: string | null;
  deleted: boolean;
}

/**
 * Parsed ResConfig Event
 * Used to maintain reserve index → asset mapping
 */
export interface ParsedResConfig {
  pool_id: string;
  asset_address: string;
  reserve_index: number;
  ledger_sequence: number;
  deleted: boolean;
}

/**
 * Processing result for webhook handler
 */
export interface WebhookProcessingResult {
  success: boolean;
  events_received: number;
  positions_processed: number;
  pools_processed: number;
  configs_processed: number;
  positions_inserted: number;
  positions_updated: number;
  pools_inserted: number;
  pools_updated: number;
  errors: string[];
}

/**
 * Helper type to identify event type
 */
export type EventType = 'Positions' | 'ResData' | 'ResConfig' | 'Unknown';

/**
 * Reserve index mapping cache entry
 */
export interface ReserveMapping {
  pool_id: string;
  reserve_index: number;
  asset_address: string;
  last_updated: number; // ledger_sequence
}
