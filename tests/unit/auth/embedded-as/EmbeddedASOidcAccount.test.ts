import { describe, expect, it } from '@jest/globals';

import { EmbeddedASOidcAccount } from '../../../../src/auth/embedded-as/EmbeddedASOidcAccount.js';
import { ADMIN_STEP_UP_CLAIMS_MODEL } from '../../../../src/auth/embedded-as/InteractionRouter.js';
import type { IAuthMethod } from '../../../../src/auth/embedded-as/IAuthMethod.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';

describe('EmbeddedASOidcAccount', () => {
  it('emits AS-issued administrative ACR, AMR, and fresh auth_time for the matching grant', async () => {
    const storage = await storageWithAdmin();
    await storage.genericSet(ADMIN_STEP_UP_CLAIMS_MODEL, 'grant-admin', {
      accountId: 'local_admin',
      acr: 'urn:dollhouse:acr:admin-stepup',
      amr: ['otp'],
      authTime: 1779883200,
    });
    const account = new EmbeddedASOidcAccount([] satisfies IAuthMethod[], storage);

    await expect(account.extraTokenClaims({}, { accountId: 'local_admin', grantId: 'grant-admin' }))
      .resolves.toMatchObject({
        acr: 'urn:dollhouse:acr:admin-stepup',
        amr: ['otp'],
        auth_time: 1779883200,
      });
    await expect(account.extraTokenClaims({}, { accountId: 'local_admin', grantId: 'grant-admin' }))
      .resolves.toEqual({ auth_time: 0 });
  });

  it('does not attach administrative claims from a grant bound to a different account', async () => {
    const storage = await storageWithAdmin();
    await storage.genericSet(ADMIN_STEP_UP_CLAIMS_MODEL, 'grant-other', {
      accountId: 'local_other',
      acr: 'urn:dollhouse:acr:admin-stepup',
      amr: ['otp'],
      authTime: 1779883200,
    });
    const account = new EmbeddedASOidcAccount([] satisfies IAuthMethod[], storage);

    await expect(account.extraTokenClaims({}, { accountId: 'local_admin', grantId: 'grant-other' }))
      .resolves.toEqual({ auth_time: 0 });
  });

  it('ignores missing, malformed, and expired administrative grant claims', async () => {
    const storage = await storageWithAdmin();
    await storage.genericSet(ADMIN_STEP_UP_CLAIMS_MODEL, 'grant-malformed', {
      accountId: 'local_admin',
      acr: 'not-admin',
      amr: ['otp'],
      authTime: 1779883200,
    });
    await storage.genericSet(ADMIN_STEP_UP_CLAIMS_MODEL, 'grant-expired', {
      accountId: 'local_admin',
      acr: 'urn:dollhouse:acr:admin-stepup',
      amr: ['otp'],
      authTime: 1779883200,
    }, -1);
    const account = new EmbeddedASOidcAccount([] satisfies IAuthMethod[], storage);

    await expect(account.extraTokenClaims({}, { accountId: 'local_admin' }))
      .resolves.toEqual({ auth_time: 0 });
    await expect(account.extraTokenClaims({}, { accountId: 'local_admin', grantId: 'grant-malformed' }))
      .resolves.toEqual({ auth_time: 0 });
    await expect(account.extraTokenClaims({}, { accountId: 'local_admin', grantId: 'grant-expired' }))
      .resolves.toEqual({ auth_time: 0 });
  });
});

async function storageWithAdmin(): Promise<InMemoryAuthStorageLayer> {
  const storage = new InMemoryAuthStorageLayer();
  await storage.upsertAccount({
    sub: 'local_admin',
    provider: 'local',
    externalSub: 'admin',
    emailVerified: true,
    createdAt: 1,
    updatedAt: 1,
    lastAuthAt: 1,
  });
  return storage;
}
