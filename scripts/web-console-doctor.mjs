#!/usr/bin/env node
/**
 * web-console-doctor — preflight setup check for the new web console (/api/v1).
 *
 * Catches the class of problems that bite first-time setups and the e2e
 * harness: api/v1 not enabled, missing/short HMAC keys, no DATABASE_URL
 * (silent in-memory fallback), production DB identity not declared (mount
 * refuses), TLS missing on a non-loopback bind, allowlist not enforced, and
 * migrations not applied. It is a *preflight* — it complements, not replaces,
 * the fail-closed `assertWebConsoleProductionActivation()` that runs at mount.
 *
 * Usage:
 *   node scripts/web-console-doctor.mjs
 *   node scripts/web-console-doctor.mjs --env-file=./.env.production
 *   node scripts/web-console-doctor.mjs --json
 *
 * Exit code: 0 if no FAILs, 1 if any FAIL. WARNs do not fail the run.
 */

import { readFileSync, existsSync, accessSync, constants } from 'node:fs';

// ── tiny check framework ──────────────────────────────────────────────────
const results = [];
const PASS = 'pass', WARN = 'warn', FAIL = 'fail', INFO = 'info';
function add(section, level, title, detail, fix) {
  results.push({ section, level, title, detail, fix });
}
const env = process.env;
const get = (k) => { const v = env[k]; return v && v.trim() !== '' ? v.trim() : undefined; };
const isTrue = (k) => /^(1|true|yes|on)$/i.test(env[k] ?? '');
function isBase64Bytes(v, n) {
  try { return Buffer.from(v, 'base64').length === n; } catch { return false; }
}

