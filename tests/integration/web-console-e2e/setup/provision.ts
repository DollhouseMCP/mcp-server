/**
 * Importable provision + boot helpers, shared by the Playwright real-auth config.
 *
 * NOTE: the jest globalSetup (globalSetup.ts) intentionally inlines an equivalent
 * copy of this logic — jest loads globalSetup OUTSIDE its module registry, so it
 * cannot import local `.ts` modules. Keep the two in sync (same env-var contract,
 * same port/DB defaults). Playwright's loader has no such restriction, so it
 * imports this module directly.
 */
import { spawn, type ChildProcess, execFile } from 'node:child_process';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

import postgres from 'postgres';

const execFileAsync = promisify(execFile);

export const PORT = Number(process.env.E2E_PW_PORT ?? 3102);
export const HOST = '127.0.0.1';
export const BASE_URL = `http://localhost:${PORT}`;
export const DB_NAME = process.env.E2E_PW_DB_NAME ?? 'dollhousemcp_console_e2e_pw';
const APP_ROLE = 'dollhouse_app';
const APP_PASSWORD = process.env.E2E_APP_PASSWORD ?? 'dollhouse_app_local';
const SUPERUSER_TEMPLATE = process.env.E2E_PG_SUPERUSER_URL ?? 'postgres://dollhouse:dollhouse@localhost:5432/postgres';

export function superuserUrlFor(database: string): string {
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

export async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<void> {
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
  throw new Error(`[console-e2e/pw] app at ${baseUrl} not healthy in ${timeoutMs}ms: ${String(lastErr)}`);
}

export async function provisionDatabase(): Promise<void> {
  const admin = postgres(superuserUrlFor('postgres'), { ssl: false, max: 1, onnotice: () => {} });
  try {
    const role = (await admin`SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}`).at(0);
    await admin.unsafe(`${role ? 'ALTER' : 'CREATE'} ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOBYPASSRLS`);
    const db = (await admin`SELECT 1 FROM pg_database WHERE datname = ${DB_NAME}`).at(0);
    if (!db) await admin.unsafe(`CREATE DATABASE ${DB_NAME}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const { stderr } = await execFileAsync('npx', ['drizzle-kit', 'migrate'], {
    env: { ...process.env, DOLLHOUSE_DATABASE_ADMIN_URL: superuserUrlFor(DB_NAME) },
    cwd: process.cwd(), maxBuffer: 32 * 1024 * 1024,
  });
  if (process.env.E2E_DEBUG && stderr) console.log('[pw migrate]', stderr);

  const onDb = postgres(superuserUrlFor(DB_NAME), { ssl: false, max: 1, onnotice: () => {} });
  try {
    await onDb.unsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await onDb.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);
    await onDb.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
    await onDb.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`);
    await onDb.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}`);
    await onDb.unsafe(`REVOKE INSERT, UPDATE, DELETE ON TABLE users FROM ${APP_ROLE}`);
    await onDb.unsafe(`GRANT USAGE ON SCHEMA drizzle TO ${APP_ROLE}`).catch(() => {});
    await onDb.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO ${APP_ROLE}`).catch(() => {});
  } finally {
    await onDb.end({ timeout: 5 });
  }
}

export interface BootedApp {
  child: ChildProcess;
  opaqueHmacKey: string;
  logPath: string;
}

export function bootApp(runDir: string): BootedApp {
  for (const d of ['cwd', 'run', 'portfolio', 'cache', 'logs']) mkdirSync(path.join(runDir, d), { recursive: true });
  const b64 = () => randomBytes(32).toString('base64');
  const hex = () => randomBytes(32).toString('hex');
  const opaqueHmacKey = b64();
  const evidencePath = path.join(runDir, 'replacement-readiness.json');
  writeFileSync(evidencePath, JSON.stringify(readinessEvidence(), null, 2));

  const env: NodeJS.ProcessEnv = {
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
    DOLLHOUSE_WEB_CONSOLE_OPAQUE_HMAC_KEY: opaqueHmacKey,
    DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY: b64(),
    DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY_ID: 'web-console-e2e-pw-v1',
    DOLLHOUSE_WEB_CONSOLE_PROTECTED_CORRELATION_HMAC_KEY: b64(),
    DOLLHOUSE_COOKIE_SIGNING_SECRET: hex(),
    DOLLHOUSE_INVITE_TOKEN_SECRET: hex(),
    DOLLHOUSE_MASTER_ENCRYPTION_KEY: b64(),
    DOLLHOUSE_SECURITY_MODE: 'strict',
    DOLLHOUSE_RUN_DIR: `${runDir}/run`,
    DOLLHOUSE_PORTFOLIO_DIR: `${runDir}/portfolio`,
    DOLLHOUSE_CACHE_DIR: `${runDir}/cache`,
    DOLLHOUSE_LOG_DIR: `${runDir}/logs`,
  };
  const logPath = path.join(runDir, 'logs', `pw-app-${randomBytes(4).toString('hex')}.log`);
  const logStream = createWriteStream(logPath, { flags: 'a' });
  const child = spawn('npx', ['tsx', path.join(process.cwd(), 'src/index.ts'), '--streamable-http'], {
    cwd: path.join(runDir, 'cwd'), env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  return { child, opaqueHmacKey, logPath };
}

function readinessEvidence(): unknown {
  const ids = [
    'production_database_migrations', 'security_invalidation_multi_replica', 'allowlist_authority_parity',
    'embedded_as_login_step_up', 'account_invite_redemption', 'oauth_grant_revocation',
    'github_integration_connect_callback', 'portfolio_sync_live_repository',
    'signing_key_auth_policy_multi_replica', 'approval_execution_projection', 'audit_telemetry_projection',
  ];
  return {
    phase: 'pre-replacement',
    composition: {
      activationProfile: 'shared-hosted', storageBackend: 'postgres', apiV1MountCreated: true, routesMounted: false,
      registeredRouteModuleIds: [
        'auth', 'health', 'accountAdmin', 'activations', 'approvals', 'audit', 'executions', 'integrations',
        'operations', 'portfolio', 'runtimeSessions', 'security-admin', 'selfSecurity', 'selfService', 'session-telemetry',
      ],
    },
    liveChecks: ids.map(id => ({ id, ready: true, detail: 'e2e/pw: verified by harness setup.' })),
  };
}
