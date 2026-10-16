import { afterAll, afterEach, beforeEach, describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { OwnedFixtureRegistry } from '../../helpers/ownedFixtureProcess.js';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../../../scripts/hosted-graceful-stop.py', import.meta.url));
const target = 'a'.repeat(64);
const jobSupport = readFileSync(new URL('../../helpers/owned_python_job.py', import.meta.url), 'utf8');
const ownedFixtures = new OwnedFixtureRegistry();
let teardownSnapshot: (() => void) | undefined;
beforeEach(() => { teardownSnapshot = undefined; ownedFixtures.assertSettled(); });
afterEach(async () => {
  try { await ownedFixtures.cancelUnfinished(); }
  catch (error) {
    try { teardownSnapshot?.(); } catch { /* Evidence cannot replace cleanup failure, including falsy errors. */ }
    throw error;
  } finally { teardownSnapshot = undefined; }
});
afterAll(async () => {
  await ownedFixtures.cancelUnfinished();
  console.log('OWNED_HELPER_SUITE_SETTLED', JSON.stringify({ allOwnedOperationsClosed: true }));
});

type FixtureBootstrap = { version: number[]; executableCategory: 'python' | 'python-exe' | 'other' };
function boundedFixtureBootstrap(stderr: string): FixtureBootstrap | undefined {
  for (const line of stderr.split('\n').slice(0, -1)) {
    const match = /^OWNED_FIXTURE_BOOTSTRAP v1 (\d{1,2}) (\d{1,2}) (\d{1,2}) (python|python-exe|other)$/.exec(line.replace(/\r$/, ''));
    if (match) return { version: match.slice(1, 4).map(Number), executableCategory: match[4] as FixtureBootstrap['executableCategory'] };
  }
  return undefined;
}
const fixtureMilestones = new Set(['job-setup-start', 'job-ready', 'body-enter', 'finish-enter', 'finish-return']);
function boundedFixtureMilestones(stderr: string): string[] {
  const result: string[] = [];
  for (const line of stderr.split('\n').slice(0, -1)) {
    const label = line.replace(/\r$/, '').replace(/^OWNED_FIXTURE_MILESTONE /, '');
    if (line.startsWith('OWNED_FIXTURE_MILESTONE ') && fixtureMilestones.has(label)) result.push(label);
    if (result.length >= 8) break;
  }
  return result;
}
const fixtureParentPhases = new Set(['spawn-requested', 'spawn', 'first-stderr', 'spawn-error', 'exit', 'close',
  'cleanup-terminate-owned-tree', 'windows-job-quiescent', 'owned-group-zombie-only']);

const helperPhases = new Set(['launcher-enter', 'stdlib-ready', 'adapter-ready', 'helper-enter',
  'command-start', 'command-end', 'command-timeout', 'command-os-error', 'command-error',
  'json-import-start', 'json-import-end', 'job-setup-start', 'job-ready',
  'secrets-import-start', 'secrets-import-end']);
type HelperPhase = { phase: string; elapsedMs: number };

function parseHelperPhase(line: string): HelperPhase | undefined {
  if (!line.startsWith('OWNED_HELPER_PHASE ')) return undefined;
  try {
    const value = JSON.parse(line.slice('OWNED_HELPER_PHASE '.length));
    if (helperPhases.has(value.phase) && Number.isFinite(value.elapsedMs) && value.elapsedMs >= 0) {
      return { phase: value.phase, elapsedMs: value.elapsedMs };
    }
  } catch { /* Arbitrary child text is never emitted. */ }
  return undefined;
}

function boundedHelperPhases(stderr: string): HelperPhase[] {
  const frames: HelperPhase[] = [];
  for (const line of stderr.split('\n')) {
    const frame = parseHelperPhase(line);
    if (frame) frames.push(frame);
    if (frames.length >= 32) break;
  }
  return frames;
}

function boundedPythonIdentity(stderr: string): { executable: string; version: number[] } | undefined {
  const line = stderr.split('\n').find(value => value.startsWith('OWNED_HELPER_IDENTITY '));
  if (!line) return undefined;
  try {
    const value = JSON.parse(line.slice('OWNED_HELPER_IDENTITY '.length));
    if (typeof value.executable === 'string' && /^python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(value.executable) &&
        Array.isArray(value.version) && value.version.length === 3 &&
        value.version.every((part: unknown) => Number.isSafeInteger(part) && Number(part) >= 0 && Number(part) < 100)) {
      return { executable: value.executable, version: value.version };
    }
  } catch { /* Only the fixed identity schema is emitted. */ }
  return undefined;
}

function boundedCommandCategories(contents: string): string[] {
  const categories: string[] = [];
  for (const line of contents.slice(0, 4096).split('\n')) {
    try {
      const args = JSON.parse(line);
      if (!Array.isArray(args)) continue;
      if (args[0] === 'inspect') categories.push('inspect');
      else if (args[0] === 'exec') categories.push('drain');
      else if (args[0] === 'kill') categories.push('term');
    } catch { /* Partial trace remains unavailable. */ }
    if (categories.length >= 16) break;
  }
  return categories;
}

async function run(mode: string) {
  return ownedFixtures.run(async owner => {
  let stderr = '', discardedBytes = 0;
  let terminalEventObserved = false;
  teardownSnapshot = () => console.log('OWNED_FIXTURE_BOOTSTRAP_DIAGNOSTIC', JSON.stringify({
    fixture: 'hosted', mode, phase: 'teardown-failed', requestedCommand: process.platform === 'win32' ? 'python' : 'python3', terminalEventObserved,
    bootstrap: boundedFixtureBootstrap(stderr), milestones: boundedFixtureMilestones(stderr), frames: boundedHelperPhases(stderr),
    capturedStderrCharacters: stderr.length, discardedCharacters: discardedBytes,
    parentEvents: owner.events.slice(0, 16).filter(event => fixtureParentPhases.has(event.phase) && Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0).map(({ phase, elapsedMs }) => ({ phase, elapsedMs })),
    windowsFailure: owner.windowsFailureDetail(),
  }));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'owned-graceful-stop-'));
  owner.ownDirectory(directory);
  const trace = path.join(directory, 'trace.jsonl');
  const dockerFixture = path.join(directory, 'docker-fixture.py');
  await writeFile(dockerFixture, `import json,os,sys,time
from pathlib import Path
a=sys.argv[1:]; p=Path(os.environ['OWNED_TRACE']); mode=os.environ['OWNED_MODE']
with p.open('a') as f: f.write(json.dumps(a)+'\\n')
if a[0]=='inspect':
 if mode=='hung': time.sleep(30)
 stopped=Path(str(p)+'.stopped').exists() or mode in ['unclean','stopped-clean']
 changed_boot=mode=='changed-boot' and Path(str(p)+'.acked').exists()
 enabled='enabled'
 if mode=='disabled': enabled=''
 if mode=='wrong-dir': enabled='invalid'
 if mode=='duplicate-env': enabled='enabledenabled'
 print(json.dumps({'id':'b'*64 if mode=='changed' else '${target}','running':not stopped,'exitCode':1 if mode=='unclean' else 0,'oomKilled':False,'startedAt':'second' if changed_boot else 'first','restartCount':1 if changed_boot else 0,'restarting':False,'readonly':mode=='readonly','mounts':[{'Destination':'/app'}] if mode=='mounted' else [],'enabled':enabled,'capability':'v1' if mode=='unsupported' else 'v2'})); sys.exit(0)
if a[0]=='exec':
 assert a[:8]==['exec','--user','1001:1001','--workdir','/app','${target}','node','/app/dist/lifecycle/requestMemoryDrain.js']
 assert a[8]=='${target}' and len(a[9])==64 and 0<int(a[10])<=1000
 if mode=='drain-timeout': time.sleep(30)
 if mode in ['held','lost-ack','unknown']: sys.exit(1)
 ack={'protocol':2,'phase':'drained','containerId':'${target}','nonce':a[9],'bootId':'b'*64,'generation':'c'*64,'sourceBootId':'d'*64 if mode=='successor' else 'b'*64,'mode':'drained-successor' if mode=='successor' else 'same-boot','admitted':0,'writes':0,'failedWrites':0,'retainedOwners':0}
 if mode=='stale-nonce': ack['nonce']='e'*64
 if mode=='wrong-container': ack['containerId']='f'*64
 if mode=='pending': ack['writes']=1
 if mode=='unknown-phase': ack['phase']='unknown'
 if mode=='wrong-boot': ack['sourceBootId']='e'*64
 if mode=='oversize': print('x'*1025); sys.exit(0)
 Path(str(p)+'.acked').touch(); print(json.dumps(ack)); sys.exit(0)
if a==['kill','--signal=TERM','${target}']:
 assert Path(str(p)+'.acked').exists()
 if mode in ['success','successor']: Path(str(p)+'.stopped').touch()
 sys.exit(0)
sys.exit(3)
`);
  const python = process.platform === 'win32' ? 'python' : 'python3';
  // Invoke the fixture directly: Windows .cmd treats the state-format pipes
  // as shell pipelines and adds children that can outlive the CLI timeout.
  const launcher = path.join(directory, 'owned-helper-launch.py');
  await writeFile(launcher, `import sys
try:
 _fixture_executable=sys.executable.replace(chr(92),'/').rsplit('/',1)[-1].lower()
 print('OWNED_FIXTURE_BOOTSTRAP v1 %d %d %d %s' % (sys.version_info[0],sys.version_info[1],sys.version_info[2],'python-exe' if _fixture_executable=='python.exe' else 'python' if _fixture_executable=='python' else 'other'),file=sys.stderr,flush=True)
except BaseException:
 pass
def _fixture_milestone(label):
 try:
  print('OWNED_FIXTURE_MILESTONE '+label,file=sys.stderr,flush=True)
 except BaseException:
  pass
import time
started=time.monotonic()
def emit(phase):
 print('OWNED_HELPER_PHASE {"phase":"%s","elapsedMs":%.3f}' % (phase,(time.monotonic()-started)*1000),file=sys.stderr,flush=True)
emit('launcher-enter')
emit('json-import-start')
import json
emit('json-import-end')
${jobSupport}
emit('job-setup-start')
finish_job=establish_fixture_job()
emit('job-ready')
print('OWNED_HELPER_IDENTITY '+json.dumps({'version':list(sys.version_info[:3]),'executable':sys.executable.replace(chr(92),'/').rsplit('/',1)[-1]}),file=sys.stderr,flush=True)
import runpy,subprocess,shutil
emit('stdlib-ready')
helper,fixture,target=sys.argv[1:]
original_run=subprocess.run
original_which=shutil.which
builtins=sys.modules['builtins']
original_import=builtins.__import__
def traced_import(name,*args,**kwargs):
 if name!='secrets': return original_import(name,*args,**kwargs)
 emit('secrets-import-start')
 try: return original_import(name,*args,**kwargs)
 finally: emit('secrets-import-end')
python=sys.executable
def resolve_docker(name):
 assert name=='docker'
 return python
def execute_fixture(args,**kwargs):
 assert args[0]==python
 emit('command-start')
 try: return original_run([python,fixture,*args[1:]],**kwargs)
 except subprocess.TimeoutExpired:
  emit('command-timeout'); raise
 except OSError:
  emit('command-os-error'); raise
 except BaseException:
  emit('command-error'); raise
 finally: emit('command-end')
sys.argv=[helper,target,'1']
try:
 shutil.which=resolve_docker
 subprocess.run=execute_fixture
 builtins.__import__=traced_import
 emit('adapter-ready')
 emit('helper-enter')
 runpy.run_path(helper,run_name='__main__')
finally:
 shutil.which=original_which
 subprocess.run=original_run
 builtins.__import__=original_import
 _fixture_milestone('finish-enter')
 finish_job()
 _fixture_milestone('finish-return')
`);
  let observationReport: Promise<void> | undefined;
  try {
    const started = Date.now();
    const child = owner.spawn(python, [launcher, helper, dockerFixture, target], {
      env: { ...process.env, HOME: directory, OWNED_TRACE: trace, OWNED_MODE: mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.resume();
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString(); const available = Math.max(0, 4096 - stderr.length);
      stderr += text.slice(0, available); discardedBytes += Math.max(0, text.length - available);
    });
    const report = async (phase: 'still-running' | 'child-close' | 'spawn-error', code: number | null) => {
      const frames = boundedHelperPhases(stderr);
      // The fixture writes only its fixed synthetic Docker argv. Emit categories,
      // never raw argv, environment, arbitrary stderr or paths.
      let categories: string[] = [];
      try { categories = boundedCommandCategories(await readFile(trace, 'utf8')); }
      catch { /* Trace may not exist while Python is starting. */ }
      console.log('OWNED_HELPER_DIAGNOSTIC', JSON.stringify({ mode, phase, code,
        elapsedMs: Date.now() - started, frames, commands: categories,
        capturedStderrBytes: stderr.length, discardedBytes, parentEvents: owner.events,
        windowsFailure: owner.windowsFailureDetail(),
        python: boundedPythonIdentity(stderr), bootstrap: boundedFixtureBootstrap(stderr), milestones: boundedFixtureMilestones(stderr),
        observationTimerLagMs: phase === 'still-running' ? Math.max(0, Date.now() - started - 9000) : undefined }));
    };
    // Observation only, before unchanged10s Jest ceiling; no deadline or child behavior changes.
    const observation = setTimeout(() => { observationReport = report('still-running', null); }, 9000);
    let result: number | null;
    try {
      result = await new Promise<number | null>((resolve, reject) => {
        child.once('error', error => { terminalEventObserved = true; reject(error); });
        child.once('close', code => { terminalEventObserved = true; resolve(code); });
      });
    } catch (error) { await report('spawn-error', null); throw error; }
    finally { clearTimeout(observation); }
    try {
      const commands = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
      expect(commands.every(args => ['inspect', 'exec', 'kill'].includes(args[0]))).toBe(true);
      expect(commands.filter(args => args[0] === 'kill').every(args => args.join('|') === `kill|--signal=TERM|${target}`)).toBe(true);
      const elapsed = Date.now() - started;
      return { result, commands, elapsed };
    } finally { await report('child-close', result); }
  } finally {
    await observationReport;
  }
  });
}

