import { Version } from "@blend-capital/blend-sdk";

export interface TrackedPool {
  id: string;
  name: string;
  version: Version;
}

/**
 * Pools to track and backfill data for
 *
 * ⚠️  SINGLE SOURCE OF TRUTH for pool configuration
 *
 * When adding a new pool, also update the Goldsky YAML files manually:
 *   - stellar-events-stream/goldsky/pipeline-webhook.yaml
 *   - stellar-events-stream/goldsky/pipeline-postgres.yaml
 *   - stellar-events-stream/goldsky/pipeline-postgres-full.yaml
 *   - stellar-events-stream/goldsky/pipeline-blend-actions.yaml
 */
export const TRACKED_POOLS: TrackedPool[] = [
  {
    id: "CCCCIQSDILITHMM7PBSLVDT5MISSY7R26MNZXCX4H7J5JQ5FPIYOGYFS",
    name: "YieldBlox",
    version: Version.V2,
  },
  {
    id: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
    name: "Blend Pool",
    version: Version.V2,
  },
  {
    id: "CAE7QVOMBLZ53CDRGK3UNRRHG5EZ5NQA7HHTFASEMYBWHG6MDFZTYHXC",
    name: "Orbit",
    version: Version.V2,
  },
  {
    id: "CBYOBT7ZCCLQCBUYYIABZLSEGDPEUWXCUXQTZYOG3YBDR7U357D5ZIRF",
    name: "Forex",
    version: Version.V2,
  },
  {
    id: "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI",
    name: "Etherfuse",
    version: Version.V2,
  },
];

/** Array of just the pool contract IDs for simple lookups */
export const POOL_IDS = TRACKED_POOLS.map((p) => p.id);

/** Set of pool IDs for O(1) lookups */
export const POOL_IDS_SET = new Set(POOL_IDS);

/** Check if a contract ID is a tracked pool */
export function isTrackedPool(contractId: string): boolean {
  return POOL_IDS_SET.has(contractId);
}

/** Get pool by ID */
export function getPoolById(id: string): TrackedPool | undefined {
  return TRACKED_POOLS.find((p) => p.id === id);
}
