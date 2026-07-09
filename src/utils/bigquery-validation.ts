/**
 * Input validation for values that end up in BigQuery queries.
 * Executed queries use named parameters; these guards additionally protect
 * the display/copy-paste query strings and act as defense in depth.
 */

const DATE_FORMAT_RE = /^\d{4}-\d{2}-\d{2}$/;
const STELLAR_ADDRESS_RE = /^[GCM][A-Z2-7]{55}$/;

export function assertValidDate(name: string, value: string): void {
  if (typeof value !== "string" || !DATE_FORMAT_RE.test(value) || isNaN(new Date(value).getTime())) {
    throw new Error(`Invalid ${name}: must be a valid YYYY-MM-DD date`);
  }
}

export function assertValidLimit(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 10_000_000) {
    throw new Error("Invalid limit: must be an integer between 1 and 10000000");
  }
}

export function assertValidStellarAddress(name: string, value: string): void {
  if (typeof value !== "string" || !STELLAR_ADDRESS_RE.test(value)) {
    throw new Error(`Invalid ${name}: must be a valid Stellar address`);
  }
}
