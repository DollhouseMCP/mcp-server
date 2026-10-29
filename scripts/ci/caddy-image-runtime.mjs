// Isolated native qualification only. No deployment, production mounts or ACME.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [image, fixtureImage, connection] = process.argv.slice(2);
assert.match(image ?? '', /^(?:sha256:)?[a-f0-9]{64}$/);
assert.match(fixtureImage ?? '', /^(?:sha256:)?[a-f0-9]{64}$/);
if (connection) assert.equal(connection, 'ubuntu-dev-work');
const engineArgs = connection ? ['--connection', connection] : [];
const engine = (args, options = {}) => execFileSync('docker', [...engineArgs, ...args], {
  encoding: 'utf8', timeout: 90_000, maxBuffer: 2_000_000, ...options,
}).trim();
const inspect = id => JSON.parse(engine(['inspect', id]))[0];
const prefix = `caddy-qual-${randomUUID()}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-image-qual-'));
const ownedContainers = [];
const ownedVolumes = [];
let network;
let normalStop;
const observations = [];
const configSources = [];
let primaryError;
const root = fileURLToPath(new URL('../../', import.meta.url));
const renderer = path.join(root, 'scripts/hosted-deploy/render.sh');
const rendererSha = createHash('sha256').update(fs.readFileSync(renderer)).digest('hex');
const marker = 'CADDY_PUBLIC_QUALIFICATION_SECRET_MARKER';

function container(args) {
  const id = engine(['create', '--pull=never', ...args]);
  assert.match(id, /^[a-f0-9]{64}$/);
  ownedContainers.push(id);
  return id;
}

function render(mode, trusted) {
  const file = path.join(work, 'Caddyfile');
  execFileSync('bash', ['-c', 'source "$1"; write_caddyfile', 'render', renderer], {
    env: { ...process.env, PROXY_MODE: mode, HOSTNAME: 'fixture.local',
      HTTP_BIND_PORT: '8080', MCP_PORT: '8081', CADDY_FILE: file,
      CADDY_ACCESS_LOG: 'true', CADDY_TRUSTED_PROXIES: trusted },
    encoding: 'utf8', timeout: 10_000,
  });
  let text = fs.readFileSync(file, 'utf8');
  const adjustments = [];
  if (mode === 'caddy-tls') {
    // A clearly labeled capability fixture: real renderer directives, a
    // local test port and internal CA, never a real ACME/DNS/email request.
    text = text.replace('{\n', '{\n\tlocal_certs\n').replace('\nfixture.local {', '\nfixture.local:8443 {');
    adjustments.push('local_certs global option', 'fixture.local TLS port 8443');
  }
  fs.writeFileSync(file, text, { mode: 0o600 });
  configSources.push({ rendererSha256: rendererSha, mode, adjustments,
    configSha256: createHash('sha256').update(text).digest('hex') });
  return file;
}

const clientSource = `
const http = require('node:http');
const http2 = require('node:http2');
const fs = require('node:fs');
const options = JSON.parse(process.argv[1]);
let body = '';
let status;
const started = performance.now();
let firstDataMs;
const done = () => { const elapsedMs=performance.now()-started; console.log(JSON.stringify({ status, body, elapsedMs, firstDataMs, quietGapMs:elapsedMs-firstDataMs })); };
if (options.h2) {
  const session = http2.connect('https://proxy:8443', { servername: 'fixture.local', ca: fs.readFileSync('/tmp/qualification-ca.crt') });
  session.on('error', error => { console.error(error.code); process.exitCode=1; });
  const req = session.request({ ':path': options.path, ':authority': 'fixture.local:8443', ...options.headers });
  req.setTimeout(80000, () => { req.destroy(new Error('qualification request timeout')); });
  req.on('response', headers => { status=headers[':status']; });
  req.on('data', bytes => { firstDataMs ??= performance.now()-started; body+=bytes; });
  req.on('end', () => { done(); session.close(); });
  req.on('error', error => { console.error(error.code); session.destroy(); process.exitCode=1; });
  req.end();
} else {
  const req = http.get({ hostname:'proxy', port:8080, path:options.path,
    headers:{ host:'fixture.local', ...options.headers }, timeout:80000 }, res => {
    status=res.statusCode;
    res.on('data', bytes => { firstDataMs ??= performance.now()-started; body+=bytes; });
    res.on('end', done);
  });
  req.on('error', error => { console.error(error.code); process.exitCode=1; });
  req.on('timeout', () => req.destroy(new Error('qualification request timeout')));
}
`;

const upstreamSource = `
const http=require('node:http');
http.createServer((req,res)=>{
 if(req.url==='/quiet') {
  res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache'});
  res.write('event: start\\ndata: ready\\n\\n');
  setTimeout(()=>res.end('event: done\\ndata: survived\\n\\n'),76000);
 } else {
  res.writeHead(200, {'content-type':'application/json'});
  res.end(JSON.stringify({headers:req.headers,url:req.url}));
 }
}).listen(8081,'0.0.0.0');
`;

async function waitReady(request, options) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { const response = request(options); if (response.status === 200) return response; } catch { /* bounded startup only */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('isolated proxy did not become ready');
}

function accessLogs(id) {
  const result = spawnSync('docker', [...engineArgs, 'logs', id], { encoding:'utf8', timeout:10_000, maxBuffer:2_000_000 });
  assert.equal(result.status, 0);
  const entries = `${result.stdout}\n${result.stderr}`.split('\n').flatMap(line => {
    try { const item = JSON.parse(line); return item.request ? [item] : []; } catch { return []; }
  });
  assert.ok(entries.length > 0, 'no actual access-log entries observed');
  return entries;
}

try {
  const imageInfo = inspect(image);
  assert.equal(imageInfo.Os, 'linux');
  const expectedConfig = JSON.parse(fs.readFileSync(path.join(root, 'docker/caddy/approved-runtime-config.json'), 'utf8'));
  for (const [key, expected] of Object.entries(expectedConfig)) {
    let actual = imageInfo.Config[key] ?? null;
    // Engine inspect represents the inherited default root user as either
    // null or an empty string; these have the same upstream runtime meaning.
    if (key === 'User' && actual === '') actual = null;
    assert.deepEqual(actual, expected, `upstream runtime config changed: ${key}`);
  }
  const engineInfo = JSON.parse(engine(['info', '--format', '{{json .}}']));
  const reportedArch = engineInfo.Architecture ?? engineInfo.host?.arch ?? engineInfo.Host?.Arch;
  const native = { aarch64:'arm64', arm64:'arm64', x86_64:'amd64', amd64:'amd64' }[reportedArch];
  assert.ok(native, 'unsupported or missing daemon architecture');
  assert.equal(imageInfo.Architecture, native, 'candidate must run on matching native daemon');
  assert.equal(inspect(fixtureImage).Architecture, native, 'fixture must run on matching native daemon');
  network = engine(['network', 'create', '--internal', prefix]);
  for (const suffix of ['data', 'config']) {
    const name = `${prefix}-${suffix}`;
    engine(['volume', 'create', name]);
    ownedVolumes.push(name);
  }
  const upstream = container(['--name', `${prefix}-upstream`, '--network', network,
    '--network-alias', 'dollhousemcp', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--user', '65534:65534', '--entrypoint', 'node', fixtureImage, '-e', upstreamSource]);
  engine(['start', upstream]);
  const upstreamInfo = inspect(upstream);
  const addresses = Object.values(upstreamInfo.NetworkSettings.Networks).map(x => x.IPAddress).filter(Boolean);
  assert.equal(addresses.length, 1);
  assert.match(addresses[0], /^\d{1,3}(\.\d{1,3}){3}$/);
  const request = options => JSON.parse(engine(['exec', upstream, 'node', '-e', clientSource, JSON.stringify(options)]));
  const proxy = container(['--name', `${prefix}-proxy`, '--network', network,
    '--network-alias', 'proxy', '--volume', `${ownedVolumes[0]}:/data`,
    '--volume', `${ownedVolumes[1]}:/config`, image]);
  const installConfig = (mode, trusted) => {
    engine(['cp', render(mode, trusted), `${proxy}:/etc/caddy/Caddyfile`]);
  };
  installConfig('caddy-http', '192.0.2.0/24');
  engine(['start', proxy]);
  await waitReady(request, { path:'/ready' });
  const forwarded = { 'x-forwarded-for':'203.0.113.7' };
  const untrusted = JSON.parse(request({ path:'/untrusted', headers:forwarded }).body);
  assert.equal(untrusted.headers['x-forwarded-for'], addresses[0]);
  assert.equal(untrusted.headers['x-forwarded-proto'], 'http');
  assert.equal(untrusted.headers.host, 'fixture.local');
  observations.push('current-renderer HTTP/untrusted forwarding');
  installConfig('caddy-http', `${addresses[0]}/32`);
  engine(['exec', proxy, 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
  const trusted = JSON.parse(request({ path:'/trusted', headers:forwarded }).body);
  assert.equal(trusted.headers['x-forwarded-for'], '203.0.113.7');
  observations.push('current-renderer reload/trusted forwarding');
  assert.equal(request({ path:`/redaction?access_token=${marker}&code=${marker}`, headers:{ authorization:`Bearer ${marker}`, cookie:`session=${marker}`, 'x-onboarding-csrf':marker } }).status, 200);
  const logs = accessLogs(proxy);
  assert.ok(logs.some(entry => entry.request.uri.includes('/redaction')), 'redaction request missing from access logs');
  assert.ok(!JSON.stringify(logs).includes(marker), 'sensitive fixture value reached access logs');
  observations.push('current-renderer access-log query/header redaction');
  const quiet = request({ path:'/quiet' });
  assert.equal(quiet.status, 200);
  assert.match(quiet.body, /event: done\ndata: survived/);
  assert.ok(quiet.quietGapMs >= 75_000, 'SSE events were buffered instead of streaming across the required quiet interval');
  observations.push('current-renderer quiet SSE with at least 75 seconds between first and final data');
  installConfig('caddy-tls', `${addresses[0]}/32`);
  engine(['exec', proxy, 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
  const caFile = path.join(work, 'qualification-ca.crt');
  engine(['cp', `${proxy}:/data/caddy/pki/authorities/local/root.crt`, caFile]);
  engine(['cp', caFile, `${upstream}:/tmp/qualification-ca.crt`]);
  const caSha = createHash('sha256').update(fs.readFileSync(caFile)).digest('hex');
  const h2 = await waitReady(request, { h2:true, path:'/tls' });
  assert.equal(h2.status, 200);
  assert.equal(JSON.parse(h2.body).headers['x-forwarded-proto'], 'https');
  observations.push('labeled local-CA/port-adjusted renderer TLS and HTTP/2');
  engine(['stop', '--time', '10', proxy]);
  const stopped = inspect(proxy).State;
  assert.equal(stopped.Running, false);
  assert.equal(stopped.ExitCode, 0, 'normal stop must not hide SIGKILL escalation');
  assert.equal(stopped.OOMKilled, false);
  normalStop = { running:stopped.Running, exitCode:stopped.ExitCode, oomKilled:stopped.OOMKilled };
  engine(['start', proxy]);
  engine(['cp', `${proxy}:/data/caddy/pki/authorities/local/root.crt`, caFile]);
  assert.equal(createHash('sha256').update(fs.readFileSync(caFile)).digest('hex'), caSha);
  assert.equal((await waitReady(request, { h2:true, path:'/after-restart' })).status, 200);
  observations.push('same private volumes preserve internal PKI across normal restart');
  console.log(JSON.stringify({ imageId:imageInfo.Id, architecture:imageInfo.Architecture,
    nativeDaemonArchitecture:native, rendererSha256:rendererSha, configSources, observations,
    quietStreamElapsedMs:quiet.elapsedMs, firstEventMs:quiet.firstDataMs, quietStreamGapMs:quiet.quietGapMs, normalStop,
    productionActions:false }, null, 2));
} catch (error) {
  primaryError = error;
} finally {
  // Every identity here was created by this invocation; no broad pruning.
  const errors = primaryError ? [primaryError] : [];
  const cleanup = operation => { try { operation(); } catch (error) { errors.push(error); } };
  for (const id of ownedContainers.reverse()) cleanup(() => engine(['rm', '--force', id]));
  for (const name of ownedVolumes) cleanup(() => engine(['volume', 'rm', name]));
  if (network) cleanup(() => engine(['network', 'rm', network]));
  cleanup(() => fs.rmSync(work, { recursive:true, force:true }));
  if (errors.length) throw new AggregateError(errors, 'Caddy qualification or owned-resource cleanup failed');
}
