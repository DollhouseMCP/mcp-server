import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

export default async function globalTeardown(): Promise<void> {
  if (process.env.E2E_NO_BOOT === '1') return;
  const pidFile = path.join(process.cwd(), '.console-e2e', 'app.pid');
  let pid: number | undefined;
  try {
    pid = Number(readFileSync(pidFile, 'utf8').trim());
  } catch {
    return;
  }
  if (!pid) return;
  // The app was spawned detached, so kill the whole process group (tsx + child).
  try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
  await new Promise(r => setTimeout(r, 1500));
  try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  try { rmSync(pidFile); } catch { /* ignore */ }
}
