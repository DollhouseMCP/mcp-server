/** Owned cookie fixture: no login, OIDC, allowlist admission or replacement qualification claim. */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AuthenticatedFixture, CompiledMemoryRuntime } from './authenticated-memory-runtime.js';

export const UNPROVED_CONSOLE_READINESS_CHECKS = [
  'production_database_migrations', 'security_invalidation_multi_replica', 'allowlist_authority_parity',
  'embedded_as_login_step_up', 'account_invite_redemption', 'oauth_grant_revocation',
  'github_integration_connect_callback', 'portfolio_sync_live_repository',
  'signing_key_auth_policy_multi_replica', 'approval_execution_projection', 'audit_telemetry_projection',
] as const;

async function ownedPort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Owned loopback port unavailable'))); return;
      }
      server.close(cause => cause ? reject(cause) : resolve(address.port));
    });
  });
}
export interface OwnedConsole {
  runtime: CompiledMemoryRuntime;
  base: string;
  forge: (userId: string, subject: string, options?: { capabilities?: string[]; expired?: boolean }) => Promise<{
    cookie: string; csrf: string;
  }>;
}
export async function consoleRuntime(fixture: AuthenticatedFixture): Promise<OwnedConsole> {
  const port = await ownedPort(), base = `http://127.0.0.1:${port}`;
  const evidencePath = path.join(fixture.directory, `fixture-external-readiness-${randomUUID()}.json`);
  await writeFile(evidencePath, JSON.stringify({
    phase: 'pre-replacement',
    composition: { activationProfile: 'shared-hosted', storageBackend: 'postgres', apiV1MountCreated: true,
      routesMounted: false, registeredRouteModuleIds: ['auth', 'health', 'accountAdmin', 'activations', 'approvals',
        'audit', 'executions', 'integrations', 'me-logs', 'operations', 'portfolio', 'runtimeSessions', 'security-admin',
        'selfSecurity', 'selfService', 'session-telemetry'] },
    liveChecks: UNPROVED_CONSOLE_READINESS_CHECKS.map(id => ({ id, ready: true,
      detail: 'OWNED FIXTURE ASSERTION for console mount only; this external readiness check is NOT executed or proved by this test.' })),
  }), { mode: 0o600 });
  const b64 = () => randomBytes(32).toString('base64'), hex = () => randomBytes(32).toString('hex');
  const opaqueKey = b64();
  const runtime = fixture.spawnConsole({
    NODE_ENV: 'development', DOLLHOUSE_UNSAFE_NO_TLS: 'true', DOLLHOUSE_HTTP_HOST: '127.0.0.1',
    DOLLHOUSE_HTTP_PORT: String(port), DOLLHOUSE_PUBLIC_BASE_URL: base,
    DOLLHOUSE_HTTP_ALLOWED_HOSTS: 'localhost,127.0.0.1', DOLLHOUSE_TRUSTED_PROXIES: 'loopback',
    DOLLHOUSE_AUTH_ENABLED: 'true', DOLLHOUSE_AUTH_PROVIDER: 'embedded', DOLLHOUSE_AUTH_METHODS: 'local-password',
    DOLLHOUSE_AUTH_STORAGE_BACKEND: 'postgres', DOLLHOUSE_AUTH_OPEN_DCR: 'true',
    DOLLHOUSE_RATE_LIMIT_BACKEND: 'postgres', DOLLHOUSE_HTTP_WEB_CONSOLE: 'false', DOLLHOUSE_WEB_AUTH_ENABLED: 'false',
    DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED: 'true', DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE: evidencePath,
    DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_NAME: new URL(fixture.f.runtime.appUrl).pathname.slice(1),
    DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_USER: fixture.f.roleName,
    DOLLHOUSE_WEB_CONSOLE_PORTFOLIO_WRITE_ROUTES_ENABLED: 'true', DOLLHOUSE_WEB_CONSOLE_OPAQUE_HMAC_KEY: opaqueKey,
    DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY: b64(), DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY_ID: 'owned-auth-proof-v1',
    DOLLHOUSE_WEB_CONSOLE_PROTECTED_CORRELATION_HMAC_KEY: b64(), DOLLHOUSE_COOKIE_SIGNING_SECRET: hex(),
    DOLLHOUSE_INVITE_TOKEN_SECRET: hex(), DOLLHOUSE_SECURITY_MODE: 'strict',
  }, port);
  await runtime.ready();
  if (runtime.url !== `${base}/mcp`) throw new Error('Actual child listen does not match the selected owned loopback port');
  return { runtime, base, forge: async (userId, subject, options = {}) => {
    const session = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
    const hash = (value: string) => createHmac('sha256', Buffer.from(opaqueKey, 'base64')).update(value, 'utf8').digest();
    const clock = Date.now();
    const now = new Date(clock - (options.expired ? 7200000 : 0)).toISOString();
    const expiry = new Date(clock + (options.expired ? -1000 : 3600000)).toISOString();
    const sql = fixture.f.maintenance;
    await sql`INSERT INTO public.console_sessions(id_hash,user_id,auth_sub,csrf_token_hash,
      granted_capabilities,elevated_capabilities,created_at,last_used_at,idle_expires_at,absolute_expires_at)
      VALUES(${hash(session)},${userId}::uuid,${subject},${hash(csrf)},
        ${sql.array(options.capabilities ?? ['console:self'])},${sql.array([])},${now}::timestamptz,${now}::timestamptz,${expiry}::timestamptz,${expiry}::timestamptz)`;
    return { cookie: `dh_session=${session}; dh_csrf=${csrf}`, csrf };
  } };
}
