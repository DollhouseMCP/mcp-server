import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { BASE_URL, DB_NAME, bootApp, provisionDatabase, superuserUrlFor, waitForHealth } from './provision.js';
import { closeDb } from '../harness/pg.js';
import { seedWorld } from '../harness/seed.js';

/**
 * Playwright globalSetup for the real-auth lifecycle spec. Unlike jest's
 * globalSetup, Playwright's loader can import local TS, so this reuses the
 * shared provision/boot helpers and the seed. Boots an isolated app instance
 * (own port + DB), seeds e2e_admin (with a known password) and marks bootstrap,
 * then leaves the app running for the spec.
 */
export default async function globalSetup(): Promise<void> {
  await provisionDatabase();
  const runDir = path.join(process.cwd(), '.console-e2e-pw');
  const { child, opaqueHmacKey, logPath } = bootApp(runDir);

  // db()/seedWorld read these via the harness config.
  process.env.E2E_DATABASE_ADMIN_URL = superuserUrlFor(DB_NAME);
  process.env.E2E_OPAQUE_HMAC_KEY = opaqueHmacKey;

  try {
    await waitForHealth(BASE_URL, 90000);
    await seedWorld();
  } catch (err) {
    if (child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }
    throw new Error(`${String(err)}\n[console-e2e/pw] app log: ${logPath}`);
  } finally {
    await closeDb();
  }

  writeFileSync(path.join(runDir, 'app.pid'), String(child.pid));
  console.log(`[console-e2e/pw] app booted at ${BASE_URL} (logs: ${logPath})`);
}
