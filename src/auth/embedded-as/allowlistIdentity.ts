import type { AuthAllowlistKind } from './storage/IAuthStorageLayer.js';

/**
 * Canonicalize an authorization principal without changing its identity.
 *
 * NFC treats canonically equivalent Unicode encodings consistently while
 * preserving look-alike characters from different scripts as distinct values.
 */
export function normalizeAuthAllowlistPrincipal(value: string): string {
  return value.normalize('NFC').trim();
}

export function normalizeAuthAllowlistValue(
  kind: AuthAllowlistKind,
  value: string
): string {
  const principal = normalizeAuthAllowlistPrincipal(value);
  return kind === 'github_id' ? principal : principal.toLowerCase();
}

/**
 * Compare a persisted allowlist value with a presented identity.
 *
 * Older durable stores may contain canonically equivalent NFD values.
 * Normalize both sides at the comparison boundary so upgrades preserve
 * access without introducing cross-script confusable rewriting.
 */
export function storedAuthAllowlistValueMatches(
  kind: AuthAllowlistKind,
  storedValue: string,
  presentedValue: string,
): boolean {
  return normalizeAuthAllowlistValue(kind, storedValue)
    === normalizeAuthAllowlistValue(kind, presentedValue);
}
