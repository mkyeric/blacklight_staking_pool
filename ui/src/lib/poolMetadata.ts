/**
 * Helpers for pool metadataURI (stored on StakingOperators.getOperatorInfo).
 * Format: "blacklight-pool:{poolAddress}:{name}" — name is optional, max 30 chars, safe string.
 */

const PREFIX = "blacklight-pool:";

/** Allowed chars: alphanumeric, hyphen, underscore. Max 30. */
const SAFE_NAME_REGEX = /^[a-zA-Z0-9_-]{0,30}$/;

export function sanitizePoolName(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 30);
}

export function isValidPoolName(input: string): boolean {
  return SAFE_NAME_REGEX.test(input) && input.length > 0;
}

/** Build metadataURI for registerOperator. */
export function buildMetadataURI(poolAddress: string, name: string): string {
  const safe = sanitizePoolName(name);
  if (!safe) {
    return `${PREFIX}${poolAddress}`;
  }
  return `${PREFIX}${poolAddress}:${safe}`;
}

/** Parse display name from metadataURI. Falls back to truncated pool address. */
export function parsePoolDisplayName(
  metadataURI: string,
  poolAddress: string
): string {
  if (!metadataURI || typeof metadataURI !== "string") {
    return `${poolAddress.slice(0, 10)}…${poolAddress.slice(-8)}`;
  }
  const parts = metadataURI.split(":");
  // Format: blacklight-pool:0xPool...:CustomName
  if (parts.length >= 3) {
    return parts.slice(2).join(":"); // in case of future colons in name
  }
  // Old format: blacklight-pool:0xPool...
  return `${poolAddress.slice(0, 10)}…${poolAddress.slice(-8)}`;
}
