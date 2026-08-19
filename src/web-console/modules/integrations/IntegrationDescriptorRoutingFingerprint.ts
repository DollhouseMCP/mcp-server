import { createHmac } from 'node:crypto';

import type { IntegrationDescriptorRecord } from '../../stores/IIntegrationDescriptorStore.js';

/**
 * Digest only the descriptor fields that decide where and how credentials are
 * obtained or sent. Display-only edits deliberately do not invalidate a flow.
 */
export function integrationDescriptorRoutingFingerprint(
  descriptor: IntegrationDescriptorRecord,
): string {
  const payload = {
    provider: descriptor.provider,
    authStrategy: descriptor.authStrategy,
    apiHosts: descriptor.apiHosts,
    oauth: descriptor.oauth,
    staticApiKey: descriptor.staticApiKey,
    operationPromotion: descriptor.operationPromotion,
    clientSecretCiphertext: descriptor.clientSecretCiphertext?.toString('base64') ?? null,
    credentialKeyVersion: descriptor.credentialKeyVersion,
  };
  // This is a change-detection MAC over configuration (including already
  // encrypted credential material), not a password verifier. The descriptor's
  // public UUID is a per-record domain separator, not a secret key.
  return createHmac('sha256', descriptor.id)
    .update(canonicalJson(payload))
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('descriptor routing values must be JSON-compatible');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort(compareCanonicalJsonKeys)
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function compareCanonicalJsonKeys(left: string, right: string): number {
  if (left === right) return 0;
  // Code-unit order is locale-independent, so every deployment hashes the
  // same descriptor identically regardless of its host's ICU configuration.
  return left < right ? -1 : 1;
}
