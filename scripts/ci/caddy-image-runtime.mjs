// Isolated native qualification only. No deployment, production mounts or ACME.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { waitForReady, hardenedRuntimeConfig } from './export-tested-caddy-image.mjs';

const [image, fixtureImage, connection] = process.argv.slice(2);
assert.match(image ?? '', /^(?:sha256:)?[a-f0-9]{64}$/);
assert.match(fixtureImage ?? '', /^(?:sha256:)?[a-f0-9]{64}$/);
if (connection) assert.equal(connection, 'ubuntu-dev-work');
const engineArgs = connection ? ['--connection', connection] : [];
// Supported qualification hosts use fixed system-owned executables. Do not
// resolve an executable through a caller-controlled PATH.
const engineExecutable = connection ? '/usr/local/bin/podman' : '/usr/bin/docker';
const engine = (args, options = {}) => execFileSync(engineExecutable, [...engineArgs, ...args], {
  encoding: 'utf8', timeout: 90_000, maxBuffer: 2_000_000, ...options,
}).trim();
const execFileAsync = promisify(execFile);
const engineAsync = args => execFileAsync(engineExecutable, [...engineArgs, ...args], {
  encoding:'utf8', timeout:90_000, maxBuffer:2_000_000,
});
const inspect = id => JSON.parse(engine(['inspect', id]))[0];
const prefix = `caddy-qual-${randomUUID()}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-image-qual-'));
const ownedContainers = [];
const ownedVolumes = [];
let network;
let normalStop;
let processProfile;
let negativeWithoutCapability;
let legacyVolumeRefusal;
const observations = [];
const configSources = [];
let primaryError;
const root = fileURLToPath(new URL('../../', import.meta.url));
const renderer = path.join(root, 'scripts/hosted-deploy/render.sh');
const rendererSha = createHash('sha256').update(fs.readFileSync(renderer)).digest('hex');
const harnessSha = createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const marker = 'CADDY_PUBLIC_QUALIFICATION_SECRET_MARKER';

function container(args) {
  const id = engine(['create', '--pull=never', ...args]);
  assert.match(id, /^[a-f0-9]{64}$/);
  ownedContainers.push(id);
  return id;
}

function volume(suffix) {
  const name=`${prefix}-${suffix}`;
  engine(['volume','create',name]);
  ownedVolumes.push(name);
  return name;
}

async function assertRefused(id, expected, allowLaunchFailure = false) {
  let launchError;
  try { engine(['start',id]); } catch(error) { launchError=error; }
  if(launchError){
    if(!allowLaunchFailure) throw launchError;
    assert.match(String(launchError.stderr),expected);
    assert.equal(inspect(id).State.Running,false);
    return { phase:'runtime-launch-rejected',errorStatus:launchError.status,running:false,diagnostic:String(launchError.stderr).slice(0,480) };
  }
  const stopped=await waitForReady(()=>{
    const state=inspect(id).State;
    return {status:state.Running?503:200,state};
  },{}, {attempts:10});
  assert.notEqual(stopped.state.ExitCode,0);
  assert.equal(stopped.state.OOMKilled,false);
  const logs=spawnSync(engineExecutable,[...engineArgs,'logs',id],{encoding:'utf8',timeout:10_000});
  assert.equal(logs.status,0);
  const combined=`${logs.stdout}\n${logs.stderr}`;
  assert.match(combined,expected);
  const diagnostic=combined.split('\n').filter(line=>expected.test(line)).slice(0,3).map(line=>line.slice(0,480));
  return {phase:'service-refused',exitCode:stopped.state.ExitCode,running:false,oomKilled:false,diagnostic};
}

function render(mode, trusted) {
  const file = path.join(work, 'Caddyfile');
  execFileSync('/bin/bash', ['-c', 'source "$1"; write_caddyfile', 'render', renderer], {
    env: { ...process.env, PROXY_MODE: mode, HOSTNAME: 'fixture.local',
      HTTP_BIND_PORT: '80', MCP_PORT: '8081', CADDY_FILE: file,
      CADDY_ACCESS_LOG: 'true', CADDY_TRUSTED_PROXIES: trusted },
    encoding: 'utf8', timeout: 10_000,
  });
  let text = fs.readFileSync(file, 'utf8');
  const adjustments = [];
  if (mode === 'caddy-tls') {
    // A clearly labeled capability fixture: real renderer directives, a
    // internal CA, never a real ACME/DNS/email request. Real ports 80/443
    // remain subject to the explicit privileged-port sysctl/capability proof.
    text = text.replace('{\n', '{\n\tlocal_certs\n');
    adjustments.push('local_certs global option');
  }
  // Public test config, materialized freshly inside a private 0700 directory;
  // copied into the nonroot candidate as readable configuration, never secrets.
  fs.writeFileSync(file, text, { mode: 0o644 });
  configSources.push({ rendererSha256: rendererSha, mode, adjustments,
    configSha256: createHash('sha256').update(text).digest('hex') });
  return file;
}

const clientSource = String.raw`
const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const fs = require('node:fs');
const options = JSON.parse(process.argv[1]);
let body = '';
let status;
let protocol;
const started = performance.now();
let firstDataMs;
let cursor=0;
const eventTimesMs=[];
const data = bytes => {
 firstDataMs ??= performance.now()-started;
 body+=bytes;
 let boundary=body.indexOf('\n\n',cursor);
 while(boundary!==-1){eventTimesMs.push(performance.now()-started);cursor=boundary+2;boundary=body.indexOf('\n\n',cursor);}
};
const done = () => {
 const elapsedMs=performance.now()-started;
 console.log(JSON.stringify({ status, body, protocol, method:options.method??'GET', elapsedMs, firstDataMs, eventTimesMs,
  quietGapMs:(eventTimesMs[1]??elapsedMs)-eventTimesMs[0] }));
};
if (options.h2) {
  const session = http2.connect('https://proxy:443', { servername: 'fixture.local', ca: fs.readFileSync('/tmp/qualification-ca.crt') });
  session.on('error', error => { console.error(error.code); process.exitCode=1; });
  const req = session.request({ ':path': options.path, ':authority': 'fixture.local', ':method':options.method??'GET', ...options.headers });
  req.setTimeout(80000, () => { req.destroy(new Error('qualification request timeout')); });
  req.on('response', headers => { status=headers[':status']; protocol=session.alpnProtocol; });
  req.on('data', data);
  req.on('end', () => { done(); session.close(); });
  req.on('error', error => { console.error(error.code); session.destroy(); process.exitCode=1; });
  req.end(options.body);
} else {
  const transport=options.tls?https:http;
  const tlsOptions=options.tls?{ servername:'fixture.local',ca:fs.readFileSync('/tmp/qualification-ca.crt'),ALPNProtocols:['http/1.1'] }:{};
  const req = transport.request({ hostname:'proxy', port:options.tls?443:80, path:options.path,method:options.method??'GET',...tlsOptions,
    headers:{ host:'fixture.local', ...options.headers }, timeout:80000 }, res => {
    status=res.statusCode;
    protocol='http/'+res.httpVersion;
    res.on('data', data);
    res.on('end', done);
  });
  req.on('error', error => { console.error(error.code); process.exitCode=1; });
  req.on('timeout', () => req.destroy(new Error('qualification request timeout')));
  req.end(options.body);
}
`;

const upstreamSource = String.raw`
const http=require('node:http');
http.createServer((req,res)=>{
 if(req.url==='/quiet') {
  res.writeHead(200, {'content-type':'text/event-stream','cache-control':'no-cache'});
  res.write('event: start\ndata: method='+req.method+'\n\n');
  setTimeout(()=>res.end('event: done\ndata: survived\n\n'),76000);
 } else {
  res.writeHead(200, {'content-type':'application/json'});
  res.end(JSON.stringify({headers:req.headers,url:req.url}));
 }
}).listen(8081,'0.0.0.0');
`;

function accessLogs(id) {
  const result = spawnSync(engineExecutable, [...engineArgs, 'logs', id], { encoding:'utf8', timeout:10_000, maxBuffer:2_000_000 });
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
  const expectedConfig = hardenedRuntimeConfig(JSON.parse(fs.readFileSync(path.join(root, 'docker/caddy/approved-runtime-config.json'), 'utf8')));
  for (const [key, expected] of Object.entries(expectedConfig)) {
    let actual = imageInfo.Config[key] ?? null;
    // Preserve engine normalization for unchanged nullable base fields; USER
    // must match the intentionally hardened first-party profile exactly.
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
  for (const suffix of ['data', 'config', 'caddyfile']) volume(suffix);
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
  const requestAsync = async options => JSON.parse((await engineAsync(['exec', upstream, 'node', '-e', clientSource, JSON.stringify(options)])).stdout.trim());
  const proxy = container(['--name', `${prefix}-proxy`, '--network', network,
    '--network-alias', 'proxy', '--volume', `${ownedVolumes[0]}:/data`,
    '--volume', `${ownedVolumes[1]}:/config`, '--volume', `${ownedVolumes[2]}:/etc/caddy:ro`,
    '--read-only', '--cap-drop', 'ALL',
    '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges',
    '--sysctl', 'net.ipv4.ip_unprivileged_port_start=1024',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=32m', image]);
  const installConfig = (mode, trusted) => {
    const text = fs.readFileSync(render(mode, trusted), 'utf8');
    // Model the deployment's read-only Caddyfile mount. Only a separate
    // bounded fixture publisher writes this newly owned public-data volume;
    // the Caddy rootfs and its view of /etc/caddy stay read-only throughout.
    const writer = container(['--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--user', '0:0',
      '--volume', `${ownedVolumes[2]}:/qualification-config`, '--entrypoint', 'node',
      fixtureImage, '-e', 'const fs=require("node:fs");fs.writeFileSync("/qualification-config/Caddyfile.next",process.argv[1],{mode:0o644});fs.renameSync("/qualification-config/Caddyfile.next","/qualification-config/Caddyfile");', text]);
    engine(['start', '--attach', writer]);
    assert.equal(inspect(writer).State.ExitCode,0);
  };
  installConfig('caddy-http', '192.0.2.0/24');
  engine(['start', proxy]);
  await waitForReady(request, { path:'/ready' });
  const processStatus = engine(['exec', proxy, '/bin/cat', '/proc/1/status']);
  const fields = Object.fromEntries(processStatus.split('\n').filter(line => line.includes(':')).map(line => {
    const split=line.indexOf(':');return [line.slice(0,split),line.slice(split+1).trim()];
  }));
  assert.ok(fields.Uid.split(/\s+/).every(value => value === '1001'));
  assert.ok(fields.Gid.split(/\s+/).every(value => value === '1001'));
  assert.equal(fields.NoNewPrivs,'1');
  assert.equal(BigInt('0x'+fields.CapEff),0x400n);
  assert.equal(BigInt('0x'+fields.CapBnd),0x400n);
  const privilegedPortStart = engine(['exec', proxy, '/bin/cat', '/proc/sys/net/ipv4/ip_unprivileged_port_start']);
  assert.equal(privilegedPortStart,'1024');
  assert.equal(inspect(proxy).HostConfig.ReadonlyRootfs,true);
  assert.equal(engine(['exec', proxy, '/bin/busybox', 'stat', '-c', '%u:%g:%a:%h', '/usr/bin/caddy']),'0:0:755:1');
  for (const directory of ['/data','/data/caddy','/config','/config/caddy']) {
    assert.equal(engine(['exec', proxy, '/bin/busybox', 'stat', '-c', '%u:%g:%a', directory]),'1001:1001:750');
  }
  processProfile={uid:1001,gid:1001,noNewPrivs:1,capEffective:fields.CapEff,capBounding:fields.CapBnd,privilegedPortStart:1024,rootFilesystemReadonly:true};
  const noCapability = container(['--name',`${prefix}-no-capability`,'--network',network,
    '--volume',`${volume('no-cap-data')}:/data`,'--volume',`${volume('no-cap-config')}:/config`,
    '--volume',`${ownedVolumes[2]}:/etc/caddy:ro`,'--read-only','--cap-drop','ALL',
    '--security-opt','no-new-privileges','--sysctl','net.ipv4.ip_unprivileged_port_start=1024',
    '--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=32m',image]);
  // Removing the sole capability must prevent this exact low-port service.
  // Some kernels reject capability-marked ELF execution before bind; record
  // that phase explicitly rather than relabeling it a bind syscall failure.
  negativeWithoutCapability=await assertRefused(noCapability,/bind: permission denied|listen tcp.*permission denied|operation not permitted/i,true);
  observations.push('same constrained low-port service fails closed without NET_BIND_SERVICE');
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
  installConfig('caddy-tls', `${addresses[0]}/32`);
  engine(['exec', proxy, 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
  const caFile = path.join(work, 'qualification-ca.crt');
  engine(['cp', `${proxy}:/data/caddy/pki/authorities/local/root.crt`, caFile]);
  engine(['cp', caFile, `${upstream}:/tmp/qualification-ca.crt`]);
  const caSha = createHash('sha256').update(fs.readFileSync(caFile)).digest('hex');
  const h2 = await waitForReady(request, { h2:true, path:'/tls' });
  assert.equal(h2.status, 200);
  assert.equal(JSON.parse(h2.body).headers['x-forwarded-proto'], 'https');
  observations.push('local-CA renderer TLS and HTTP/2 on privileged ports');
  const oldData=volume('legacy-data');
  const seed=container(['--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--user','0:0','--volume',`${oldData}:/legacy`,'--entrypoint','node',fixtureImage,'-e',
    'const fs=require("node:fs");fs.mkdirSync("/legacy/caddy",{mode:0o700});fs.writeFileSync("/legacy/caddy/qualification-marker","public legacy fixture",{mode:0o600});']);
  engine(['start','--attach',seed]);
  assert.equal(inspect(seed).State.ExitCode,0);
  const oldProxy=container(['--name',`${prefix}-legacy-refusal`,'--network',network,
    '--volume',`${oldData}:/data`,'--volume',`${volume('legacy-config')}:/config`,
    '--volume',`${ownedVolumes[2]}:/etc/caddy:ro`,'--read-only','--cap-drop','ALL','--cap-add','NET_BIND_SERVICE',
    '--security-opt','no-new-privileges','--sysctl','net.ipv4.ip_unprivileged_port_start=1024',
    '--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=32m',image]);
  legacyVolumeRefusal=await assertRefused(oldProxy,/permission denied/);
  const checkLegacy=container(['--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--user','0:0','--volume',`${oldData}:/legacy:ro`,'--entrypoint','node',fixtureImage,'-e',
    'const fs=require("node:fs"),assert=require("node:assert/strict");const s=fs.statSync("/legacy/caddy");assert.equal(s.uid,0);assert.equal(s.mode&0o777,0o700);assert.equal(fs.readFileSync("/legacy/caddy/qualification-marker","utf8"),"public legacy fixture");']);
  engine(['start','--attach',checkLegacy]);
  assert.equal(inspect(checkLegacy).State.ExitCode,0);
  observations.push('controlled root-owned legacy-volume fixture refuses unchanged; no automatic migration');
  const post={path:'/quiet',method:'POST',body:'{"jsonrpc":"2.0","id":1,"method":"qualification"}',headers:{'content-type':'application/json'}};
  const streams=await Promise.allSettled([requestAsync({...post,tls:true}),requestAsync({...post,h2:true})]);
  const failures=streams.filter(result=>result.status==='rejected').map(result=>result.reason);
  if(failures.length) throw new AggregateError(failures,'independent POST SSE streams failed');
  const quietStreams=streams.map(result=>result.value);
  assert.deepEqual(quietStreams.map(result=>result.protocol),['http/1.1','h2']);
  for(const stream of quietStreams){
    assert.equal(stream.status,200);
    assert.equal(stream.method,'POST');
    assert.match(stream.body,/event: start\ndata: method=POST/);
    assert.match(stream.body,/event: done\ndata: survived/);
    assert.equal(stream.eventTimesMs.length,2);
    assert.ok(stream.quietGapMs>=75_000,'SSE frames buffered or quiet event interval too short');
  }
  observations.push('concurrent MCP-like POST SSE over TLS H1 and H2, each true event gap at least 75 seconds');
  engine(['stop', '--time', '10', proxy]);
  const stopped = inspect(proxy).State;
  assert.equal(stopped.Running, false);
  assert.equal(stopped.ExitCode, 0, 'normal stop must not hide SIGKILL escalation');
  assert.equal(stopped.OOMKilled, false);
  normalStop = { running:stopped.Running, exitCode:stopped.ExitCode, oomKilled:stopped.OOMKilled };
  engine(['start', proxy]);
  engine(['cp', `${proxy}:/data/caddy/pki/authorities/local/root.crt`, caFile]);
  assert.equal(createHash('sha256').update(fs.readFileSync(caFile)).digest('hex'), caSha);
  assert.equal((await waitForReady(request, { h2:true, path:'/after-restart' })).status, 200);
  observations.push('same private volumes preserve internal PKI across normal restart');
  console.log(JSON.stringify({ imageId:imageInfo.Id, architecture:imageInfo.Architecture,
    nativeDaemonArchitecture:native, rendererSha256:rendererSha, harnessSha256:harnessSha, configSources, observations,
    quietStreams:quietStreams.map(({body,...metrics})=>metrics), processProfile, negativeWithoutCapability, legacyVolumeRefusal, normalStop,
    productionActions:false }, null, 2));
} catch (error) {
  primaryError = error;
  console.error(JSON.stringify({ qualificationFailure:true, rendererSha256:rendererSha, harnessSha256:harnessSha, configSources, observations, processProfile, negativeWithoutCapability, legacyVolumeRefusal, normalStop }));
} finally {
  // Every identity here was created by this invocation; no broad pruning.
  const errors = primaryError ? [primaryError] : [];
  const cleanup = operation => { try { operation(); } catch (error) { errors.push(error); } };
  ownedContainers.reverse();
  for (const id of ownedContainers) cleanup(() => engine(['rm', '--force', id]));
  for (const name of ownedVolumes) cleanup(() => engine(['volume', 'rm', name]));
  if (network) cleanup(() => engine(['network', 'rm', network]));
  cleanup(() => fs.rmSync(work, { recursive:true, force:true }));
  if (errors.length) throw new AggregateError(errors, 'Caddy qualification or owned-resource cleanup failed');
}
