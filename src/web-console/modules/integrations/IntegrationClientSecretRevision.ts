import type { IConsoleOpaqueValueService } from '../../security/ConsoleOpaqueValues.js';

const REVISION_DOMAIN = 'dollhousemcp:integration-client-secret-revision:v1';

/**
 * Derive a stable, non-verifying UUID from a curated OAuth client secret.
 * The deployment HMAC key keeps the persisted revision from becoming an
 * offline verifier; the domain and provider prevent cross-purpose equality.
 */
export function deriveIntegrationClientSecretRevision(
  opaqueValues: Pick<IConsoleOpaqueValueService, 'hashOpaqueValue'>,
  provider: string,
  clientSecret: string,
): string {
  const digest = opaqueValues.hashOpaqueValue(JSON.stringify([
    REVISION_DOMAIN,
    provider,
    clientSecret,
  ]));
  const uuidBytes = Buffer.from(digest.subarray(0, 16));
  try {
    // RFC 9562 UUIDv8 marks an application-defined, keyed 122-bit value.
    uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x80;
    uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;
    const hex = uuidBytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } finally {
    digest.fill(0);
    uuidBytes.fill(0);
  }
}
