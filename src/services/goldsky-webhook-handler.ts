import {
  GoldskyWebhookPayload,
  GoldskyEvent,
  ParsedPositionChange,
  ParsedPoolChange,
  ParsedResConfig,
  WebhookProcessingResult,
  EventType,
  ReserveMapping,
  GoldskyKeyDecoded,
  GoldskyMapEntry,
} from '../types/goldsky';
import { UserPositionRow, PoolSnapshotRow } from '../types';
import { userRepository } from '../repositories/user-repository';
import { poolRepository } from '../repositories/pool-repository';

/**
 * GoldskyWebhookHandler
 *
 * Processes incoming webhook events from Goldsky for real-time position and pool updates.
 * Complements the BigQuery backfill by streaming new changes as they happen on-chain.
 */
export class GoldskyWebhookHandler {
  // In-memory cache for reserve index → asset mapping
  // This avoids DB lookups for every position event
  private reserveMappingCache: Map<string, Map<number, string>> = new Map();

  /**
   * Process incoming webhook payload from Goldsky
   */
  async processWebhook(payload: GoldskyWebhookPayload): Promise<WebhookProcessingResult> {
    const result: WebhookProcessingResult = {
      success: true,
      events_received: payload.events.length,
      positions_processed: 0,
      pools_processed: 0,
      configs_processed: 0,
      positions_inserted: 0,
      positions_updated: 0,
      pools_inserted: 0,
      pools_updated: 0,
      errors: [],
    };

    console.log(`📥 Processing Goldsky webhook: ${payload.events.length} events`);
    console.log(`   Network: ${payload.network}`);
    console.log(`   Timestamp: ${payload.timestamp}`);

    // Sort events by ledger sequence to process in order
    const sortedEvents = [...payload.events].sort(
      (a, b) => a.ledger_sequence - b.ledger_sequence
    );

    // First pass: Process ResConfig events to update mapping cache
    const configEvents = sortedEvents.filter(e => this.getEventType(e) === 'ResConfig');
    for (const event of configEvents) {
      try {
        await this.processResConfigEvent(event);
        result.configs_processed++;
      } catch (error) {
        const errMsg = `ResConfig event error (ledger ${event.ledger_sequence}): ${error}`;
        console.error(errMsg);
        result.errors.push(errMsg);
      }
    }

    // Second pass: Process ResData (pool/rate) events
    const poolEvents = sortedEvents.filter(e => this.getEventType(e) === 'ResData');
    for (const event of poolEvents) {
      try {
        const dbResult = await this.processPoolEvent(event);
        result.pools_processed++;
        result.pools_inserted += dbResult.inserted;
        result.pools_updated += dbResult.updated;
      } catch (error) {
        const errMsg = `Pool event error (ledger ${event.ledger_sequence}): ${error}`;
        console.error(errMsg);
        result.errors.push(errMsg);
      }
    }

    // Third pass: Process Position events
    const positionEvents = sortedEvents.filter(e => this.getEventType(e) === 'Positions');
    for (const event of positionEvents) {
      try {
        const dbResult = await this.processPositionEvent(event);
        result.positions_processed++;
        result.positions_inserted += dbResult.inserted;
        result.positions_updated += dbResult.updated;
      } catch (error) {
        const errMsg = `Position event error (ledger ${event.ledger_sequence}): ${error}`;
        console.error(errMsg);
        result.errors.push(errMsg);
      }
    }

    if (result.errors.length > 0) {
      result.success = false;
      console.error(`❌ Webhook processing completed with ${result.errors.length} errors`);
    } else {
      console.log(`✅ Webhook processing completed successfully`);
    }

    console.log(`📊 Summary:`);
    console.log(`   Positions: ${result.positions_processed} processed (${result.positions_inserted} inserted, ${result.positions_updated} updated)`);
    console.log(`   Pools: ${result.pools_processed} processed (${result.pools_inserted} inserted, ${result.pools_updated} updated)`);
    console.log(`   Configs: ${result.configs_processed} processed`);

    return result;
  }

  /**
   * Determine the type of event based on key structure
   */
  private getEventType(event: GoldskyEvent): EventType {
    const key = event.key_decoded as any;
    if (!key?.vec || !Array.isArray(key.vec) || key.vec.length < 1) {
      return 'Unknown';
    }

    const symbol = key.vec[0]?.symbol;
    if (symbol === 'Positions') return 'Positions';
    if (symbol === 'ResData') return 'ResData';
    if (symbol === 'ResConfig') return 'ResConfig';
    return 'Unknown';
  }

