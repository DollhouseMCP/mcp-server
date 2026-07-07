/**
 * Shared query/param string readers for console route modules, so every
 * module parses request inputs with ONE set of semantics instead of drifting
 * per-module copies.
 */

/** First string out of an Express query/param value (string | string[] | undefined). */
export function firstString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

/**
 * Trimmed non-empty string within the length bound, else null. Over-length
 * input is rejected (treated as absent), never truncated — a silently
 * truncated filter would match different data than the client asked for.
 */
export function boundedString(value: string | null, maxLength: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

/**
 * Positive integer limit capped at `max`; anything absent, unparsable, or
 * below 1 yields the endpoint's fallback.
 */
export function boundedLimit(value: string | null, fallback: number, max: number): number {
  return optionalLimit(value, max) ?? fallback;
}

/**
 * Like boundedLimit, but with no endpoint-level fallback: absent/invalid
 * input yields null so the caller can omit the option entirely and let the
 * underlying source apply its own default.
 */
export function optionalLimit(value: string | null, max: number): number | null {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return Math.min(parsed, max);
}
