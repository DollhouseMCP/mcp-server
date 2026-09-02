/**
 * Shared query-parameter helpers for console list surfaces, so every module
 * parses `?limit` / `?cursor` / filter params the same way instead of
 * hand-rolling its own bounded parsers.
 */
import type { ConsoleRequest } from './ConsolePlatformTypes.js';

/** First scalar value of a query param that Express may deliver as an array. */
export function firstQueryValue(value: ConsoleRequest['query'][string]): string | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : null;
  }
  return typeof value === 'string' ? value : null;
}

/** A 1..`ceiling` integer limit; non-numeric or absent input yields `fallback`. */
export function boundedLimit(value: string | null, fallback: number, ceiling = 100): number {
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isSafeInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), ceiling);
}

/** A trimmed, length-capped string, or null when absent/empty. */
export function boundedString(value: string | null, maxLength: number): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}
