/**
 * Global setup for the web-console e2e suite. Self-contained on purpose: jest
 * loads globalSetup outside its module registry, so it can only import node
 * builtins + npm packages (no local `.ts` modules / no `.js`→`.ts` mapping).
 *
 * Two modes:
 *  - Auto-boot (default): provision an isolated DB + role, run migrations,
 *    generate ephemeral secrets + readiness evidence, boot the app, wait for
 *    health. Distinct port (3101) + database from the manual run-smoke setup.
 *  - Attach (E2E_NO_BOOT=1): target an already-running instance; the caller
 *    exports E2E_BASE_URL / E2E_DATABASE_ADMIN_URL / E2E_OPAQUE_HMAC_KEY.
 */
import { spawn, execFile } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import postgres from 'postgres';

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.E2E_PORT ?? 3101);
const HOST = '127.0.0.1';
const BASE_URL = `http://localhost:${PORT}`;
const DB_NAME = process.env.E2E_DB_NAME ?? 'dollhousemcp_console_e2e';
const APP_ROLE = 'dollhouse_app';
const APP_PASSWORD = process.env.E2E_APP_PASSWORD ?? 'dollhouse_app_local';
const SUPERUSER_TEMPLATE = process.env.E2E_PG_SUPERUSER_URL ?? 'postgres://dollhouse:dollhouse@localhost:5432/postgres';

function superuserUrlFor(database: string): string {
  const url = new URL(SUPERUSER_TEMPLATE);
  url.pathname = `/${database}`;
  return url.toString();
}
function appDatabaseUrl(): string {
  const url = new URL(SUPERUSER_TEMPLATE);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  url.pathname = `/${DB_NAME}`;
  return url.toString();
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`[console-e2e] app at ${baseUrl} did not become healthy in ${timeoutMs}ms: ${String(lastErr)}`);
}

