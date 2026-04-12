#!/usr/bin/env tsx
/**
 * Manual TOTP enrollment test harness (#1794).
 *
 * Interactive end-to-end walkthrough of the TOTP enrollment flow.
 * Starts an isolated authenticated web console in a temp directory
 * and walks you through:
 *
 *   1. `POST /enroll/begin` — prints the otpauth URI + a terminal-
 *      rendered QR code + the base32 secret for manual entry
 *   2. Prompts you to scan the QR (or type the secret into your
 *      authenticator app manually) and enter the 6-digit code
 *   3. `POST /enroll/confirm` — prints the backup codes (shown once)
 *   4. `GET /status` — confirms enrollment state
 *   5. Prompts you to enter a fresh 6-digit code for disable
 *   6. `POST /disable` — clears the enrollment
 *   7. `GET /status` — confirms the disable
 *
 * This exercises every HTTP endpoint in the TOTP lifecycle against
 * real code paths, with a real authenticator app in the loop. Zero
 * risk to other DollhouseMCP instances on the same machine:
 *
 *   • Binds to a test-only port (default 8765, far from both the
 *     legacy 3939 and the authenticated 41715)
 *   • Uses a fresh temp token file under /tmp — never touches
 *     ~/.dollhouse/run/console-token.auth.json
 *   • Bypasses leader election entirely — no lock file contention
 *     with production Claude Code / Claude Desktop sessions
 *   • Auto-cleans the sandbox on exit or Ctrl-C
 *
 * Usage:
 *
 *   npm run test:totp:manual
 *   # or directly:
 *   tsx scripts/totp-manual-test.ts
 *   # or with a custom port:
 *   TOTP_TEST_PORT=9999 tsx scripts/totp-manual-test.ts
 */

import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import QRCode from 'qrcode';
import { ConsoleTokenStore } from '../src/web/console/consoleToken.js';
import { startWebServer } from '../src/web/server.js';
import { createTotpRoutes } from '../src/web/routes/totpRoutes.js';

const TEST_PORT = Number(process.env.TOTP_TEST_PORT ?? 8765);

// Minimal ANSI color helpers — easier to scan the guided output
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const rl = readline.createInterface({ input, output });

interface ApiResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

async function apiCall(
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: unknown,
): Promise<ApiResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => null)) as unknown;
  return { ok: res.ok, status: res.status, body: parsed };
}

