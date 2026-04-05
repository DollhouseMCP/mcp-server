#!/usr/bin/env tsx
/**
 * Manual TOTP enrollment test harness (#1794).
 *
 * Spins up a fully isolated authenticated web console in a temp
 * directory so you can manually walk through the TOTP flow with your
 * actual authenticator app. Designed to coexist cleanly with any
 * other DollhouseMCP instance on your machine:
 *
 *   • Binds to a test-only port (default 8765, far from both the
 *     legacy 3939 and the authenticated 5907)
 *   • Uses a fresh temp token file so it does not touch your real
 *     `~/.dollhouse/run/console-token.auth.json`
 *   • Bypasses leader election entirely — no lock file contention
 *     with your production Claude Code / Claude Desktop sessions
 *
 * Usage:
 *
 *   tsx scripts/totp-manual-test.ts
 *   # or with a custom port:
 *   TOTP_TEST_PORT=9999 tsx scripts/totp-manual-test.ts
 *
 * The script prints the Bearer token to stdout on startup so you can
 * copy it into curl commands. Press Ctrl-C to stop. The temp directory
 * is cleaned up automatically on exit.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConsoleTokenStore } from '../src/web/console/consoleToken.js';
import { startWebServer } from '../src/web/server.js';
import { createTotpRoutes } from '../src/web/routes/totpRoutes.js';

const TEST_PORT = Number(process.env.TOTP_TEST_PORT ?? 8765);

async function main(): Promise<void> {
  // Isolated sandbox under /tmp — nothing touches ~/.dollhouse/
  const sandbox = await mkdtemp(join(tmpdir(), 'dollhouse-totp-manual-test-'));
  const tokenFilePath = join(sandbox, 'console-token.auth.json');
  const portfolioDir = join(sandbox, 'portfolio');

  console.log('[TOTP harness] Starting isolated test console');
  console.log(`[TOTP harness] Sandbox:     ${sandbox}`);
  console.log(`[TOTP harness] Token file:  ${tokenFilePath}`);
  console.log(`[TOTP harness] Port:        ${TEST_PORT}`);
  console.log('');

  // Create a fresh token store and initialize it. A random puppet name
  // matches how the real UnifiedConsole does it on first run.
  const store = new ConsoleTokenStore(tokenFilePath);
  const primary = await store.ensureInitialized('Kermit');

  // Mount TOTP routes on a fresh router. Since startWebServer already
  // mounts these automatically when `tokenStore` is passed, we just
  // need to hand the store in and the rest is wired for us. No leader
  // election. No stdio mode. No production state.
  await startWebServer({
    portfolioDir,
    port: TEST_PORT,
    tokenStore: store,
    additionalRouters: [createTotpRoutes({ store })],
  });

  console.log('==============================================================');
  console.log('TOTP manual test console is up.');
  console.log('');
  console.log(`  Base URL:  http://127.0.0.1:${TEST_PORT}`);
  console.log(`  Token:     ${primary.token}`);
  console.log('');
  console.log('Copy these into a curl session:');
  console.log('');
  console.log(`  TOKEN='${primary.token}'`);
  console.log(`  H="Authorization: Bearer \$TOKEN"`);
  console.log(`  URL="http://127.0.0.1:${TEST_PORT}"`);
  console.log('');
  console.log('  # 1. Check initial status');
  console.log(`  curl -s -H "\$H" \$URL/api/console/totp/status | jq .`);
  console.log('');
  console.log('  # 2. Start enrollment — returns pendingId, secret, otpauthUri, qrSvgDataUrl');
  console.log(`  curl -s -H "\$H" -X POST \$URL/api/console/totp/enroll/begin \\`);
  console.log(`    -H 'Content-Type: application/json' -d '{"label":"Manual test"}' | jq .`);
  console.log('');
  console.log('  # 3. Scan the QR (or paste the "secret" field into your authenticator app)');
  console.log('  # 4. Confirm with the live 6-digit code from your authenticator');
  console.log(`  curl -s -H "\$H" -X POST \$URL/api/console/totp/enroll/confirm \\`);
  console.log(`    -H 'Content-Type: application/json' \\`);
  console.log(`    -d '{"pendingId":"<from step 2>","code":"<from authenticator>"}' | jq .`);
  console.log('');
  console.log('  # 5. Write down the backup codes! They are shown only once.');
  console.log('');
  console.log('  # 6. Verify status reflects enrollment');
  console.log(`  curl -s -H "\$H" \$URL/api/console/totp/status | jq .`);
  console.log('');
  console.log('  # 7. Disable (requires a live TOTP code or a backup code)');
  console.log(`  curl -s -H "\$H" -X POST \$URL/api/console/totp/disable \\`);
  console.log(`    -H 'Content-Type: application/json' -d '{"code":"<fresh code>"}' | jq .`);
  console.log('');
  console.log('Press Ctrl-C to stop the harness and clean up the sandbox.');
  console.log('==============================================================');

  // Clean up the sandbox on exit
  const cleanup = async () => {
    try {
      await rm(sandbox, { recursive: true, force: true });
      console.log('\n[TOTP harness] Sandbox cleaned up.');
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);

  // Keep the process alive
  await new Promise<void>(() => { /* never resolves */ });
}

main().catch((err) => {
  console.error('[TOTP harness] Fatal error:', err);
  process.exit(1);
});
