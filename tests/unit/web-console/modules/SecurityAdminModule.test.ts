import { describe, expect, it } from '@jest/globals';

import { InMemorySigningKeyStore } from '../../../../src/storage/signingKeys/InMemorySigningKeyStore.js';
import { InMemoryConsoleAuthPolicyStore } from '../../../../src/web-console/stores/InMemoryConsoleAuthPolicyStore.js';
import { InMemoryConsoleFactorStore } from '../../../../src/web-console/stores/InMemoryConsoleFactorStore.js';
import { InMemoryConsoleSecurityInvalidationStore } from '../../../../src/web-console/services/invalidation/InMemoryConsoleSecurityInvalidationStore.js';
import {
  createSecurityAdminModule,
  projectSecurityAuthPolicy,
  projectSecuritySigningKeyJob,
  projectSecuritySigningKeyKind,
  projectSecuritySigningKeyList,
  projectSecurityTotpReset,
  type ConsoleRouteDefinition,
} from '../../../../src/web-console/index.js';

const NOW = new Date('2026-05-29T12:00:00.000Z');
const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fa1';
const ACTOR_ID = '018f3d47-73ae-7f10-a0de-0742618d4fa2';
const SECURITY_CAPABILITY = 'console:admin:security';
const SECURITY_PRIVACY = 'security_metadata';
const MUST_NOT_LEAK = 'must-not-leak';

async function createStores() {
  const signingKeyStore = new InMemorySigningKeyStore();
  await signingKeyStore.rotate({
    kind: 'jwks',
    kid: 'jwks-old',
    payload: { d: MUST_NOT_LEAK, private: MUST_NOT_LEAK },
  });
  const factorStore = new InMemoryConsoleFactorStore();
  const invalidationStore = new InMemoryConsoleSecurityInvalidationStore();
  const authPolicyStore = new InMemoryConsoleAuthPolicyStore();
  return { signingKeyStore, factorStore, invalidationStore, authPolicyStore };
}

async function createModule() {
  const stores = await createStores();
  return {
    ...stores,
    module: createSecurityAdminModule({
      ...stores,
      now: () => NOW,
    }),
  };
}