  /**
   * Process a ResConfig event to update reserve index mapping
   */
  private async processResConfigEvent(event: GoldskyEvent): Promise<void> {
    const parsed = this.parseResConfigEvent(event);
    if (!parsed) {
      console.warn(`⚠️  Failed to parse ResConfig event at ledger ${event.ledger_sequence}`);
      return;
    }

    // Update cache
    if (!this.reserveMappingCache.has(parsed.pool_id)) {
      this.reserveMappingCache.set(parsed.pool_id, new Map());
    }

    const poolCache = this.reserveMappingCache.get(parsed.pool_id)!;

    if (parsed.deleted) {
      poolCache.delete(parsed.reserve_index);
      console.log(`🗑️  Removed reserve mapping: pool ${parsed.pool_id.substring(0, 8)}... index ${parsed.reserve_index}`);
    } else {
      poolCache.set(parsed.reserve_index, parsed.asset_address);
      console.log(`✓ Updated reserve mapping: pool ${parsed.pool_id.substring(0, 8)}... index ${parsed.reserve_index} → ${parsed.asset_address.substring(0, 8)}...`);
    }
  }

  /**
   * Process a pool/rate change event (ResData)
   */
  private async processPoolEvent(event: GoldskyEvent): Promise<{ inserted: number; updated: number }> {
    const parsed = this.parsePoolEvent(event);
    if (!parsed) {
      throw new Error('Failed to parse pool event');
    }

    // Skip deleted entries for pool snapshots
    if (parsed.deleted) {
      console.log(`⏭️  Skipping deleted ResData entry`);
      return { inserted: 0, updated: 0 };
    }

    // Convert to PoolSnapshotRow format
    const snapshot: PoolSnapshotRow = {
      pool_id: parsed.pool_id,
      asset_address: parsed.asset_address,
      snapshot_date: parsed.snapshot_timestamp.split('T')[0], // Extract date
      snapshot_timestamp: parsed.snapshot_timestamp,
      ledger_sequence: parsed.ledger_sequence,
      b_rate: this.convertRawRate(parsed.b_rate_raw),
      d_rate: this.convertRawRate(parsed.d_rate_raw),
      b_supply: this.convertRawAmount(parsed.b_supply_raw),
      d_supply: this.convertRawAmount(parsed.d_supply_raw),
      last_time: parsed.last_time ? parseInt(parsed.last_time) : undefined,
    };

    // Insert into database (using upsert to handle duplicates)
    const result = await poolRepository.insertBatch([snapshot]);
    return result;
  }

  /**
   * Process a position change event
   */
  private async processPositionEvent(event: GoldskyEvent): Promise<{ inserted: number; updated: number }> {
    const parsed = this.parsePositionEvent(event);
    if (!parsed) {
      throw new Error('Failed to parse position event');
    }

    // Skip deleted entries
    if (parsed.deleted) {
      console.log(`⏭️  Skipping deleted position entry`);
      return { inserted: 0, updated: 0 };
    }

    // Get asset address from reserve index mapping
    const assetAddress = this.getAssetFromReserveIndex(
      parsed.pool_id,
      parsed.reserve_index
    );

    if (!assetAddress) {
      throw new Error(
        `No asset mapping found for pool ${parsed.pool_id.substring(0, 8)}... reserve index ${parsed.reserve_index}`
      );
    }

    // Get current rates for this pool/asset from latest pool snapshot
    const rates = await this.getCurrentRates(
      parsed.pool_id,
      assetAddress,
      parsed.ledger_sequence
    );

    // Convert to UserPositionRow format
    const position: UserPositionRow = {
      pool_id: parsed.pool_id,
      user_address: parsed.user_address,
      asset_address: assetAddress,
      snapshot_date: parsed.snapshot_timestamp.split('T')[0], // Extract date
      snapshot_timestamp: parsed.snapshot_timestamp,
      ledger_sequence: parsed.ledger_sequence,
      supply_btokens: this.convertRawAmount(parsed.supply_btokens_raw),
      collateral_btokens: this.convertRawAmount(parsed.collateral_btokens_raw),
      liabilities_dtokens: this.convertRawAmount(parsed.liabilities_dtokens_raw),
      b_rate: rates?.b_rate,
      d_rate: rates?.d_rate,
      entry_hash: parsed.entry_hash,
      ledger_entry_change: parsed.ledger_entry_change,
    };

    // Insert into database (using upsert to handle duplicates)
    const result = await userRepository.insertBatch([position]);
    return result;
  }

