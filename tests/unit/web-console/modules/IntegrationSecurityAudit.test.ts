import { describe, expect, it } from '@jest/globals';

import { safeIntegrationAuditProvider } from '../../../../src/web-console/modules/integrations/IntegrationSecurityAudit.js';

describe('safeIntegrationAuditProvider', () => {
  it.each([
    'ab',
    'github',
    'provider_name-1',
    `a${'b_'.repeat(31)}c`,
  ])('retains a valid production provider id: %s', provider => {
    expect(safeIntegrationAuditProvider(provider)).toBe(provider);
  });

  it.each([
    '1sk_live_sometoken',
    'gho_sensitive-value',
    'sk_live_1234567890',
    'xoxb-1234567890-abcdef',
    'glpat-abcdef123456',
    'opaquecredentialvalue1234567890',
    'a',
    '-github',
    'GitHub',
    'github.example',
    'github\u200B',
    `a${'b_'.repeat(32)}c`,
  ])('replaces malformed or credential-shaped provider input: %s', provider => {
    expect(safeIntegrationAuditProvider(provider)).toBe('<invalid>');
  });
});