// ── args: --env-file, --json ──────────────────────────────────────────────
const args = process.argv.slice(2);
const json = args.includes('--json');
const envFileArg = args.find(a => a.startsWith('--env-file='));
if (envFileArg) {
  const path = envFileArg.split('=')[1];
  if (!existsSync(path)) { console.error(`env-file not found: ${path}`); process.exit(2); }
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ── deployment shape ──────────────────────────────────────────────────────
const apiV1On = isTrue('DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED');
const baseUrl = get('DOLLHOUSE_PUBLIC_BASE_URL');
let host, isHttps = false, isLoopback = null;
if (baseUrl) {
  try {
    const u = new URL(baseUrl);
    host = u.hostname; isHttps = u.protocol === 'https:';
    isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
  } catch { /* invalid url reported below */ }
}
const hosted = isLoopback === false; // non-loopback public base = hosted/shared

// ── 1. Mount & transport ──────────────────────────────────────────────────
if (!apiV1On) {
  add('Mount', FAIL, 'New console (/api/v1) is NOT enabled',
    'DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED is not truthy — the rewritten console will not mount.',
    'Set DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED=true');
} else {
  add('Mount', PASS, '/api/v1 console enabled', 'DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED=true');
}
if (!baseUrl) {
  add('Mount', apiV1On ? FAIL : WARN, 'DOLLHOUSE_PUBLIC_BASE_URL is not set',
    'Required for OAuth/AS discovery metadata and GitHub integration callbacks; the AS throws without it.',
    'Set DOLLHOUSE_PUBLIC_BASE_URL to the externally reachable base URL (e.g. https://mcp.example.com)');
} else if (isLoopback === null) {
  add('Mount', FAIL, 'DOLLHOUSE_PUBLIC_BASE_URL is not a valid URL', `value: ${baseUrl}`,
    'Use a full URL including scheme, e.g. https://mcp.example.com');
} else {
  add('Mount', PASS, 'Public base URL set',
    `${baseUrl} (${isLoopback ? 'loopback/dev' : 'hosted/shared'}${isHttps ? ', https' : ', http'})`);
}

// ── 2. Database (console is Postgres-or-volatile-memory) ───────────────────
const dbUrl = get('DOLLHOUSE_DATABASE_URL');
if (!dbUrl) {
  add('Database', apiV1On ? FAIL : WARN, 'No DOLLHOUSE_DATABASE_URL — console will use volatile in-memory stores',
    'Without a database the console silently falls back to in-memory stores: sessions, MFA factors, audit chain, integrations, portfolio sync jobs all evaporate on restart. Not viable beyond local smoke tests.',
    'Set DOLLHOUSE_DATABASE_URL to your PostgreSQL connection string');
} else {
  add('Database', PASS, 'DOLLHOUSE_DATABASE_URL set', dbUrl.replace(/:\/\/[^@]*@/, '://***@'));
}
const prodDbName = get('DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_NAME');
const prodDbUser = get('DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_USER');
if (dbUrl && (!prodDbName || !prodDbUser)) {
  add('Database', hosted ? FAIL : WARN, 'Production database identity not fully declared',
    'assertWebConsoleProductionActivation() requires verification of the intended DB + migration state for hosted/shared mounts; missing these yields database_verification_not_ready and the mount refuses.',
    'Set DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_NAME and DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_USER to the expected values');
} else if (dbUrl) {
  add('Database', PASS, 'Production database identity declared', `${prodDbUser}@${prodDbName}`);
}

// ── 3. Secrets & keys (mount fails without these) ──────────────────────────
function keyCheck(name, { base64Bytes } = {}) {
  const v = get(name);
  if (!v) {
    add('Secrets', apiV1On ? FAIL : WARN, `${name} is not set`,
      'Required for hosted web-console activation.', `Set ${name}`);
    return;
  }
  if (base64Bytes && !isBase64Bytes(v, base64Bytes)) {
    add('Secrets', FAIL, `${name} is not a base64-encoded ${base64Bytes}-byte key`,
      `Decoded length is not ${base64Bytes} bytes.`,
      `Generate with: openssl rand -base64 ${base64Bytes}`);
    return;
  }
  add('Secrets', PASS, `${name} present`, base64Bytes ? `valid base64 ${base64Bytes}-byte key` : 'set');
}
keyCheck('DOLLHOUSE_WEB_CONSOLE_OPAQUE_HMAC_KEY', { base64Bytes: 32 });
keyCheck('DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY');
keyCheck('DOLLHOUSE_WEB_CONSOLE_PROTECTED_CORRELATION_HMAC_KEY', { base64Bytes: 32 });
keyCheck('DOLLHOUSE_AUDIT_HMAC_SECRET'); // required for Postgres admin audit chain

// ── 4. TLS / transport security ────────────────────────────────────────────
const certPath = get('DOLLHOUSE_TLS_CERT_PATH');
const keyPath = get('DOLLHOUSE_TLS_KEY_PATH');
const unsafeNoTls = isTrue('DOLLHOUSE_UNSAFE_NO_TLS');
const tlsConfigured = certPath && keyPath;
function fileReadable(p) { try { accessSync(p, constants.R_OK); return true; } catch { return false; } }
if (tlsConfigured) {
  const missing = [certPath, keyPath].filter(p => !fileReadable(p));
  if (missing.length) {
    add('TLS', FAIL, 'TLS cert/key path(s) not readable', `unreadable: ${missing.join(', ')}`,
      'Point DOLLHOUSE_TLS_CERT_PATH / DOLLHOUSE_TLS_KEY_PATH at readable PEM files');
  } else {
    add('TLS', PASS, 'TLS cert + key configured and readable', `${certPath}, ${keyPath}`);
  }
}
if (hosted && !tlsConfigured && !isHttps) {
  if (unsafeNoTls) {
    add('TLS', WARN, 'Non-loopback bind with DOLLHOUSE_UNSAFE_NO_TLS=true',
      'TLS is disabled on a hosted bind. This is a CI-only escape hatch.',
      'Configure TLS and unset DOLLHOUSE_UNSAFE_NO_TLS before production');
  } else {
    add('TLS', FAIL, 'Hosted bind without TLS',
      'Public base URL is non-loopback but no TLS cert/key is configured and the URL is not https.',
      'Set DOLLHOUSE_TLS_CERT_PATH + DOLLHOUSE_TLS_KEY_PATH (or terminate TLS upstream and use an https base URL)');
  }
} else if (unsafeNoTls) {
  add('TLS', WARN, 'DOLLHOUSE_UNSAFE_NO_TLS=true', 'Never set this in production.', 'Unset for production');
}

// ── 5. Auth posture (allowlist, DCR, methods) ──────────────────────────────
if (!isTrue('DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED')) {
  add('Auth', WARN, 'Sign-in allowlist is NOT enforced (default)',
    'DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED defaults to false — any identity that can authenticate via an enabled method can sign in. The allowlist is the load-bearing access gate.',
    'Set DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED=true and seed entries via the allowlist CLI');
} else {
  add('Auth', PASS, 'Sign-in allowlist enforced', 'DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED=true');
}
if (isTrue('DOLLHOUSE_AUTH_OPEN_DCR') && hosted) {
  add('Auth', WARN, 'Open DCR enabled on a hosted bind',
    'DOLLHOUSE_AUTH_OPEN_DCR=true allows unauthenticated client registration. Ensure constrained-DCR + consent + rate limiting are in place (the hosted-safe shape).',
    'Confirm this is intended; otherwise unset DOLLHOUSE_AUTH_OPEN_DCR');
}
const methods = (get('DOLLHOUSE_AUTH_METHODS') ?? '').toLowerCase();
if (methods.includes('github') && !(get('DOLLHOUSE_AUTH_GITHUB_CLIENT_ID') && get('DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET'))) {
  add('Auth', FAIL, 'GitHub sign-in method enabled but credentials missing',
    'DOLLHOUSE_AUTH_METHODS includes github but DOLLHOUSE_AUTH_GITHUB_CLIENT_ID/SECRET are not both set.',
    'Set the GitHub web-flow OAuth app credentials (auth ≠ integration app)');
}
if (methods.includes('magic') && !(get('DOLLHOUSE_SMTP_HOST') && get('DOLLHOUSE_SMTP_FROM'))) {
  add('Auth', FAIL, 'Magic-link method enabled but SMTP not configured',
    'DOLLHOUSE_AUTH_METHODS includes magic-link but DOLLHOUSE_SMTP_HOST/FROM are not set.',
    'Configure DOLLHOUSE_SMTP_HOST, DOLLHOUSE_SMTP_FROM (and STARTTLS-capable SMTP)');
}

// ── 6. Optional feature: portfolio sync integration ────────────────────────
const intId = get('DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_ID');
const intSecret = get('DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_SECRET');
if (intId || intSecret) {
  if (!(intId && intSecret)) {
    add('Integrations', WARN, 'Partial GitHub portfolio-sync integration config',
      'Only one of DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_ID/SECRET is set.',
      'Set both, or neither (separate GitHub App from the sign-in app)');
  } else {
    add('Integrations', PASS, 'GitHub portfolio-sync integration configured', 'distinct App from sign-in');
  }
} else {
  add('Integrations', INFO, 'GitHub portfolio-sync integration not configured',
    'Optional — only needed if users sync portfolios to/from GitHub.');
}

// ── 7. Database connectivity + migrations (best-effort) ────────────────────
async function dbChecks() {
  if (!dbUrl) return;
  let postgres;
  try { ({ default: postgres } = await import('postgres')); }
  catch { add('Database', INFO, 'Skipped live DB check', 'postgres driver not importable from here.'); return; }
  let sql;
  try {
    sql = postgres(dbUrl, { max: 1, idle_timeout: 2, connect_timeout: 5, onnotice: () => {} });
    const rows = await sql`select table_name from information_schema.tables where table_schema='public'`;
    const present = new Set(rows.map(r => r.table_name));
    add('Database', PASS, 'Connected to PostgreSQL', `${present.size} tables in public schema`);
    // High-confidence tables that should exist once migrations are applied.
    const expected = ['users', 'elements', 'portfolio_elements', 'console_sessions', 'account_allowlist_entries'];
    const missing = expected.filter(t => !present.has(t));
    if (missing.length) {
      add('Database', FAIL, 'Expected tables missing — migrations may not be applied (or wrong DB)',
        `missing: ${missing.join(', ')}`,
        'Run the database migrations against this database before mounting the console');
    } else {
      add('Database', PASS, 'Core console tables present', expected.join(', '));
      // Bootstrap: allowlist enforced but empty + no admin => first sign-in blocked.
      if (isTrue('DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED')) {
        try {
          const [{ count }] = await sql`select count(*)::int as count from account_allowlist_entries`;
          if (count === 0) {
            add('Bootstrap', WARN, 'Allowlist enforced but empty',
              'No allowlist entries exist; sign-in is required-and-empty. Confirm the first-admin bootstrap path or seed an entry.',
              'Seed the first operator via the allowlist CLI, or use the documented bootstrap flow');
          } else {
            add('Bootstrap', PASS, 'Allowlist has entries', `${count} entr${count === 1 ? 'y' : 'ies'}`);
          }
        } catch { /* table-shape differences: skip silently */ }
      }
    }
  } catch (e) {
    add('Database', FAIL, 'Could not connect to PostgreSQL', String(e?.message ?? e),
      'Verify DOLLHOUSE_DATABASE_URL, network reachability, and credentials');
  } finally {
    try { await sql?.end({ timeout: 1 }); } catch { /* ignore */ }
  }
}

// ── report ─────────────────────────────────────────────────────────────────
await dbChecks();
const counts = { pass: 0, warn: 0, fail: 0, info: 0 };
for (const r of results) counts[r.level]++;

if (json) {
  console.log(JSON.stringify({ ok: counts.fail === 0, counts, results }, null, 2));
} else {
  const sym = { pass: '✓', warn: '⚠', fail: '✗', info: 'ℹ' };
  const order = ['Mount', 'Database', 'Secrets', 'TLS', 'Auth', 'Integrations', 'Bootstrap'];
  console.log('\nWeb Console — deployment preflight\n' + '─'.repeat(40));
  for (const section of order) {
    const rows = results.filter(r => r.section === section);
    if (!rows.length) continue;
    console.log(`\n${section}`);
    for (const r of rows) {
      console.log(`  ${sym[r.level]} ${r.title}`);
      if (r.level !== PASS && r.detail) console.log(`      ${r.detail}`);
      if (r.level !== PASS && r.fix) console.log(`      → ${r.fix}`);
    }
  }
  console.log('\n' + '─'.repeat(40));
  console.log(`${counts.fail} fail · ${counts.warn} warn · ${counts.pass} ok · ${counts.info} info`);
  console.log(counts.fail === 0
    ? (counts.warn === 0 ? 'Looks good.\n' : 'No blockers, but review the warnings above.\n')
    : 'Setup has blockers — fix the ✗ items before starting.\n');
}
process.exit(counts.fail === 0 ? 0 : 1);
