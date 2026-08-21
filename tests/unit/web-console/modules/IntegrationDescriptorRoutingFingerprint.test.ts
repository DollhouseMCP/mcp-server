import { describe, expect, it } from '@jest/globals';

import type { IntegrationDescriptorRecord } from '../../../../src/web-console/stores/IIntegrationDescriptorStore.js';
import { integrationDescriptorRoutingFingerprint } from '../../../../src/web-console/modules/integrations/IntegrationDescriptorRoutingFingerprint.js';

const NOW = new Date('2026-08-19T12:00:00.000Z');
const ROUTING_CHANGES: ReadonlyArray<readonly [string, Partial<IntegrationDescriptorRecord>]> = [
  ['API hosts', { apiHosts: ['mail.example.com'] }],
  ['OAuth configuration', {
    oauth: { ...descriptor().oauth!, tokenUrl: 'https://accounts.example/oauth/v2/token' },
  }],
  ['operation promotion', { operationPromotion: { enabled: ['messages.send'] } }],
  ['client secret revision', { clientSecretRevision: '00000000-0000-4000-8000-000000000202' }],
];

function descriptor(overrides: Partial<IntegrationDescriptorRecord> = {}): IntegrationDescriptorRecord {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    provider: 'gmail',
    ownership: 'curated',
    ownerUserId: null,
    displayName: 'Gmail',
    category: 'Email',
    authStrategy: 'oauth2_authorization_code',
    apiHosts: ['gmail.googleapis.com'],
    oauth: {
      clientId: 'gmail-client-id',
      authorizationUrl: 'https://accounts.example/oauth/authorize',
      tokenUrl: 'https://accounts.example/oauth/token',
      scopes: ['gmail.readonly'],
      pkce: 'required',
      refresh: 'rotating',
      tokenExchange: { clientAuth: 'body', style: 'form' },
      accountLabel: { field: 'email' },
    },
    staticApiKey: null,
    clientSecretCiphertext: Buffer.from('encrypted-client-secret'),
    clientSecretRevision: '00000000-0000-4000-8000-000000000201',
    credentialKeyVersion: 'integration-key-v1',
    operationPromotion: { enabled: ['messages.list'] },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('integrationDescriptorRoutingFingerprint', () => {
  it('ignores display-only edits and JSON object insertion order', () => {
    const original = descriptor();
    const displayEdit = descriptor({
      displayName: 'Google Mail',
      category: 'Communication',
      updatedAt: new Date('2026-08-19T12:05:00.000Z'),
      oauth: original.oauth ? {
        ...original.oauth,
        tokenExchange: { style: 'form', clientAuth: 'body' },
      } : null,
    });

    expect(integrationDescriptorRoutingFingerprint(displayEdit))
      .toBe(integrationDescriptorRoutingFingerprint(original));
  });

  it.each(ROUTING_CHANGES)('changes when %s changes', (_label, overrides) => {
    expect(integrationDescriptorRoutingFingerprint(descriptor(overrides)))
      .not.toBe(integrationDescriptorRoutingFingerprint(descriptor()));
  });

  it('ignores at-rest ciphertext and encryption-key rewraps', () => {
    const rewrapped = descriptor({
      clientSecretCiphertext: Buffer.from('different-randomized-envelope'),
      credentialKeyVersion: 'integration-key-v2',
    });

    expect(integrationDescriptorRoutingFingerprint(rewrapped))
      .toBe(integrationDescriptorRoutingFingerprint(descriptor()));
  });
});