function findRoute(routes: readonly ConsoleRouteDefinition[], method: string, path: string): ConsoleRouteDefinition {
  const route = routes.find(candidate => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

describe('SecurityAdminModule', () => {
  it('declares security-admin descriptors with freshness, idempotency, and audit policy', async () => {
    const { module } = await createModule();

    expect(module).toMatchObject({
      id: 'security-admin',
      apiVersion: 'v1',
      capabilities: [SECURITY_CAPABILITY],
    });
    expect(module.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'GET',
        path: '/api/v1/admin/security/signing-keys',
        requiredCapability: SECURITY_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: SECURITY_PRIVACY,
        idempotency: 'not_applicable',
        auditOperation: 'security.signing_keys.list',
      }),
      expect.objectContaining({
        method: 'POST',
        path: '/api/v1/admin/security/signing-keys/:kind/rotate',
        elevation: 'admin_5m',
        idempotency: 'required',
        auditOperation: 'security.signing_keys.rotate',
      }),
      expect.objectContaining({
        method: 'PUT',
        path: '/api/v1/admin/security/auth-policy',
        elevation: 'admin_5m',
        idempotency: 'required',
        auditOperation: 'security.auth_policy.update',
      }),
      expect.objectContaining({
        method: 'POST',
        path: '/api/v1/admin/security/users/:user_id/factors/totp/reset',
        elevation: 'admin_5m',
        idempotency: 'required',
        auditOperation: 'security.users.totp.reset',
      }),
    ]));
    expect(module.auditOperations).toEqual(expect.arrayContaining([
      { id: 'security.signing_keys.list' },
      { id: 'security.signing_keys.show' },
      { id: 'security.signing_keys.rotate' },
      { id: 'security.signing_keys.retire' },
      { id: 'security.signing_keys.delete' },
      { id: 'security.signing_keys.jobs.show' },
      { id: 'security.auth_policy.show' },
      { id: 'security.auth_policy.update' },
      { id: 'security.users.totp.reset' },
    ]));
  });

  it('lists signing keys as metadata only and drops private material in the projector', async () => {
    const { module } = await createModule();
    const route = findRoute(module.routes, 'GET', '/api/v1/admin/security/signing-keys');

    const result = await route.handler({ query: {}, params: {} } as never);
    const projected = projectSecuritySigningKeyList(result.body);

    expect(projected.kinds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'jwks',
        active_kid: 'jwks-old',
        keys: [expect.objectContaining({ kid: 'jwks-old', state: 'active' })],
      }),
    ]));
    expect(JSON.stringify(projected)).not.toContain(MUST_NOT_LEAK);
    expect(projectSecuritySigningKeyKind({
      kind: 'jwks',
      active_kid: 'kid',
      keys: [{ kind: 'jwks', kid: 'kid', state: 'active', payload: { d: MUST_NOT_LEAK } }],
      secret: MUST_NOT_LEAK,
    })).toEqual({
      kind: 'jwks',
      active_kid: 'kid',
      keys: [expect.objectContaining({ kid: 'kid', state: 'active' })],
    });
  });

  it('rotates signing keys, exposes a job, and never returns generated secret bytes', async () => {
    const { module, signingKeyStore } = await createModule();
    const rotateRoute = findRoute(module.routes, 'POST', '/api/v1/admin/security/signing-keys/:kind/rotate');
    const jobRoute = findRoute(module.routes, 'GET', '/api/v1/admin/security/signing-keys/jobs/:id');

    const result = await rotateRoute.handler({ query: {}, params: { kind: 'cookie' } } as never);
    const job = projectSecuritySigningKeyJob(result.body);
    const jobResult = await jobRoute.handler({ query: {}, params: { id: job.id } } as never);

    expect(result.status).toBe(202);
    expect(job).toMatchObject({ kind: 'cookie', action: 'rotate', status: 'completed' });
    expect(projectSecuritySigningKeyJob(jobResult.body)).toEqual(job);
    expect(JSON.stringify(result.body)).not.toContain('secret');
    expect(JSON.stringify(await signingKeyStore.getActive('cookie'))).toContain('secret');
    expect(JSON.stringify(projectSecuritySigningKeyList((await findRoute(
      module.routes,
      'GET',
      '/api/v1/admin/security/signing-keys',
    ).handler({ query: {}, params: {} } as never)).body))).not.toContain('secret');
  });

  it('rotates jwks using the AS keypair payload shape', async () => {
    const { module, signingKeyStore } = await createModule();
    const rotateRoute = findRoute(module.routes, 'POST', '/api/v1/admin/security/signing-keys/:kind/rotate');

    const result = await rotateRoute.handler({ query: {}, params: { kind: 'jwks' } } as never);
    const job = projectSecuritySigningKeyJob(result.body);
    const active = await signingKeyStore.getActive('jwks');

    expect(job.result_kid).toBe(active?.kid);
    expect(active?.payload).toEqual(expect.objectContaining({
      kid: active?.kid,
      privateKey: expect.objectContaining({ kid: active?.kid, alg: 'ES256' }),
      publicKey: expect.objectContaining({ kid: active?.kid, alg: 'ES256', use: 'sig' }),
      generatedAt: expect.any(String),
    }));
  });

  it('persists signing-key retire/delete state through the store and enforces lifecycle guards', async () => {
    const { module, signingKeyStore } = await createModule();
    const rotateRoute = findRoute(module.routes, 'POST', '/api/v1/admin/security/signing-keys/:kind/rotate');
    const retireRoute = findRoute(module.routes, 'POST', '/api/v1/admin/security/signing-keys/:kind/:kid/retire');
    const deleteRoute = findRoute(module.routes, 'DELETE', '/api/v1/admin/security/signing-keys/:kind/:kid');
    const rotated = projectSecuritySigningKeyJob((await rotateRoute.handler({
      query: {},
      params: { kind: 'invite' },
    } as never)).body);
    const kid = rotated.result_kid ?? '';

    await expect(deleteRoute.handler({
      query: {},
      params: { kind: 'invite', kid },
      body: {},
    } as never)).resolves.toMatchObject({ status: 409, body: { code: 'conflict' } });

    const retired = await retireRoute.handler({ query: {}, params: { kind: 'invite', kid } } as never);
    expect(projectSecuritySigningKeyJob(retired.body)).toMatchObject({ action: 'retire', target_kid: kid });
    await expect(signingKeyStore.getActive('invite')).resolves.toBeNull();
    await expect(signingKeyStore.getByKid(kid)).resolves.toMatchObject({ retiredAt: NOW.getTime(), active: false });

    await expect(deleteRoute.handler({
      query: {},
      params: { kind: 'invite', kid },
      body: {},
    } as never)).resolves.toMatchObject({ status: 409, body: { code: 'conflict' } });

    await expect(deleteRoute.handler({
      query: {},
      params: { kind: 'invite', kid },
      body: { emergency: true },
    } as never)).resolves.toMatchObject({ status: 202 });
    await expect(signingKeyStore.getByKid(kid)).resolves.toBeNull();
  });

  it('enforces auth policy invariants and If-Match', async () => {
    const { module } = await createModule();
    const getRoute = findRoute(module.routes, 'GET', '/api/v1/admin/security/auth-policy');
    const putRoute = findRoute(module.routes, 'PUT', '/api/v1/admin/security/auth-policy');
    const before = await getRoute.handler({ query: {}, params: {} } as never);
    const etag = projectSecurityAuthPolicy(before.body).etag;

    await expect(putRoute.handler({
      query: {},
      params: {},
      headers: {},
      body: { max_admin_elevation_seconds: 120 },
    } as never)).resolves.toMatchObject({ status: 428, body: { code: 'precondition_required' } });
    await expect(putRoute.handler({
      query: {},
      params: {},
      headers: { 'if-match': 'W/"stale"' },
      body: { max_admin_elevation_seconds: 120 },
    } as never)).resolves.toMatchObject({ status: 412, body: { code: 'precondition_failed' } });
    for (const invariant of [
      'require_admin_totp',
      'csrf_protection',
      'bff_session_security',
      'step_up_required',
      'privacy_boundaries_enforced',
    ]) {
      await expect(putRoute.handler({
        query: {},
        params: {},
        headers: { 'if-match': etag },
        body: { [invariant]: false },
      } as never)).resolves.toMatchObject({ status: 422, body: { code: 'validation_failed' } });
    }

    const updated = await putRoute.handler({
      query: {},
      params: {},
      headers: { 'if-match': etag },
      body: { max_admin_elevation_seconds: 120 },
    } as never);
    expect(projectSecurityAuthPolicy(updated.body)).toMatchObject({
      require_admin_totp: true,
      csrf_protection: true,
      bff_session_security: true,
      step_up_required: true,
      privacy_boundaries_enforced: true,
      max_admin_elevation_seconds: 120,
    });
  });

  it('resets active TOTP metadata only and appends an elevation invalidation event', async () => {
    const { module, factorStore, invalidationStore } = await createModule();
    await factorStore.createTotpFactor({
      userId: USER_ID,
      factorId: '018f3d47-73ae-7f10-a0de-0742618d4fb1',
      factorType: 'totp',
      secretCiphertext: Buffer.from('encrypted-totp-seed'),
      enrolledAt: new Date('2026-05-29T11:00:00.000Z'),
      disabledAt: null,
      lastUsedAt: null,
    }, [Buffer.alloc(32, 9)]);
    const route = findRoute(module.routes, 'POST', '/api/v1/admin/security/users/:user_id/factors/totp/reset');

    const result = await route.handler({
      query: {},
      params: { user_id: USER_ID },
      consoleAuthentication: { userId: ACTOR_ID },
    } as never);
    const projected = projectSecurityTotpReset(result.body);

    expect(projected).toMatchObject({
      user_id: USER_ID,
      factor_disabled: true,
      elevation_revocation: { status: 'queued' },
      reset_at: NOW.toISOString(),
    });
    expect(JSON.stringify(projected)).not.toContain('encrypted-totp-seed');
    await expect(factorStore.getTotpStatus(USER_ID)).resolves.toMatchObject({ enrolled: false });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([
      expect.objectContaining({
        kind: 'admin_factor_disabled',
        userId: USER_ID,
        createdByUserId: ACTOR_ID,
      }),
    ]);
  });

  it('returns TOTP reset not-required metadata when no active factor exists', async () => {
    const { module, invalidationStore } = await createModule();
    const route = findRoute(module.routes, 'POST', '/api/v1/admin/security/users/:user_id/factors/totp/reset');

    const result = await route.handler({
      query: {},
      params: { user_id: USER_ID },
      consoleAuthentication: { userId: ACTOR_ID },
    } as never);

    expect(projectSecurityTotpReset(result.body)).toEqual({
      user_id: USER_ID,
      factor_disabled: false,
      elevation_revocation: { event_id: null, status: 'not_required' },
      reset_at: NOW.toISOString(),
    });
    await expect(invalidationStore.listEventsAfter(0)).resolves.toEqual([]);
  });
});
