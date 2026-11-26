import { afterEach, expect, it, jest } from '@jest/globals';
import { InMemoryRateLimitStore } from '../../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import { DatabaseDangerZoneBlockStore } from '../../../../src/state/DatabaseDangerZoneBlockStore.js';
import { executeWithConsoleIdempotency, fingerprintBody } from '../../../../src/web-console/middleware/ConsoleIdempotency.js';
import { createSecurityAdminBlockRecoveryRoutes } from '../../../../src/web-console/modules/security-admin/SecurityAdminBlockRecovery.js';
import { CONSOLE_ADMIN_STEPUP_ACR, type ConsoleAuthenticatedContext, type ConsoleRequest } from '../../../../src/web-console/platform/ConsolePlatformTypes.js';
import { HmacConsoleOpaqueValueService } from '../../../../src/web-console/security/ConsoleOpaqueValues.js';
import { InMemoryIdempotencyStore } from '../../../../src/web-console/stores/InMemoryIdempotencyStore.js';
import { InMemoryAdminAuditWriter } from '../../../../src/web-console/audit/InMemoryAdminAuditWriter.js';

const admin = '0bf5f1d0-e412-41e7-9974-e15b1e85e3fa';
const selected = '566953be-e60e-43b8-9530-43a28704af89';
const bystander = '0b7a25fb-edd5-4e17-9db1-3f87d58ec160';
const now = new Date('2026-11-26T18:40:00Z');
const proof = '235711';
const digest = 'a'.repeat(64);
const actor: ConsoleAuthenticatedContext = {
  sessionIdHash: Buffer.alloc(32, 1), userId: admin, authSub: 'security-admin', authzVersion: 1,
  grantedCapabilities: ['console:admin:security'],
  elevation: {
    capabilities: ['console:admin:security'], expiresAt: new Date(now.getTime() + 180_000),
    acr: CONSOLE_ADMIN_STEPUP_ACR, amr: ['otp'], authTime: now,
  },
};

afterEach(() => jest.restoreAllMocks());

function request(userId = selected, authentication = actor): ConsoleRequest {
  return {
    params: { user_id: userId }, headers: {}, query: {}, get: () => undefined,
    originalUrl: `/api/v1/admin/security/users/${userId}/blocked-agents/reset`,
    consoleAuthentication: authentication, consoleContext: { correlationId: 'recovery-test', receivedAt: now },
  } as unknown as ConsoleRequest;
}

async function fixture() {
  jest.spyOn(DatabaseDangerZoneBlockStore.prototype, 'rejectedSnapshotDigest').mockResolvedValue(digest);
  const reset = jest.spyOn(DatabaseDangerZoneBlockStore.prototype, 'resetRejected').mockResolvedValue(true);
  const prove = jest.fn(async () => ({ ok: true as const, method: 'totp' as const, authTime: now }));
  const routes = createSecurityAdminBlockRecoveryRoutes({
    database: {} as never, auditKeys: {} as never, auditWriter: new InMemoryAdminAuditWriter(),
    opaqueValues: new HmacConsoleOpaqueValueService(Buffer.alloc(32, 7)),
    now: () => now, totp: { prove }, rateLimitStore: new InMemoryRateLimitStore(),
  });
  const [get, post] = routes;
  const preview = async () => (await get.handler(request())).body as {
    digest: string; expires_at: number; approval_tag: string; approval_id: string;
  };
  return { preview, post, reset, prove };
}

it('binds approval to the admin session, target and reviewed digest before verifying a code', async () => {
  const { preview, post, reset, prove } = await fixture();
  const { approval_id, digest: stateDigest, expires_at, approval_tag } = await preview();
  const binding = { digest: stateDigest, expires_at, approval_tag };
  const attempt = async (req: ConsoleRequest, digestOverride = binding.digest) => {
    req.headers['idempotency-key'] = approval_id;
    req.body = { ...binding, digest: digestOverride, proof };
    return (await post.handler(req)).status;
  };
  expect(await attempt(request(bystander))).toBe(409);
  expect(await attempt(request(selected, { ...actor, sessionIdHash: Buffer.alloc(32, 2) }))).toBe(409);
  expect(await attempt(request(), 'b'.repeat(64))).toBe(409);
  expect(prove).not.toHaveBeenCalled();
  expect(reset).not.toHaveBeenCalled();
  expect(await attempt(request())).toBe(204);
  expect(prove).toHaveBeenCalledWith(admin, proof);
  expect(reset).toHaveBeenCalledWith(digest, expect.any(Function));
});

it('spends a console approval once and omits the code from the fingerprint and stored response', async () => {
  const { preview, post, prove } = await fixture();
  const store = new InMemoryIdempotencyStore();
  const { approval_id, digest: stateDigest, expires_at, approval_tag } = await preview();
  const binding = { digest: stateDigest, expires_at, approval_tag };
  const submit = async (code: string) => {
    const req = request();
    req.headers['idempotency-key'] = approval_id;
    req.body = { ...binding, proof: code };
    return executeWithConsoleIdempotency(post, req, store, async () => await post.handler(req), now);
  };
  expect(await submit(proof)).toMatchObject({ kind: 'result', result: { status: 204 } });
  expect(await submit('419571')).toMatchObject({ kind: 'result', interceptedAuditResult: 'replayed', result: { status: 204 } });
  expect(prove).toHaveBeenCalledTimes(1);
  const record = await store.find(actor.sessionIdHash, approval_id, now);
  expect(record?.requestFingerprint).toEqual(fingerprintBody(binding));
  expect(record?.responseBodyPresent).toBe(false);
  expect(JSON.stringify(record)).not.toContain(proof);
});

it('rate limits one administrator across distinct approval requests', async () => {
  const { preview, post, prove } = await fixture();
  for (let index = 0; index < 6; index++) {
    const { approval_id, ...binding } = await preview();
    const req = request();
    req.headers['idempotency-key'] = approval_id;
    req.body = { ...binding, proof };
    expect((await post.handler(req)).status).toBe(index < 5 ? 204 : 429);
  }
  expect(prove).toHaveBeenCalledTimes(5);
});
