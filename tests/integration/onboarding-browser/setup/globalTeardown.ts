import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

export default async function globalTeardown(): Promise<void> {
  const directory = path.join(process.cwd(), '.onboarding-browser');
  let state: { databaseName: string; pids: number[] };
  try { state = JSON.parse(readFileSync(path.join(directory, 'state.json'), 'utf8')) as typeof state; } catch { return; }
  for (const pid of state.pids) { try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ } }
  await new Promise(resolve => setTimeout(resolve, 500));
  for (const pid of state.pids) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
  const template = process.env.ONBOARDING_BROWSER_PG_ADMIN_URL ?? process.env.DOLLHOUSE_TEST_DATABASE_ADMIN_URL ??
    process.env.DOLLHOUSE_TEST_DATABASE_URL ?? 'postgres://dollhouse:dollhouse@127.0.0.1:5432/postgres';
  const url = new URL(template); url.pathname = '/postgres';
  const admin = postgres(url.toString(), { ssl: false, max: 1, onnotice: () => {} });
  try { await admin.unsafe(`DROP DATABASE IF EXISTS ${state.databaseName} WITH (FORCE)`); } finally { await admin.end({ timeout: 5 }); }
  rmSync(directory, { recursive: true, force: true });
}
