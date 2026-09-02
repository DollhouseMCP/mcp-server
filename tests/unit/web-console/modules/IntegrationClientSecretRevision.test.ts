import { describe, expect, it } from '@jest/globals';

import { deriveIntegrationClientSecretRevision } from '../../../../src/web-console/modules/integrations/IntegrationClientSecretRevision.js';
import { HmacConsoleOpaqueValueService } from '../../../../src/web-console/security/ConsoleOpaqueValues.js';

describe('deriveIntegrationClientSecretRevision', () => {
  const hasher = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 19));
  const clientSecret = 'client-secret';

  it('is stable for the same provider and secret', () => {
    expect(deriveIntegrationClientSecretRevision(hasher, 'examplecorp', clientSecret))
      .toBe(deriveIntegrationClientSecretRevision(hasher, 'examplecorp', clientSecret));
  });

  it('changes when the provider or secret changes', () => {
    const revision = deriveIntegrationClientSecretRevision(hasher, 'examplecorp', clientSecret);
    expect(deriveIntegrationClientSecretRevision(hasher, 'examplecorp', 'rotated-secret'))
      .not.toBe(revision);
    expect(deriveIntegrationClientSecretRevision(hasher, 'othercorp', clientSecret))
      .not.toBe(revision);
  });

  it('returns an application-defined UUIDv8 rather than a secret digest', () => {
    expect(deriveIntegrationClientSecretRevision(hasher, 'examplecorp', clientSecret))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
