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
import { writeNativeCaddyfile } from './caddy-native-render.mjs';
import { clientExecFailure, collectOwnedDiagnostics, parseClientOutput } from './caddy-stream-guard.mjs';
import { clientSource } from './caddy-stream-client.mjs';
import { upstreamSource } from './caddy-stream-upstream.mjs';

const [image, fixtureImage, inspectorFile, connection] = process.argv.slice(2);
assert.match(image ?? '', /^(?:sha256:)?[a-f0-9]{64}$/);
assert.match(fixtureImage ?? '', /^(?:sha256:)?[a-f0-9]{64}$/);
if (connection) assert.equal(connection, 'ubuntu-dev-work');
assert.ok(path.isAbsolute(inspectorFile));
assert.ok(fs.lstatSync(inspectorFile).isFile(), 'runtime inspector must be a regular file');
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
let nativeCopy;
let servingCapabilities;
let streamOutcomes;
let upstreamDiagnosticId;
let proxyDiagnosticId;
const observations = [];
const configSources = [];
let primaryError;
const root = fileURLToPath(new URL('../../', import.meta.url));
const renderer = path.join(root, 'scripts/hosted-deploy/render.sh');
const rendererSha = createHash('sha256').update(fs.readFileSync(renderer)).digest('hex');
const harnessSha = createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const guardSha = createHash('sha256').update(fs.readFileSync(new URL('./caddy-stream-guard.mjs', import.meta.url))).digest('hex');
const clientSha = createHash('sha256').update(fs.readFileSync(new URL('./caddy-stream-client.mjs', import.meta.url))).digest('hex');
const upstreamSha = createHash('sha256').update(fs.readFileSync(new URL('./caddy-stream-upstream.mjs', import.meta.url))).digest('hex');
const upstreamSourceSha = createHash('sha256').update(upstreamSource).digest('hex');
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
  writeNativeCaddyfile(work, file, mode, trusted);
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
  const diagnosticVolume = volume('diagnostic');
  const diagnosticWriter = container(['--interactive', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--user', '0:0', '--volume', `${diagnosticVolume}:/qualification`,
    '--entrypoint', 'node', fixtureImage, '-e',
    'const fs=require("node:fs");fs.writeFileSync("/qualification/inspect-runtime",fs.readFileSync(0),{flag:"wx",mode:0o755});']);
  engine(['start', '--attach', '--interactive', diagnosticWriter], { input:fs.readFileSync(inspectorFile) });
  assert.equal(inspect(diagnosticWriter).State.ExitCode, 0);
  const upstream = container(['--name', `${prefix}-upstream`, '--network', network,
    '--network-alias', 'dollhousemcp', '--read-only', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--user', '65534:65534', '--entrypoint', 'node', fixtureImage, '-e', upstreamSource]);
  upstreamDiagnosticId = upstream;
  engine(['start', upstream]);
  const upstreamInfo = inspect(upstream);
  const addresses = Object.values(upstreamInfo.NetworkSettings.Networks).map(x => x.IPAddress).filter(Boolean);
  assert.equal(addresses.length, 1);
  assert.match(addresses[0], /^\d{1,3}(\.\d{1,3}){3}$/);
  const request = options => JSON.parse(engine(['exec', upstream, 'node', '-e', clientSource, JSON.stringify(options)]));
  const requestAsync = async options => {
    const start = performance.now();
    try {
      const result = await engineAsync(['exec', upstream, 'node', '-e', clientSource, JSON.stringify(options)]);
      return parseClientOutput(options, result, performance.now() - start);
    } catch (error) {
      if (error.stdout !== undefined || error.stderr !== undefined) {
        throw new Error(clientExecFailure(options, error, performance.now() - start));
      }
      throw error;
    }
  };
  const proxy = container(['--name', `${prefix}-proxy`, '--network', network,
    '--network-alias', 'proxy', '--mount', `type=volume,source=${diagnosticVolume},target=/qualification,readonly`, '--volume', `${ownedVolumes[0]}:/data`,
    '--volume', `${ownedVolumes[1]}:/config`, '--volume', `${ownedVolumes[2]}:/etc/caddy:ro`,
    '--read-only', '--cap-drop', 'ALL',
    '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges',
    '--sysctl', 'net.ipv4.ip_unprivileged_port_start=1024',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=32m', image]);
  proxyDiagnosticId = proxy;
  const proxyHost = inspect(proxy).HostConfig;
  const boundedCapabilities = value => Array.isArray(value) && value.length <= 32 &&
    value.every(cap => typeof cap === 'string' && /^[A-Z0-9_]{1,48}$/.test(cap)) ? value : null;
  servingCapabilities = {capAdd:boundedCapabilities(proxyHost.CapAdd), capDrop:boundedCapabilities(proxyHost.CapDrop)};
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
  const evidence = JSON.parse(engine(['exec', proxy, '/qualification/inspect-runtime']));
  const fields = Object.fromEntries(evidence.status.split('\n').filter(line => line.includes(':')).map(line => {
    const split=line.indexOf(':');return [line.slice(0,split),line.slice(split+1).trim()];
  }));
  assert.ok(fields.Uid.split(/\s+/).every(value => value === '1001'));
  assert.ok(fields.Gid.split(/\s+/).every(value => value === '1001'));
  assert.equal(fields.NoNewPrivs,'1');
  assert.equal(BigInt('0x'+fields.CapEff),0x400n);
  assert.equal(BigInt('0x'+fields.CapBnd),0x400n);
  assert.equal(evidence.portStart, '1024');
  assert.equal(inspect(proxy).HostConfig.ReadonlyRootfs,true);
  assert.deepEqual(evidence.paths['/usr/bin/caddy'], { UID:0, GID:0, Mode:0o100755, Links:1 });
  for (const directory of ['/data','/data/caddy','/config','/config/caddy']) {
    const { UID, GID, Mode } = evidence.paths[directory];
    assert.deepEqual({ UID, GID, Mode }, { UID:1001, GID:1001, Mode:0o40750 });
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
  if (!connection && process.platform === 'linux') {
    const volumeRoot = JSON.parse(engine(['volume', 'inspect', ownedVolumes[2]]))[0].Mountpoint;
    assert.match(volumeRoot, /^\/var\/lib\/docker\/volumes\//);
    const token = randomUUID().replaceAll('-', '');
    const nativeScript = path.join(root, 'scripts/ci/caddy-release-native.py');
    const runControl = action => JSON.parse(execFileSync('/usr/bin/sudo', ['-n', '/usr/bin/python3', nativeScript,
      action, proxy, volumeRoot, volumeRoot, token, `${addresses[0]}/32`],
    {encoding:'utf8',timeout:action === 'refuse-load' ? 45_000 : 120_000,maxBuffer:65536}));
    const begin = runControl('begin');
    const refused = runControl('refuse-load');
    assert.equal(refused.failure.context.identity.id, proxy);
    assert.equal(refused.failure.outcome, 'UNKNOWN');
    assert.equal(refused.forward_applied, false);
    const probeSource = String.raw`
const http=require('node:http'); const http2=require('node:http2'); const net=require('node:net');
const mode=process.argv[1], token=process.argv[2];
let settled=false; const finish=ok=>{if(!settled){settled=true;process.exit(ok?0:2);}};
process.on('beforeExit',()=>{if(!settled)process.exitCode=2;}); setTimeout(()=>finish(false),2000);
if(mode==='h2') { const s=http2.connect('http://proxy:80'); s.on('error',()=>finish(true)); const q=s.request({':method':'GET',':path':'/healthz',':authority':'fixture.local'},{endStream:false}); q.on('error',()=>finish(true)); q.on('close',()=>finish(true)); q.on('response',()=>finish(false)); q.end('unexpected'); }
else if(mode==='conflict'||mode==='cl-conflict'||mode==='aborted') { const s=net.connect(80,'proxy',()=>{s.end(mode==='conflict'?'GET /healthz HTTP/1.1\r\nHost: fixture.local\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n':mode==='cl-conflict'?'GET /healthz HTTP/1.1\r\nHost: fixture.local\r\nContent-Length: 0\r\nContent-Length: 4\r\n\r\nx':'GET /healthz HTTP/1.1\r\nHost: fixture.local\r\nContent-Length: 4\r\n\r\nx')});let data='';s.on('data',x=>data+=x);s.on('error',()=>finish(true));s.on('close',()=>finish(!/200 OK/i.test(data))); }
else { const allowed=mode.startsWith('allowed'); const headers={'host':'fixture.local','content-length':'0'}; if(mode==='auth')headers.authorization='Bearer fixture'; if(mode==='cookie')headers.cookie='x=y'; const path=mode==='query'?'/healthz?x=1':mode==='allowed-ready'?'/readyz':mode==='allowed-mcp'?'/mcp':'/healthz'; const r=http.request({host:'proxy',port:80,path,method:mode==='post'?'POST':'GET',headers},res=>{res.on('aborted',()=>finish(false));res.on('error',()=>finish(false));res.resume();res.on('end',()=>finish(res.complete&&(allowed ? res.statusCode===(mode==='allowed-mcp'?401:200) : res.statusCode===503)&&res.headers['x-dollhouse-verification']===token));});r.on('error',()=>finish(false));r.end(); }
`;
    const probe = mode => engine(['exec', upstream, 'node', '-e', probeSource, mode, token]);
    const probeCount = () => engine(['logs', upstream]).split('\n').filter(line => line.includes('"fixture":"probe"')).length;
    const countBefore = probeCount();
    for (const mode of ['allowed','allowed-ready','allowed-mcp']) probe(mode);
    for (const mode of ['query','auth','cookie','post','conflict','cl-conflict','aborted','h2']) probe(mode);
    assert.equal(probeCount(), countBefore + 3, 'unsafe framing or request reached the upstream');
    const stopped = runControl('stop-witness');
    assert.equal(stopped.id, proxy);
    assert.equal(stopped.clean_stop, true);
    assert.equal(inspect(proxy).State.ExitCode, 0);
    engine(['start', proxy]);
    await waitForReady(request, {path:'/healthz',headers:{'content-length':'0'}}, {attempts:10});
    const restarted = runControl('check');
    for (const mode of ['allowed','allowed-ready','allowed-mcp']) probe(mode);
    const restored = runControl('finish');
    assert.equal(request({path:'/ready'}).status, 200);
    observations.push('real private admin load/readback, restart-persistent fence, marker and framing denials, then normal-profile restoration');
    const hashSource = source => createHash('sha256').update(fs.readFileSync(path.join(root, source))).digest('hex');
    // The adapt control must work on both Caddy generations a deployment
    // meets. The legacy fixture is the stock image with its stock profile and
    // a public proxy-only Caddyfile; it is not a live legacy profile or receipt.
    const legacyImage = process.env.CADDY_LEGACY_IMAGE_ID ?? '';
    assert.match(legacyImage, /^sha256:[a-f0-9]{64}$/, 'legacy Caddy fixture image is required');
    const legacyInfo = inspect(legacyImage);
    assert.equal(legacyInfo.Architecture, native, 'legacy fixture must run on matching native daemon');
    assert.ok(legacyInfo.Config.Env.includes('CADDY_VERSION=v2.8.4'), 'legacy fixture must be Caddy 2.8.4');
    const legacyFile = path.join(work, 'legacy.Caddyfile');
    fs.writeFileSync(legacyFile, 'fixture.local:80 {\n\treverse_proxy dollhousemcp:8081\n}\n', {flag:'wx', mode:0o644});
    const legacyProxy = container(['--name', `${prefix}-legacy-adapt`, '--network', network, legacyImage]);
    engine(['cp', legacyFile, `${legacyProxy}:/etc/caddy/Caddyfile`]);
    engine(['start', legacyProxy]);
    await waitForReady(() => {
      // Loopback admin API inside the fixture's own network namespace.
      engine(['exec', legacyProxy, 'wget', '-q', '-O', '/dev/null', '127.0.0.1:2019/config/']);
      return {status:200};
    }, {}, {attempts:15});
    const adaptScript = 'scripts/ci/caddy-adapt-native.py';
    const adaptWitness = (id, file) => JSON.parse(execFileSync('/usr/bin/sudo', ['-n', '/usr/bin/python3',
      path.join(root, adaptScript), id], {input:fs.readFileSync(file), encoding:'utf8', timeout:120_000, maxBuffer:65536}));
    const legacyAdapt = adaptWitness(legacyProxy, legacyFile);
    assert.equal(legacyAdapt.container, legacyProxy);
    assert.equal(legacyAdapt.serving_configuration_matches, true);
    // Without this refusal the fixture would not be the generation that failed.
    assert.equal(legacyAdapt.dash_form, 'refused');
    const candidateFile = path.join(work, 'candidate.Caddyfile');
    engine(['cp', `${proxy}:/etc/caddy/Caddyfile`, candidateFile]);
    const candidateAdapt = adaptWitness(proxy, candidateFile);
    assert.equal(candidateAdapt.container, proxy);
    assert.equal(candidateAdapt.serving_configuration_matches, true);
    assert.equal(candidateAdapt.dash_form, 'accepted');
    assert.equal(candidateAdapt.input, legacyAdapt.input);
    assert.equal(legacyAdapt.path_dependent_refused, true);
    assert.equal(candidateAdapt.path_dependent_refused, true);
    observations.push('real adapt control equals the serving configuration on stock Caddy 2.8.4 and on the candidate');
    configSources.push({adaptWitness:{legacy:{...legacyAdapt, imageId:legacyInfo.Id, caddyVersion:'v2.8.4'},
      candidate:candidateAdapt, scriptSha256:hashSource(adaptScript),
      activeConfigSha256:hashSource('scripts/hosted-deploy/caddy_active_config.py')}});
    configSources.push({releaseWitness:{begin,refused,stopped,restarted,restored, scriptSha256:hashSource('scripts/ci/caddy-release-native.py'),
      activeConfigSha256:hashSource('scripts/hosted-deploy/caddy_active_config.py'),
      releaseActionSha256:hashSource('scripts/hosted-deploy/caddy_release_action.py')}});
  }
  assert.equal(request({ path:`/redaction?access_token=${marker}&code=${marker}`, headers:{ authorization:`Bearer ${marker}`, cookie:`session=${marker}`, 'x-onboarding-csrf':marker } }).status, 200);
  const logs = accessLogs(proxy);
  assert.ok(logs.some(entry => entry.request.uri.includes('/redaction')), 'redaction request missing from access logs');
  assert.ok(!JSON.stringify(logs).includes(marker), 'sensitive fixture value reached access logs');
  observations.push('current-renderer access-log query/header redaction');
  installConfig('caddy-tls', `${addresses[0]}/32`);
  engine(['exec', proxy, 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
  const caFile = path.join(work, 'qualification-ca.crt');
  engine(['cp', `${proxy}:/data/caddy/pki/authorities/local/root.crt`, caFile]);
  const caBytes = fs.readFileSync(caFile);
  const caSha = createHash('sha256').update(caBytes).digest('hex');
  // Docker cp rejects a read-only container even for its writable tmpfs.
  // Let the existing unprivileged fixture create only this public CA file.
  const installedCaSha = engine(['exec', upstream, 'node', '-e',
    'const fs=require("node:fs"),assert=require("node:assert/strict"),crypto=require("node:crypto");const p="/tmp/qualification-ca.crt";fs.writeFileSync(p,Buffer.from(process.argv[1],"base64"),{flag:"wx",mode:0o600});const s=fs.lstatSync(p);assert.ok(s.isFile());assert.equal(s.uid,65534);assert.equal(s.gid,65534);assert.equal(s.nlink,1);assert.equal(s.mode&0o777,0o600);process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"));',
    caBytes.toString('base64')]);
  assert.equal(installedCaSha, caSha);
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
  streamOutcomes = streams.map((result, index) => {
    if (result.status === 'rejected') return { protocol:index ? 'h2' : 'http/1.1', status:'rejected',
      diagnostic:String(result.reason?.message ?? result.reason).slice(0, 8192) };
    const value = result.value;
    return { protocol:value.protocol, status:'fulfilled', httpStatus:value.status, method:value.method,
      eventCount:value.eventTimesMs?.length, eventTimesMs:value.eventTimesMs, quietGapMs:value.quietGapMs };
  });
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
  if (!connection) {
    // Disposable rootful-CI copier witness only; it does not qualify a live
    // legacy profile or manufacture an operation receipt.
    engine(['stop', '--signal', 'SIGTERM', '--time', '-1', proxy]);
    const stoppedForCopy = inspect(proxy).State;
    assert.equal(stoppedForCopy.Running, false);
    assert.equal(stoppedForCopy.ExitCode, 0);
    assert.equal(stoppedForCopy.OOMKilled, false);
    const copiedData = volume('copy-data');
    const copiedConfig = volume('copy-config');
    const copyScript = path.join(root, 'scripts/ci/caddy-volume-copy-native.py');
    const copyOptions = {encoding:'utf8', timeout:240_000, maxBuffer:65536,
      env:{...process.env, PYTHONDONTWRITEBYTECODE:'1'}};
    let negativeCopy;
    for (const legacyMode of [0o1775, 0o1777]) {
      const seed = container(['--network', 'none', '--read-only', '--user', '0:0',
        '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--cap-add', 'DAC_OVERRIDE',
        '--security-opt', 'no-new-privileges:true',
        '--mount', `type=volume,source=${ownedVolumes[0]},target=/data,volume-nocopy`,
        '--mount', `type=volume,source=${ownedVolumes[1]},target=/config,volume-nocopy`,
        '--entrypoint', 'node', fixtureImage, '-e',
        'const f=require("node:fs"),p=require("node:path");function own(x){const s=f.lstatSync(x);if(s.isSymbolicLink())throw Error("unexpected symlink");if(s.isDirectory())for(const n of f.readdirSync(x))own(p.join(x,n));else if(!s.isFile())throw Error("unexpected type");f.chownSync(x,0,0)}own("/data");own("/config");for(const x of ["/data","/config"]){f.chmodSync(x,0o755);f.chmodSync(x+"/caddy",Number(process.argv[1]))}',
        String(legacyMode)]);
      engine(['start', '--attach', seed]);
      assert.equal(inspect(seed).State.ExitCode, 0);
      const args = [copyScript, ...(legacyMode === 0o1775 ? ['--expect-unsafe-source'] : []),
        ownedVolumes[0], ownedVolumes[1], copiedData, copiedConfig];
      const result = JSON.parse(execFileSync('/usr/bin/python3', args, copyOptions));
      if (legacyMode === 0o1775) negativeCopy = result;
      else nativeCopy = result;
    }
    assert.equal(negativeCopy.unsafeSourceRefused, true);
    assert.equal(negativeCopy.ownedCleanupConfirmed, true);
    nativeCopy.unsafeSourceRefused = true;
    nativeCopy.sourceLegacyModes = nativeCopy.inventory.legacy_directory_modes;
    assert.deepEqual(nativeCopy.sourceLegacyModes, {'data/caddy':0o1777, 'config/caddy':0o1777});
    const daemon = JSON.parse(engine(['info', '--format', '{{json .}}']));
    nativeCopy.daemon = {version:daemon.ServerVersion, storageDriver:daemon.Driver,
      driverStatus:daemon.DriverStatus, architecture:daemon.Architecture};
    nativeCopy.volumeDrivers = [ownedVolumes[0], ownedVolumes[1], copiedData, copiedConfig].map(
      name => JSON.parse(engine(['volume', 'inspect', name]))[0].Driver);
    nativeCopy.fixtureSha256 = createHash('sha256').update(fs.readFileSync(copyScript)).digest('hex');
    nativeCopy.copyHelperSha256 = createHash('sha256').update(fs.readFileSync(path.join(root, 'scripts/hosted-deploy/caddy_volume_copy.mjs'))).digest('hex');
    assert.equal(nativeCopy.sourceUnchanged, true);
    assert.equal(nativeCopy.copiedVerified, true);
    assert.equal(nativeCopy.nonemptyReuseRefused, true);
    assert.equal(nativeCopy.helperImageId, inspect(fixtureImage).Id);
    assert.ok(nativeCopy.inventory.certificate_sha256.includes(caSha));
    const copiedProxy = container(['--name', `${prefix}-copied-proxy`, '--network', network,
      '--network-alias', 'proxy', '--mount', `type=volume,source=${diagnosticVolume},target=/qualification,readonly`,
      '--mount', `type=volume,source=${copiedData},target=/data,volume-nocopy`,
      '--mount', `type=volume,source=${copiedConfig},target=/config,volume-nocopy`,
      '--volume', `${ownedVolumes[2]}:/etc/caddy:ro`, '--read-only', '--cap-drop', 'ALL',
      '--cap-add', 'NET_BIND_SERVICE', '--security-opt', 'no-new-privileges',
      '--sysctl', 'net.ipv4.ip_unprivileged_port_start=1024',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=32m', image]);
    engine(['start', copiedProxy]);
    assert.equal((await waitForReady(request, {h2:true, path:'/after-copy'})).status, 200);
    engine(['cp', `${copiedProxy}:/data/caddy/pki/authorities/local/root.crt`, caFile]);
    assert.equal(createHash('sha256').update(fs.readFileSync(caFile)).digest('hex'), caSha);
    const copiedProfile = JSON.parse(engine(['exec', copiedProxy, '/qualification/inspect-runtime']));
    for (const directory of ['/data','/data/caddy','/config','/config/caddy']) {
      assert.equal(copiedProfile.paths[directory].UID, 1001);
      assert.equal(copiedProfile.paths[directory].GID, 1001);
      assert.equal(copiedProfile.paths[directory].Mode & 0o7777, directory.endsWith('/caddy') ? 0o750 : 0o755);
    }
    observations.push('owned rootful fixture copy preserves PKI and UID 1001 access; nonempty reuse refused');
  }
  console.log(JSON.stringify({ imageId:imageInfo.Id, architecture:imageInfo.Architecture,
    nativeDaemonArchitecture:native, rendererSha256:rendererSha, harnessSha256:harnessSha, guardSha256:guardSha, clientSha256:clientSha, upstreamSha256:upstreamSha, upstreamSourceSha256:upstreamSourceSha, configSources, observations,
    quietStreams:quietStreams.map(({body,...metrics})=>metrics), streamOutcomes, processProfile, negativeWithoutCapability, legacyVolumeRefusal, normalStop, nativeCopy, servingCapabilities,
    productionActions:false }, null, 2));
} catch (error) {
  primaryError = error;
  let containerDiagnostics;
  try {
    const ids = [upstreamDiagnosticId, proxyDiagnosticId].filter(Boolean);
    containerDiagnostics = collectOwnedDiagnostics(ids, ownedContainers, args => spawnSync(
      engineExecutable, [...engineArgs, ...args], { encoding:'utf8', timeout:3000, maxBuffer:65536 }));
  } catch { containerDiagnostics = { error:'unavailable' }; }
  console.error(JSON.stringify({ containerDiagnostics, qualificationFailure:true, rendererSha256:rendererSha, harnessSha256:harnessSha, guardSha256:guardSha, clientSha256:clientSha, upstreamSha256:upstreamSha, upstreamSourceSha256:upstreamSourceSha, configSources, observations, streamOutcomes, processProfile, negativeWithoutCapability, legacyVolumeRefusal, normalStop, servingCapabilities }));
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
