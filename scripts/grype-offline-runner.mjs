// Runs only inside the isolated, offline application-image container.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const directory = '/work/reports';
for (const path of [directory, '/work/tmp', '/work/home']) fs.mkdirSync(path, { recursive: true });
const files = {};
let outcome = 1;
const deadline = Date.now() + 90000;
function resources() {
  const observation = {};
  for (const name of ['memory.current', 'memory.peak', 'memory.max', 'memory.swap.max', 'cpu.max', 'pids.max']) {
    try { observation[name] = fs.readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim(); }
    catch (error) { observation[name] = `unavailable: ${error.code}`; }
  }
  try { observation.hydrated_db_bytes = fs.statSync('/work/db/6/vulnerability.db').size; }
  catch { observation.hydrated_db_bytes = null; }
  return observation;
}

function run(name, args, timeout = 120000) {
  const command = ['/inputs/grype', '--config', '/inputs/grype.yaml', ...args];
  const started = new Date().toISOString();
  timeout = Math.min(timeout, deadline - Date.now());
  if (timeout <= 0) throw new Error('Offline scanner exceeded its total 90 second process budget');
  const child = spawnSync(command[0], command.slice(1), {
    cwd: '/work', env: process.env, encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024,
  });
  files[`${name}.stdout`] = child.stdout ?? '';
  files[`${name}.stderr`] = child.stderr ?? '';
  files[`${name}-receipt.json`] = JSON.stringify({
    command, started_utc: started, finished_utc: new Date().toISOString(),
    timeout_ms: timeout, exit_code: child.status, signal: child.signal,
    error: child.error?.message ?? null, resources_after: resources(),
  });
  return child.status;
}
try {
  for (const [name, args] of [
    ['version', ['version', '-o', 'json']], ['help', ['--help']],
    ['effective-config', ['config', '--load']], ['db-import-help', ['db', 'import', '--help']],
    ['db-import', ['db', 'import', '/inputs/database.tar.zst']],
    ['db-status', ['db', 'status', '-o', 'json']],
  ]) {
    if (run(name, args) !== 0) throw new Error(`${name} failed; offline scan unavailable`);
  }
  if (fs.statSync('/work/db/6/vulnerability.db').size > 3.5 * 1024 ** 3) {
    throw new Error('Hydrated database exceeds its admitted 3.5 GiB reserve; target scan refused');
  }
  outcome = run('scan', ['docker-archive:/inputs/image.tar', '--output', 'json',
    '--file', `${directory}/application-image-vulnerabilities.json`, '--fail-on', 'high']);
  if (![0, 2].includes(outcome)) throw new Error('Offline scan failed or timed out');
  const report = `${directory}/application-image-vulnerabilities.json`;
  if (fs.statSync(report).size > 32 * 1024 * 1024) throw new Error('Report exceeds bounded output size');
  files['application-image-vulnerabilities.json'] = fs.readFileSync(report, 'utf8');
} catch (error) {
  outcome = 1;
  files['failure.json'] = JSON.stringify({ error: error.message, status: 'unavailable' });
}
// Stream before tmpfs disappears; no writable host mount or Docker socket exists.
process.stdout.write(JSON.stringify({ kind: 'grype-offline-envelope-v1', files, exit_code: outcome }));
process.exitCode = outcome;
