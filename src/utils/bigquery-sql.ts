/**
 * Shared SQL fragments for extracting Blend Positions data from
 * crypto_stellar.contract_data JSON.
 *
 * The Positions value is a struct rendered as a JSON map with a stable,
 * alphabetical field order:
 *   $.map[0] = collateral (Map<u32 reserve_index, i128>)
 *   $.map[1] = liabilities (Map<u32 reserve_index, i128>)
 *   $.map[2] = supply      (Map<u32 reserve_index, i128>)
 *
 * The INNER maps are sparse: they contain only the reserves the user actually
 * holds, sorted by key. Entries therefore CANNOT be addressed by array
 * position ('$.map[N].val.map[<reserveIndex>]') — a user holding only
 * reserve 3 has that entry at position 0. The entry's '$.key.u32' must be
 * matched against the reserve index instead.
 */

export const POSITIONS_OUTER_INDEX = {
  collateral: 0,
  liabilities: 1,
  supply: 2,
} as const;

/**
 * Lower bound for ResConfig scans. Blend V2 launched 2025-04-14 and all
 * tracked pools were deployed after this date, so every ResConfig entry for
 * them has change records at or after it. contract_data is clustered by
 * (last_modified_ledger, contract_id) — a contract_id filter alone barely
 * prunes (measured: 122.74 GB billed for one unbounded ResConfig query),
 * while a closed_at bound prunes via time-ordered block stats.
 * If a pool deployed before this date is ever tracked, this must be moved
 * back or the mapping will silently miss reserves.
 */
export const RESCONFIG_MIN_CLOSED_AT = '2025-04-01';

/**
 * Returns a SQL expression selecting the i128 amount for `reserveIndex`
 * from one of the Positions inner maps, matched by key (NULL when the user
 * holds nothing in that reserve).
 *
 * `outerIndex` and `reserveIndex` are validated integers, safe to inline.
 */
export function positionEntryExpr(outerIndex: number, reserveIndex: number): string {
  if (!Number.isInteger(outerIndex) || outerIndex < 0 || outerIndex > 2) {
    throw new Error(`Invalid Positions outer index: ${outerIndex}`);
  }
  if (!Number.isInteger(reserveIndex) || reserveIndex < 0 || reserveIndex > 1000) {
    throw new Error(`Invalid reserve index: ${reserveIndex}`);
  }
  return `SAFE_CAST((SELECT JSON_VALUE(entry, '$.val.i128') FROM UNNEST(JSON_EXTRACT_ARRAY(val_decoded, '$.map[${outerIndex}].val.map')) AS entry WHERE SAFE_CAST(JSON_VALUE(entry, '$.key.u32') AS INT64) = ${reserveIndex}) AS FLOAT64)`;
}

/**
 * Returns the per-reserve extraction columns (supply_<idx>_raw,
 * collateral_<idx>_raw, liabilities_<idx>_raw) used by the wide-format
 * Positions queries.
 */
export function positionIndexColumns(indices: number[]): string {
  return indices.map(idx => `
    ${positionEntryExpr(POSITIONS_OUTER_INDEX.supply, idx)} AS supply_${idx}_raw,
    ${positionEntryExpr(POSITIONS_OUTER_INDEX.collateral, idx)} AS collateral_${idx}_raw,
    ${positionEntryExpr(POSITIONS_OUTER_INDEX.liabilities, idx)} AS liabilities_${idx}_raw`).join(',');
}
