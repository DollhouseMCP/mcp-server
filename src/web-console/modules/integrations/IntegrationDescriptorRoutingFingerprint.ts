import { hkdfSync } from 'node:crypto';

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
    // A logical revision changes when the OAuth secret changes. The encrypted
    // envelope and its key metadata may change during an at-rest key rewrap
    // without changing where or how credentials are obtained.
    clientSecretRevision: descriptor.clientSecretRevision,
  };
  // This is deterministic change detection over configuration, not a password
  // verifier. HKDF keeps the descriptor UUID as a public per-record salt and
  // avoids treating any literal as a credential or secret key.
  return Buffer.from(hkdfSync(
    'sha256',
    canonicalJson(payload),
    descriptor.id,
    Buffer.alloc(0),
    32,
  )).toString('hex');
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    const encoded = stringifyJsonValue(value);
    if (encoded === undefined) throw new TypeError('descriptor routing values must be JSON-compatible');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort(compareCanonicalJsonKeys)
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function stringifyJsonValue(value: unknown): string | undefined {
  // TypeScript's JSON.stringify declaration returns `string`, but the runtime
  // returns undefined for values such as symbols and functions.
  return JSON.stringify(value);
}

function compareCanonicalJsonKeys(left: string, right: string): number {
  if (left === right) return 0;
  // Code-unit order is locale-independent, so every deployment hashes the
  // same descriptor identically regardless of its host's ICU configuration.
  return left < right ? -1 : 1;
}