describe('non-force hosted graceful stop', () => {
  it('permits replacement only after known clean closure', async () => {
    const outcome = await run('success'); expect(outcome.result).toBe(0);
    expect(outcome.commands.filter(args => args[0] === 'kill')).toHaveLength(1);
    expect(outcome.commands.findIndex(args => args[0] === 'exec')).toBeLessThan(outcome.commands.findIndex(args => args[0] === 'kill'));
  });
  it('a refused old process reaches the deadline without stop/remove/start or escalation', async () => {
    const outcome = await run('held'); expect(outcome.result).toBe(1); expect(outcome.elapsed).toBeLessThan(2500);
    expect(outcome.commands.filter(args => args[0] === 'kill')).toHaveLength(0);
  });
  it('bounds a hung Docker state query and never signals the old process', async () => {
    const outcome = await run('hung'); expect(outcome.result).toBe(1); expect(outcome.elapsed).toBeLessThan(2500);
    expect(outcome.commands.some(args => args[0] === 'kill')).toBe(false);
  });
  it('retains a drained child that fails to close without any signal escalation', async () => {
    const outcome = await run('postack-held'); expect(outcome.result).toBe(1); expect(outcome.elapsed).toBeLessThan(2500);
    expect(outcome.commands.filter(args => args[0] === 'kill')).toHaveLength(1);
  });
  it('bounds a waiting drain client without committing Docker TERM', async () => {
    const outcome = await run('drain-timeout'); expect(outcome.result).toBe(1); expect(outcome.elapsed).toBeLessThan(2500);
    expect(outcome.commands.some(args => args[0] === 'exec')).toBe(true);
    expect(outcome.commands.some(args => args[0] === 'kill')).toBe(false);
  });
  it.each(['unsupported', 'changed', 'unclean'])('refuses %s state before replacement', async mode => {
    const outcome = await run(mode); expect(outcome.result).toBe(1);
    expect(outcome.commands.some(args => args[0] === 'kill')).toBe(false);
  });
  it.each(['stopped-clean', 'readonly', 'mounted', 'disabled', 'wrong-dir', 'duplicate-env', 'lost-ack', 'unknown', 'stale-nonce',
    'wrong-container', 'pending', 'unknown-phase', 'wrong-boot', 'oversize', 'changed-boot'])('refuses %s without changing Docker restart eligibility', async mode => {
    const outcome = await run(mode); expect(outcome.result).toBe(1);
    expect(outcome.commands.some(args => args[0] === 'kill')).toBe(false);
  });
  it('allows only a bound known-drained successor to commit the single final TERM', async () => {
    const outcome = await run('successor'); expect(outcome.result).toBe(0);
    expect(outcome.commands.filter(args => args[0] === 'kill')).toHaveLength(1);
  });
});