async function provisionDatabase(): Promise<void> {
  const admin = postgres(superuserUrlFor('postgres'), { ssl: false, max: 1, onnotice: () => {} });
  try {
    const role = (await admin`SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}`).at(0);
    const verb = role ? 'ALTER' : 'CREATE';
    await admin.unsafe(`${verb} ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOBYPASSRLS`);
    const database = (await admin`SELECT 1 FROM pg_database WHERE datname = ${DB_NAME}`).at(0);
    if (!database) await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  const onDb = postgres(superuserUrlFor(DB_NAME), { ssl: false, max: 1, onnotice: () => {} });
  try {
    await onDb.unsafe(`GRANT ALL ON DATABASE ${DB_NAME} TO ${APP_ROLE}`);
    await onDb.unsafe(`GRANT ALL ON SCHEMA public TO ${APP_ROLE}`);
  } finally {
    await onDb.end({ timeout: 5 });
  }

  // drizzle.config.ts reads DOLLHOUSE_DATABASE_ADMIN_URL for the migrate target.
  const { stdout, stderr } = await execFileAsync('npx', ['drizzle-kit', 'migrate'], {
    env: { ...process.env, DOLLHOUSE_DATABASE_ADMIN_URL: superuserUrlFor(DB_NAME) },
    cwd: process.cwd(),
    maxBuffer: 32 * 1024 * 1024,
  });
  if (process.env.E2E_DEBUG) {
    console.log('[console-e2e] migrate:', { stdout, stderr });
  }

  await applyAppGrants();
}

/**
 * Replicate docker/init-db.sql: grant the app role DML (only) on all tables +
 * sequences, set default privileges for future objects, and keep `users`
 * write-protected. Run AFTER migrations so the tables exist. Without this, the
 * NOBYPASSRLS app role has zero table privileges and information_schema hides
 * every table from it — which the production readiness verifier (correctly)
 * reads as "migrations incomplete".
 */
async function applyAppGrants(): Promise<void> {
  const onDb = postgres(superuserUrlFor(DB_NAME), { ssl: false, max: 1, onnotice: () => {} });
  try {
    await onDb.unsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await onDb.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
    await onDb.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
    await onDb.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`);
    await onDb.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}`);
    // Identity writes go through the admin role only (RLS + structural deny).
    await onDb.unsafe(`REVOKE INSERT, UPDATE, DELETE ON TABLE users FROM ${APP_ROLE}`);
    // Read-only access to the migration-tracking schema.
    await onDb.unsafe(`GRANT USAGE ON SCHEMA drizzle TO ${APP_ROLE}`).catch(() => {});
    await onDb.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO ${APP_ROLE}`).catch(() => {});
  } finally {
    await onDb.end({ timeout: 5 });
  }
}

function readinessEvidence(): unknown {
  const ids = [
    'production_database_migrations', 'security_invalidation_multi_replica', 'allowlist_authority_parity',
    'embedded_as_login_step_up', 'account_invite_redemption', 'oauth_grant_revocation',
    'github_integration_connect_callback', 'portfolio_sync_live_repository',
    'signing_key_auth_policy_multi_replica', 'approval_execution_projection', 'audit_telemetry_projection',
  ];
  return {
    _note: 'e2e harness readiness evidence — all checks ready so the /api/v1 gate passes for the isolated test instance.',
    phase: 'pre-replacement',
    composition: {
      activationProfile: 'shared-hosted', storageBackend: 'postgres', apiV1MountCreated: true, routesMounted: false,
      registeredRouteModuleIds: [
        'auth', 'health', 'accountAdmin', 'activations', 'approvals', 'audit', 'executions', 'integrations',
        'me-logs', 'operations', 'portfolio', 'runtimeSessions', 'security-admin', 'selfSecurity', 'selfService',
        'session-telemetry',
      ],
    },
    liveChecks: ids.map(id => ({ id, ready: true, detail: 'e2e: verified by the harness setup.' })),
  };
}

function buildAppEnv(secrets: Record<string, string>, evidencePath: string, runDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'development',
    DOLLHOUSE_UNSAFE_NO_TLS: 'true',
    DOLLHOUSE_HTTP_HOST: HOST,
    DOLLHOUSE_HTTP_PORT: String(PORT),
    DOLLHOUSE_PUBLIC_BASE_URL: BASE_URL,
    DOLLHOUSE_HTTP_ALLOWED_HOSTS: 'localhost,127.0.0.1',
    DOLLHOUSE_TRUSTED_PROXIES: 'loopback',
    DOLLHOUSE_AUTH_ENABLED: 'true',
    DOLLHOUSE_AUTH_PROVIDER: 'embedded',
    DOLLHOUSE_AUTH_METHODS: 'local-password',
    DOLLHOUSE_AUTH_STORAGE_BACKEND: 'postgres',
    DOLLHOUSE_AUTH_OPEN_DCR: 'true',
    DOLLHOUSE_STORAGE_BACKEND: 'database',
    DOLLHOUSE_DATABASE_URL: appDatabaseUrl(),
    DOLLHOUSE_DATABASE_ADMIN_URL: superuserUrlFor(DB_NAME),
    DOLLHOUSE_DATABASE_SSL: 'disable',
    DOLLHOUSE_RATE_LIMIT_BACKEND: 'postgres',
    DOLLHOUSE_HTTP_WEB_CONSOLE: 'false',
    DOLLHOUSE_WEB_AUTH_ENABLED: 'false',
    DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED: 'true',
    DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE: evidencePath,
    DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_NAME: DB_NAME,
    DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_USER: APP_ROLE,
    DOLLHOUSE_WEB_CONSOLE_PORTFOLIO_WRITE_ROUTES_ENABLED: 'true',
    // Dummy GitHub integration creds so the connect flow builds a real redirect
    // (createAuthorizationUrl is offline — no network). Lets us exercise connect.
    DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_ID: 'e2e-integration-client',
    DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_SECRET: 'e2e-integration-secret',
    DOLLHOUSE_WEB_CONSOLE_OPAQUE_HMAC_KEY: secrets.opaqueHmacKey,
    DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY: secrets.secretEncryptionKey,
    DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY_ID: 'web-console-e2e-v1',
    DOLLHOUSE_WEB_CONSOLE_PROTECTED_CORRELATION_HMAC_KEY: secrets.protectedCorrelationHmacKey,
    DOLLHOUSE_COOKIE_SIGNING_SECRET: secrets.cookieSigningSecret,
    DOLLHOUSE_INVITE_TOKEN_SECRET: secrets.inviteTokenSecret,
    DOLLHOUSE_MASTER_ENCRYPTION_KEY: secrets.masterEncryptionKey,
    DOLLHOUSE_SECURITY_MODE: 'strict',
    DOLLHOUSE_RUN_DIR: `${runDir}/run`,
    DOLLHOUSE_PORTFOLIO_DIR: `${runDir}/portfolio`,
    DOLLHOUSE_CACHE_DIR: `${runDir}/cache`,
    DOLLHOUSE_LOG_DIR: `${runDir}/logs`,
  };
}

export default async function globalSetup(): Promise<void> {
  if (process.env.E2E_NO_BOOT === '1') {
    const baseUrl = (process.env.E2E_BASE_URL ?? BASE_URL).replace(/\/+$/, '');
    for (const name of ['E2E_DATABASE_ADMIN_URL', 'E2E_OPAQUE_HMAC_KEY']) {
      if (!process.env[name]) throw new Error(`[console-e2e] E2E_NO_BOOT=1 requires ${name} to be exported.`);
    }
    process.env.E2E_BASE_URL = baseUrl;
    await waitForHealth(baseUrl, 30000);
    return;
  }

  const root = process.cwd();
  const runDir = path.join(root, '.console-e2e');
  for (const d of ['cwd', 'run', 'portfolio', 'cache', 'logs']) mkdirSync(path.join(runDir, d), { recursive: true });

  await provisionDatabase();

  // WEB_CONSOLE_* keys + master key want base64 32-byte; cookie/invite secrets want hex.
  const b64 = () => randomBytes(32).toString('base64');
  const hex = () => randomBytes(32).toString('hex');
  const secrets = {
    opaqueHmacKey: b64(), secretEncryptionKey: b64(), protectedCorrelationHmacKey: b64(),
    masterEncryptionKey: b64(), cookieSigningSecret: hex(), inviteTokenSecret: hex(),
  };
  const evidencePath = path.join(runDir, 'replacement-readiness.json');
  writeFileSync(evidencePath, JSON.stringify(readinessEvidence(), null, 2));

  const logPath = path.join(runDir, 'logs', `app-${Date.now()}.log`);
  const logStream = createWriteStream(logPath, { flags: 'a' });
  const child = spawn('npx', ['tsx', path.join(root, 'src/index.ts'), '--streamable-http'], {
    cwd: path.join(runDir, 'cwd'),
    env: buildAppEnv(secrets, evidencePath, runDir),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  writeFileSync(path.join(runDir, 'app.pid'), String(child.pid));

  process.env.E2E_BASE_URL = BASE_URL;
  process.env.E2E_OPAQUE_HMAC_KEY = secrets.opaqueHmacKey;
  process.env.E2E_DATABASE_ADMIN_URL = superuserUrlFor(DB_NAME);

  try {
    await waitForHealth(BASE_URL, 90000);
  } catch (err) {
    if (child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
    throw new Error(`${String(err)}\n[console-e2e] app log: ${logPath}`);
  }
  console.log(`[console-e2e] app booted at ${BASE_URL} (logs: ${logPath})`);
}
