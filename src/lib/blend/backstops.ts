/**
 * Blend backstop deployments and their backstop (Comet BLND-USDC LP) tokens.
 *
 * V1 and V2 share the Comet V1 LP, which no longer functions (accounting bug,
 * drained of USDC). V2.1 is a fork of V2 whose backstop token is the patched
 * Comet V1.1 LP. Pools are bound to one backstop via their metadata.
 */

export const BACKSTOP_V1 = "CAO3AGAMZVRMHITL36EJ2VZQWKYRPWMQAPDQD5YEOF3GIF7T44U4JAL3";
export const BACKSTOP_V2 = "CAQQR5SWBXKIGZKPBZDH3KM5GQ5GUTPKB7JAFCINLZBC5WXPJKRG3IM7";
export const BACKSTOP_V2_1 = "CCS4AZ5ORM6VLLPJTJUFRNXWBMHOO3L5WHHRPL2ZMILE35ZDMQFHOQMJ";

/** Comet V1 BLND-USDC LP (backstop token of V1 and V2) */
export const LP_TOKEN_V1 = "CAS3FL6TLZKDGGSISDBWGGPXT3NRR4DYTZD7YOD3HMYO6LTJUVGRVEAM";
/** Comet V1.1 BLND-USDC LP (backstop token of V2.1) */
export const LP_TOKEN_V1_1 = "CASYAKK3SHDN6S2E6IUOBVRXT3KKPVQCVQO4GNBDTVE6XZQQMW4UMIHE";

/** Backstop token of each backstop contract */
export const BACKSTOP_LP_TOKEN: Record<string, string> = {
  [BACKSTOP_V1]: LP_TOKEN_V1,
  [BACKSTOP_V2]: LP_TOKEN_V1,
  [BACKSTOP_V2_1]: LP_TOKEN_V1_1,
};

/**
 * Backstops whose BLND emissions are not claimable yet. The emitter still
 * funds the V2 backstop, so V2.1 accruals are unfunded and the official Blend
 * UI hides them ("Claiming is disabled until V2.1 emissions are enabled").
 * Remove the entry once the emitter migrates to V2.1.
 */
export const EMISSIONS_DISABLED_BACKSTOPS: ReadonlySet<string> = new Set([BACKSTOP_V2_1]);

export function areEmissionsEnabled(backstopId: string): boolean {
  return !EMISSIONS_DISABLED_BACKSTOPS.has(backstopId);
}

/** True when an SDK emission config (expiration in unix seconds) is still paying out */
export function isEmissionActive(
  emission: { eps: bigint; expiration: bigint | number } | undefined | null,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  return !!emission && emission.eps > 0n && Number(emission.expiration) > nowSeconds;
}