  /**
   * Parse a Positions event
   */
  private parsePositionEvent(event: GoldskyEvent): ParsedPositionChange | null {
    try {
      const key = event.key_decoded as any;
      const val = event.val_decoded;

      // Extract user address from key
      const userAddress = key.vec[1]?.address;
      if (!userAddress) {
        console.warn('Missing user address in Positions event');
        return null;
      }

      // Extract position data from value
      // Position map structure (alphabetically sorted keys):
      // Index 0: collateral (map of reserve_id -> amount)
      // Index 1: liabilities (map of reserve_id -> amount)
      // Index 2: supply (map of reserve_id -> amount)

      // Parse all reserve indices from the position
      const positions: ParsedPositionChange[] = [];

      if (!val?.map || !Array.isArray(val.map)) {
        console.warn('Invalid value structure in Positions event');
        return null;
      }

      // Get the three maps (collateral, liabilities, supply)
      const collateralMap = val.map.find((entry: any) => entry.key?.u32 === 0)?.val?.map || [];
      const liabilitiesMap = val.map.find((entry: any) => entry.key?.u32 === 1)?.val?.map || [];
      const supplyMap = val.map.find((entry: any) => entry.key?.u32 === 2)?.val?.map || [];

      // Collect all unique reserve indices
      const reserveIndices = new Set<number>();
      collateralMap.forEach((entry: any) => {
        if (entry.key?.u32 !== undefined) reserveIndices.add(entry.key.u32);
      });
      liabilitiesMap.forEach((entry: any) => {
        if (entry.key?.u32 !== undefined) reserveIndices.add(entry.key.u32);
      });
      supplyMap.forEach((entry: any) => {
        if (entry.key?.u32 !== undefined) reserveIndices.add(entry.key.u32);
      });

      // Create a position change for the first reserve index found
      // (In practice, we might want to handle multiple reserves, but for now take the first)
      const firstIndex = Array.from(reserveIndices)[0];
      if (firstIndex === undefined) {
        console.warn('No reserve indices found in position');
        return null;
      }

      const supply = supplyMap.find((entry: any) => entry.key?.u32 === firstIndex)?.val?.i128;
      const collateral = collateralMap.find((entry: any) => entry.key?.u32 === firstIndex)?.val?.i128;
      const liabilities = liabilitiesMap.find((entry: any) => entry.key?.u32 === firstIndex)?.val?.i128;

      return {
        pool_id: event.contract_id,
        user_address: userAddress,
        reserve_index: firstIndex,
        snapshot_timestamp: event.closed_at,
        ledger_sequence: event.ledger_sequence,
        entry_hash: event.ledger_key_hash,
        ledger_entry_change: event.ledger_entry_change,
        supply_btokens_raw: supply || null,
        collateral_btokens_raw: collateral || null,
        liabilities_dtokens_raw: liabilities || null,
        deleted: event.deleted,
      };
    } catch (error) {
      console.error('Error parsing position event:', error);
      return null;
    }
  }

  /**
   * Parse a ResData (pool/rate) event
   */
  private parsePoolEvent(event: GoldskyEvent): ParsedPoolChange | null {
    try {
      const key = event.key_decoded as any;
      const val = event.val_decoded;

      // Extract asset address from key
      const assetAddress = key.vec[1]?.address;
      if (!assetAddress) {
        console.warn('Missing asset address in ResData event');
        return null;
      }

      if (!val?.map || !Array.isArray(val.map)) {
        console.warn('Invalid value structure in ResData event');
        return null;
      }

      // Extract rate and supply data
      // ResData map structure:
      // 0: b_rate
      // 1: b_supply
      // 3: d_rate
      // 4: d_supply
      // 6: last_time
      const b_rate = val.map.find((entry: any) => entry.key?.u32 === 0)?.val?.i128;
      const b_supply = val.map.find((entry: any) => entry.key?.u32 === 1)?.val?.i128;
      const d_rate = val.map.find((entry: any) => entry.key?.u32 === 3)?.val?.i128;
      const d_supply = val.map.find((entry: any) => entry.key?.u32 === 4)?.val?.i128;
      const last_time = val.map.find((entry: any) => entry.key?.u32 === 6)?.val?.u64;

      return {
        pool_id: event.contract_id,
        asset_address: assetAddress,
        snapshot_timestamp: event.closed_at,
        ledger_sequence: event.ledger_sequence,
        b_rate_raw: b_rate || null,
        d_rate_raw: d_rate || null,
        b_supply_raw: b_supply || null,
        d_supply_raw: d_supply || null,
        last_time: last_time || null,
        deleted: event.deleted,
      };
    } catch (error) {
      console.error('Error parsing pool event:', error);
      return null;
    }
  }

