import { parseUnits } from "viem";

/**
 * Sanitize a user-typed decimal input.
 *
 * - Keeps digits and at most a single dot.
 * - Drops any other characters (letters, minus sign, spaces, etc).
 * - Returns the cleaned string, suitable for displaying back in the input.
 */
export function sanitizeDecimalInput(value: string): string {
  if (!value) return "";

  // Remove anything that's not a digit or dot
  const cleaned = value.replace(/[^\d.]/g, "");

  // Ensure at most one dot: keep the first, drop the rest
  const parts = cleaned.split(".");
  if (parts.length <= 1) return cleaned;

  const [intPart, ...rest] = parts;
  return `${intPart}.${rest.join("")}`;
}

/**
 * Safely parse a sanitized decimal string into a bigint using viem's parseUnits.
 *
 * - Returns 0n for empty/invalid inputs instead of throwing.
 * - Accepts strings like "0", "1", "1.23".
 * - Intermediate forms like "." or "" are treated as 0n.
 */
export function parseDecimalAmount(
  value: string,
  decimals: number | bigint,
): bigint {
  if (!value) return 0n;

  const sanitized = sanitizeDecimalInput(value);

  // Only parse when the string is a valid decimal form
  if (
    !/^\d*\.?\d*$/.test(sanitized) || // basic decimal shape check
    sanitized === "." // lone dot is not a valid number
  ) {
    return 0n;
  }

  try {
    return parseUnits(sanitized, Number(decimals));
  } catch {
    // As a safety net, never let parseUnits throw into the React tree
    return 0n;
  }
}

