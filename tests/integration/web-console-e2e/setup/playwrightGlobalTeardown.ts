import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

export default async function globalTeardown(): Promise<void> {
  const pidFile = path.join(process.cwd(), '.console-e2e-pw', 'app.pid');
  let pid: number | undefined;
  try { pid = Number(readFileSync(pidFile, 'utf8').trim()); } catch { return; }
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ }
  await new Promise(r => setTimeout(r, 1500));
  try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
  try { rmSync(pidFile); } catch { /* ignore */ }
}
