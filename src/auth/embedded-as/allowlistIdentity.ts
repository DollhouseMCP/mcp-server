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
