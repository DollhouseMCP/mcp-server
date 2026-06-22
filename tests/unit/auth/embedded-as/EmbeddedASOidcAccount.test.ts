import { describe, expect, it } from '@jest/globals';

import { EmbeddedASOidcAccount } from '../../../../src/auth/embedded-as/EmbeddedASOidcAccount.js';
import { ADMIN_STEP_UP_CLAIMS_MODEL } from '../../../../src/auth/embedded-as/InteractionRouter.js';
import type { IAuthMethod } from '../../../../src/auth/embedded-as/IAuthMethod.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';

const ADMIN_STEPUP_ACR = 'urn:dollhouse:acr:admin-stepup';

describe('EmbeddedASOidcAccount', () => {
  it('emits AS-issued administrative ACR, AMR, and fresh auth_time for the matching grant', async () => {
    const storage = await storageWithAdmin();
    await storage.genericSet(ADMIN_STEP_UP_CLAIMS_MODEL, 'grant-admin', {
      accountId: 'local_admin',
      acr: ADMIN_STEPUP_ACR,
      amr: ['otp'],
      authTime: 1779883200,
    });
    const account = new EmbeddedASOidcAccount([] satisfies IAuthMethod[], storage);

    await expect(account.extraTokenClaims({}, { accountId: 'local_admin', grantId: 'grant-admin' }))
      .resolves.toMatchObject({
        acr: ADMIN_STEPUP_ACR,
        amr: ['otp'],
        auth_time: 1779883200,
      });
    // extraTokenClaims runs once per token (access_token AND id_token) of a
    // single issuance, so a repeated call for the same grant must STILL emit
    // the admin claims — otherwise the id_token (issued second) would lack
    // acr/amr and the BFF would reject the step-up.
    await expect(account.extraTokenClaims({}, { accountId: 'local_admin', grantId: 'grant-admin' }))
      .resolves.toMatchObject({
        acr: ADMIN_STEPUP_ACR,
        amr: ['otp'],
        auth_time: 1779883200,
      });
  });

  it('does not attach administrative claims from a grant bound to a different account', async () => {
    const storage = await storageWithAdmin();
    await storage.genericSet(ADMIN_STEP_UP_CLAIMS_MODEL, 'grant-other', {
      accountId: 'local_other',
      acr: ADMIN_STEPUP_ACR,
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
      acr: ADMIN_STEPUP_ACR,
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