function section(title: string): void {
  console.log('');
  console.log(bold(cyan(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length - 4))}`)));
}

/**
 * Log a single passing-check line. Called after `assertFn` has already
 * run without throwing — if it had thrown, control never reaches here.
 */
function ok(label: string): void {
  console.log(`  ${green('✓')} ${label}`);
}

/**
 * Log a failing-check line and throw a descriptive error. Used when
 * we need to fail the harness with context alongside the ✗ marker
 * before throwing — for cases where a raw `assert` would lose the
 * accompanying response body or other debug detail.
 */
function bail(label: string, detail?: string): never {
  console.log(`  ${red('✗')} ${label}`);
  if (detail !== undefined) console.log(`    ${dim(detail)}`);
  throw new Error(`Assertion failed: ${label}`);
}

/**
 * Run an assertion function and, if it doesn't throw, log a ✓ line.
 *
 * Takes the label first and the assertion closure second. No boolean
 * parameter driving control flow — the success/failure routing is
 * entirely via exception propagation from `assertFn`. This is a
 * deliberate shape to avoid Sonar's S2301 ("provide multiple methods
 * instead of using condition to determine which action to take")
 * which fires on single-function helpers that branch on a boolean
 * parameter.
 */
function checkOk(label: string, assertFn: () => void): void {
  assertFn();
  ok(label);
}

async function run(): Promise<void> {
  // ---------- Sandbox setup ----------
  const sandbox = await mkdtemp(join(tmpdir(), 'dollhouse-totp-manual-test-'));
  const tokenFilePath = join(sandbox, 'console-token.auth.json');
  const portfolioDir = join(sandbox, 'portfolio');

  console.log(bold('TOTP enrollment manual test harness'));
  console.log(dim(`  sandbox:    ${sandbox}`));
  console.log(dim(`  token file: ${tokenFilePath}`));
  console.log(dim(`  port:       ${TEST_PORT}`));
  console.log('');

  // Cleanup handler — registered before anything else so a Ctrl-C
  // at any point scrubs the temp directory
  const cleanup = async () => {
    try {
      await rm(sandbox, { recursive: true, force: true });
    } catch { /* ignore */ }
  };
  process.once('SIGINT', async () => {
    console.log('\n' + yellow('Interrupted — cleaning up sandbox.'));
    await cleanup();
    process.exit(130);
  });

  // ---------- Spin up isolated server ----------
  const store = new ConsoleTokenStore(tokenFilePath);
  const primary = await store.ensureInitialized('Kermit');

  await startWebServer({
    portfolioDir,
    port: TEST_PORT,
    tokenStore: store,
    additionalRouters: [createTotpRoutes({ store })],
  });

  const token = primary.token;
  console.log(green('Server is up.'));
  console.log(dim(`  bearer token: ${token.slice(0, 12)}…${token.slice(-4)}`));

  try {
    // ---------- Step 1: initial status ----------
    section('Step 1: initial status (should be not-enrolled)');
    const initialStatus = await apiCall('GET', '/api/console/totp/status', token);
    console.log(JSON.stringify(initialStatus.body, null, 2));
    checkOk('GET /status returned 200', () => assert.strictEqual(initialStatus.status, 200));
    checkOk('status reports enrolled=false before enrollment', () =>
      assert.strictEqual((initialStatus.body as { enrolled: boolean }).enrolled, false),
    );

    // ---------- Step 2: begin enrollment ----------
    section('Step 2: POST /enroll/begin');
    const begin = await apiCall('POST', '/api/console/totp/enroll/begin', token, {
      label: 'Manual test',
    });
    checkOk('POST /enroll/begin returned 200', () => assert.strictEqual(begin.status, 200));
    const beginBody = begin.body as {
      pendingId: string;
      secret: string;
      otpauthUri: string;
      qrSvgDataUrl: string;
      expiresAt: number;
    };
    checkOk('pendingId present', () => {
      assert.strictEqual(typeof beginBody.pendingId, 'string');
      assert.ok(beginBody.pendingId.length > 0);
    });
    checkOk('secret is valid base32', () => {
      assert.strictEqual(typeof beginBody.secret, 'string');
      assert.match(beginBody.secret, /^[A-Z2-7]+=*$/);
    });
    checkOk('otpauthUri starts with otpauth://totp/', () =>
      assert.ok(beginBody.otpauthUri.startsWith('otpauth://totp/')),
    );
    checkOk('qrSvgDataUrl is an SVG data URL', () =>
      assert.ok(beginBody.qrSvgDataUrl.startsWith('data:image/svg+xml')),
    );

    // ---------- Step 3: render QR in the terminal ----------
    section('Step 3: scan this QR code with your authenticator app');
    const qrAscii = await QRCode.toString(beginBody.otpauthUri, { type: 'terminal', small: true });
    console.log(qrAscii);
    console.log(dim('Or enter this secret manually into your authenticator:'));
    // Group base32 secret in 4-char chunks for easier typing
    const grouped = (beginBody.secret.match(/.{1,4}/g) ?? []).join(' ');
    console.log(`  ${bold(grouped)}`);
    console.log(dim(`  (issuer: DollhouseMCP, label: Manual test)`));
    console.log('');

    // ---------- Step 4: confirm ----------
    section('Step 4: POST /enroll/confirm');
    const confirmCode = (await rl.question('Enter the 6-digit code from your authenticator: ')).trim();
    const confirm = await apiCall('POST', '/api/console/totp/enroll/confirm', token, {
      pendingId: beginBody.pendingId,
      code: confirmCode,
    });
    if (confirm.status !== 200) {
      bail(
        `confirm returned ${confirm.status}`,
        `body: ${JSON.stringify(confirm.body)} — check your authenticator and the server clock`,
      );
    }
    const confirmBody = confirm.body as {
      enrolled: boolean;
      enrolledAt: string;
      backupCodes: string[];
    };
    checkOk('POST /enroll/confirm returned 200', () => assert.strictEqual(confirm.status, 200));
    checkOk('response enrolled=true', () => assert.strictEqual(confirmBody.enrolled, true));
    checkOk('10 backup codes returned', () => {
      assert.ok(Array.isArray(confirmBody.backupCodes));
      assert.strictEqual(confirmBody.backupCodes.length, 10);
    });
    checkOk('backup codes are all unique', () =>
      assert.strictEqual(new Set(confirmBody.backupCodes).size, 10),
    );

    console.log('');
    console.log(yellow('⚠  Backup codes (these are shown ONCE — write them down now):'));
    confirmBody.backupCodes.forEach((code, i) => {
      console.log(`  ${dim(String(i + 1).padStart(2))}. ${bold(code)}`);
    });

    // ---------- Step 5: status reflects enrollment ----------
    section('Step 5: status reflects enrollment');
    const enrolledStatus = await apiCall('GET', '/api/console/totp/status', token);
    console.log(JSON.stringify(enrolledStatus.body, null, 2));
    checkOk('GET /status returned 200', () => assert.strictEqual(enrolledStatus.status, 200));
    checkOk('status reports enrolled=true after enrollment', () =>
      assert.strictEqual((enrolledStatus.body as { enrolled: boolean }).enrolled, true),
    );
    checkOk('backupCodesRemaining is 10', () =>
      assert.strictEqual(
        (enrolledStatus.body as { backupCodesRemaining: number }).backupCodesRemaining,
        10,
      ),
    );

    // ---------- Step 6: disable ----------
    section('Step 6: POST /disable');
    console.log(dim('Wait for a fresh code on your authenticator (not the one you just used).'));
    const disableCode = (await rl.question('Enter a fresh 6-digit code: ')).trim();
    const disable = await apiCall('POST', '/api/console/totp/disable', token, { code: disableCode });
    if (disable.status !== 200) {
      bail(
        `disable returned ${disable.status}`,
        `body: ${JSON.stringify(disable.body)} — check your authenticator`,
      );
    }
    checkOk('POST /disable returned 200', () => assert.strictEqual(disable.status, 200));
    checkOk('response enrolled=false after disable', () =>
      assert.strictEqual((disable.body as { enrolled: boolean }).enrolled, false),
    );

    // ---------- Step 7: final status ----------
    section('Step 7: status reflects disable');
    const finalStatus = await apiCall('GET', '/api/console/totp/status', token);
    console.log(JSON.stringify(finalStatus.body, null, 2));
    checkOk('GET /status returned 200', () => assert.strictEqual(finalStatus.status, 200));
    checkOk('status reports enrolled=false after disable', () =>
      assert.strictEqual((finalStatus.body as { enrolled: boolean }).enrolled, false),
    );

    // ---------- Success ----------
    console.log('');
    console.log(green(bold('✓ Full TOTP lifecycle exercised successfully.')));
    console.log(dim('  begin → confirm → status → disable → status'));
  } finally {
    rl.close();
    await cleanup();
    console.log(dim('\n[TOTP harness] Sandbox cleaned up. Exiting.'));
  }
}

try {
  await run();
  process.exit(0);
} catch (err) {
  console.error(red('\n[TOTP harness] Fatal error:'), err instanceof Error ? err.message : err);
  process.exit(1);
}
