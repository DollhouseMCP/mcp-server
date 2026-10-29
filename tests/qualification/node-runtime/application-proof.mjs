// TEST ONLY. Provider-free stdio MCP exercise in the disposable production image.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
assert.equal(process.platform, 'linux');
assert.equal(process.version, 'v24.22.1');
assert.equal(process.versions.modules, '137');
const child = spawn(process.execPath, ['/app/dist/index.js'], { cwd: '/app',
  env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', NODE_ENV: 'test',
    DOLLHOUSE_PORTFOLIO_DIR: '/app/tmp/portfolio', DOLLHOUSE_CACHE_DIR: '/app/tmp/cache' },
  stdio: ['pipe', 'pipe', 'pipe'] });
let bytes = 0, errors = '', complete = false;
const pending = new Map();
const deadline = setTimeout(() => child.kill('SIGKILL'), 12000);
const fail = error => { for (const callback of pending.values()) callback.reject(error); pending.clear(); };
child.on('error', fail);
child.on('exit', (code, signal) => { if (!complete) fail(new Error(`Application exited early (${code}/${signal}): ${errors}`)); });
child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 1024 * 1024) child.kill('SIGKILL'); else errors += chunk; });
createInterface({ input: child.stdout }).on('line', line => {
  bytes += Buffer.byteLength(line);
  if (bytes > 1024 * 1024) { fail(new Error('Application output limit')); child.kill('SIGKILL'); return; }
  let response; try { response = JSON.parse(line); } catch { return; }
  if (pending.has(response.id)) { pending.get(response.id).resolve(response); pending.delete(response.id); }
});
const request = value => new Promise((resolve, reject) => { pending.set(value.id, { resolve, reject }); child.stdin.write(JSON.stringify(value) + '\n'); });
try {
  const initialized = await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'node-runtime-qualification', version: '1.0.0' } } });
  assert.equal(initialized.result?.serverInfo?.name, 'dollhousemcp');
  assert.equal(initialized.error, undefined);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.equal(listed.error, undefined);
  assert.ok(Array.isArray(listed.result?.tools) && listed.result.tools.length > 0);
  console.log(JSON.stringify({ initialize: true, toolsList: true, toolCount: listed.result.tools.length,
    version: process.version, modules: process.versions.modules, providersCalled: false }));
  complete = true;
} finally {
  clearTimeout(deadline); child.stdin.end(); child.kill('SIGTERM');
  const kill = setTimeout(() => child.kill('SIGKILL'), 1000);
  await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });
  clearTimeout(kill);
}