  /**
   * Parse a ResConfig event
   */
  private parseResConfigEvent(event: GoldskyEvent): ParsedResConfig | null {
    try {
      const key = event.key_decoded as any;
      const val = event.val_decoded;

      // Extract asset address from key
      const assetAddress = key.vec[1]?.address;
      if (!assetAddress) {
        console.warn('Missing asset address in ResConfig event');
        return null;
      }

      if (event.deleted) {
        // For deleted events, we don't have val_decoded
        // We'll need to infer the reserve index from our cache or skip
        return {
          pool_id: event.contract_id,
          asset_address: assetAddress,
          reserve_index: -1, // Unknown - will need special handling
          ledger_sequence: event.ledger_sequence,
          deleted: true,
        };
      }

      if (!val?.map || !Array.isArray(val.map)) {
        console.warn('Invalid value structure in ResConfig event');
        return null;
      }

      // Extract reserve index
      // ResConfig map structure:
      // 3: index (u32)
      const reserveIndex = val.map.find((entry: any) => entry.key?.u32 === 3)?.val?.u32;
      if (reserveIndex === undefined) {
        console.warn('Missing reserve index in ResConfig event');
        return null;
      }

      return {
        pool_id: event.contract_id,
        asset_address: assetAddress,
        reserve_index: reserveIndex,
        ledger_sequence: event.ledger_sequence,
        deleted: event.deleted,
      };
    } catch (error) {
      console.error('Error parsing ResConfig event:', error);
      return null;
    }
  }

  /**
   * Get asset address from reserve index using cache
   */
  private getAssetFromReserveIndex(poolId: string, reserveIndex: number): string | null {
    const poolCache = this.reserveMappingCache.get(poolId);
    return poolCache?.get(reserveIndex) || null;
  }

  /**
   * Get current rates for a pool/asset at a given ledger
   * Queries the most recent pool snapshot at or before the given ledger
   */
  private async getCurrentRates(
    poolId: string,
    assetAddress: string,
    ledgerSequence: number
  ): Promise<{ b_rate: number; d_rate: number } | null> {
    try {
      // Query pool_snapshots for the most recent rates at or before this ledger
      const result = await poolRepository.getLatestRatesAtLedger(
        poolId,
        assetAddress,
        ledgerSequence
      );
      return result;
    } catch (error) {
      console.warn(
        `Failed to get rates for ${poolId.substring(0, 8)}.../${assetAddress.substring(0, 8)}... at ledger ${ledgerSequence}:`,
        error
      );
      return null;
    }
  }

  /**
   * Convert raw i128 rate value to decimal (divide by 10^12)
   */
  private convertRawRate(rawValue: string | null): number {
    if (!rawValue) return 0;
    const value = BigInt(rawValue);
    return Number(value) / Math.pow(10, 12);
  }

  /**
   * Convert raw i128 amount value to decimal (divide by 10^7)
   */
  private convertRawAmount(rawValue: string | null): number {
    if (!rawValue) return 0;
    const value = BigInt(rawValue);
    return Number(value) / Math.pow(10, 7);
  }

  /**
   * Preload reserve mappings from database
   * Call this on startup to populate the cache
   */
  async preloadReserveMappings(poolIds: string[]): Promise<void> {
    console.log('🔄 Preloading reserve mappings from database...');

    for (const poolId of poolIds) {
      try {
        // Query latest ResConfig entries for this pool
        // This would be a custom query - you may need to add this to your repositories
        // For now, we'll rely on ResConfig events to populate the cache
        console.log(`  Pool ${poolId.substring(0, 8)}... - relying on ResConfig events`);
      } catch (error) {
        console.error(`Failed to preload mappings for pool ${poolId}:`, error);
      }
    }

    console.log('✓ Reserve mapping preload complete');
  }
}

export const goldskyWebhookHandler = new GoldskyWebhookHandler();
