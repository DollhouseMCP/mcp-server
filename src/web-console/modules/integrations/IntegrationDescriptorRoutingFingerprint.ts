import { createHash } from 'node:crypto';

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
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
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
  return `{${Object.keys(record).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
