#!/usr/bin/env tsx

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  createPreviewCredentialFile,
  removePreviewCredentialFile,
} from './lib/web-console-preview-credentials.js';

const previewRoot = path.join(process.cwd(), '.console-preview');
mkdirSync(previewRoot, { recursive: true });

process.env.E2E_PW_PORT ??= '3199';
process.env.E2E_PW_DB_NAME ??= 'dollhousemcp_console_preview';
if (process.env.WEB_CONSOLE_PREVIEW_COMPILED === '1') {
  process.env.E2E_APP_ENTRY = 'dist/index.js';
}

const [{ BASE_URL, DB_NAME, bootApp, provisionDatabase, superuserUrlFor, waitForHealth }, { closeDb }, seed] =
  await Promise.all([
    import('../tests/integration/web-console-e2e/setup/provision.js'),
    import('../tests/integration/web-console-e2e/harness/pg.js'),
    import('../tests/integration/web-console-e2e/harness/seed.js'),
  ]);

let childPid: number | undefined;
let credentialPath: string | undefined;
let stopping = false;
let forceKillTimer: NodeJS.Timeout | undefined;

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  if (childPid !== undefined) {
    try { process.kill(-childPid, signal); } catch { /* process already exited */ }
    forceKillTimer = setTimeout(() => {
      if (childPid !== undefined) {
        try { process.kill(-childPid, 'SIGKILL'); } catch { /* process already exited */ }
      }
    }, 5_000);
    forceKillTimer.unref();
  }
}

process.once('SIGINT', () => stop('SIGTERM'));
process.once('SIGTERM', () => stop('SIGTERM'));

try {
  await provisionDatabase();
  const { child, opaqueHmacKey, logPath } = bootApp(previewRoot);
  childPid = child.pid;
  process.env.E2E_DATABASE_ADMIN_URL = superuserUrlFor(DB_NAME);
  process.env.E2E_OPAQUE_HMAC_KEY = opaqueHmacKey;

  await waitForHealth(BASE_URL, 90_000);
  await seed.seedWorld();
  await closeDb();

  credentialPath = createPreviewCredentialFile(previewRoot, {
    username: 'e2e_admin',
    password: seed.SEED_PASSWORD,
  });

  console.log(`Web console preview: ${BASE_URL}/ui`);
  console.log(`Credentials: ${credentialPath}`);
  console.log(`Runtime: ${process.env.E2E_APP_ENTRY ?? 'src/index.ts'}`);
  console.log(`Logs: ${logPath}`);
  console.log('Press Ctrl-C to stop.');

  await new Promise<void>((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (stopping || signal === 'SIGTERM') resolve();
      else reject(new Error(`Preview server exited unexpectedly (${signal ?? code ?? 'unknown'}). See ${logPath}`));
    });
  });
} finally {
  if (forceKillTimer) clearTimeout(forceKillTimer);
  if (credentialPath) {
    try {
      removePreviewCredentialFile(credentialPath);
    } catch {
      console.error(`Unable to remove preview credentials: ${credentialPath}`);
    }
  }
  await closeDb().catch(() => {});
  if (childPid !== undefined) {
    try { process.kill(-childPid, 'SIGKILL'); } catch { /* process already exited */ }
  }
}
