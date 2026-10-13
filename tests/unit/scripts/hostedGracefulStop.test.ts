import { describe, it, expect } from '@jest/globals';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../../../scripts/hosted-graceful-stop.py', import.meta.url));
const target = 'a'.repeat(64);

const helperPhases = new Set(['launcher-enter', 'stdlib-ready', 'patch-import-ready', 'helper-enter',
  'command-start', 'command-end', 'command-timeout', 'command-os-error', 'command-error']);
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

function boundedCommandCategories(contents: string): string[] {
  const categories: string[] = [];
  for (const line of contents.slice(0, 4096).split('\n')) {
    try {
      const args = JSON.parse(line);
      if (!Array.isArray(args)) continue;
      if (args[0] === 'inspect') categories.push('inspect');
      else if (args[0] === 'kill') categories.push('term');
    } catch { /* Partial trace remains unavailable. */ }
    if (categories.length >= 16) break;
  }
  return categories;
}

async function run(mode: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'owned-graceful-stop-'));
  const trace = path.join(directory, 'trace.jsonl');
  const dockerFixture = path.join(directory, 'docker-fixture.py');
  await writeFile(dockerFixture, `import json,os,sys,time
from pathlib import Path
a=sys.argv[1:]; p=Path(os.environ['OWNED_TRACE']); mode=os.environ['OWNED_MODE']
with p.open('a') as f: f.write(json.dumps(a)+'\\n')
if a[0]=='inspect' and 'org.dollhousemcp.memory-upgrade-drain' in a[2]:
 print('v1' if mode!='unsupported' else '<no value>'); sys.exit(0)
if a[0]=='inspect':
 if mode=='hung': time.sleep(30)
 stopped=Path(str(p)+'.stopped').exists() or mode=='unclean'
 print(('b'*64 if mode=='changed' else '${target}')+'|'+('false' if stopped else 'true')+'|'+('1' if mode=='unclean' else '0')+'|false'); sys.exit(0)
if a==['kill','--signal=TERM','${target}']:
 if mode=='success': Path(str(p)+'.stopped').touch()
 sys.exit(0)
sys.exit(3)
`);
  const python = process.platform === 'win32' ? 'python' : 'python3';
  // Invoke the fixture directly: Windows .cmd treats the state-format pipes
  // as shell pipelines and adds children that can outlive the CLI timeout.
  const launcher = path.join(directory, 'owned-helper-launch.py');
  await writeFile(launcher, `import json,sys,time
started=time.monotonic()
def emit(phase):
 print('OWNED_HELPER_PHASE '+json.dumps({'phase':phase,'elapsedMs':round((time.monotonic()-started)*1000,3)}),file=sys.stderr,flush=True)
emit('launcher-enter')
import runpy,subprocess
emit('stdlib-ready')
from unittest.mock import patch
emit('patch-import-ready')
helper,fixture,target=sys.argv[1:]
original_run=subprocess.run
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
with patch('shutil.which',side_effect=resolve_docker), patch('subprocess.run',side_effect=execute_fixture):
 emit('helper-enter')
 runpy.run_path(helper,run_name='__main__')
`);
  let observationReport: Promise<void> | undefined;
  try {
    const started = Date.now();
    const child = spawn(python, [launcher, helper, dockerFixture, target], {
      env: { ...process.env, HOME: directory, OWNED_TRACE: trace, OWNED_MODE: mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = ''; let discardedBytes = 0;
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
        capturedStderrBytes: stderr.length, discardedBytes }));
    };
    // Observation only, before unchanged10s Jest ceiling; no deadline or child behavior changes.
    const observation = setTimeout(() => { observationReport = report('still-running', null); }, 9000);
    let result: number | null;
    try {
      result = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject); child.once('close', code => resolve(code));
      });
    } catch (error) { await report('spawn-error', null); throw error; }
    finally { clearTimeout(observation); }
    try {
      const commands = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
      expect(commands.every(args => ['inspect', 'kill'].includes(args[0]))).toBe(true);
      expect(commands.filter(args => args[0] === 'kill').every(args => args.join('|') === `kill|--signal=TERM|${target}`)).toBe(true);
      const elapsed = Date.now() - started;
      return { result, commands, elapsed };
    } finally { await report('child-close', result); }
  } finally {
    await observationReport;
    await rm(directory, { recursive: true, force: true });
  }
}

describe('non-force hosted graceful stop', () => {
  it('permits replacement only after known clean closure', async () => {
    const outcome = await run('success'); expect(outcome.result).toBe(0);
    expect(outcome.commands.filter(args => args[0] === 'kill')).toHaveLength(1);
  });
  it('a refused old process reaches the deadline without stop/remove/start or escalation', async () => {
    const outcome = await run('held'); expect(outcome.result).toBe(1); expect(outcome.elapsed).toBeLessThan(2500);
    expect(outcome.commands.filter(args => args[0] === 'kill')).toHaveLength(1);
  });
  it('bounds a hung Docker state query and never signals the old process', async () => {
    const outcome = await run('hung'); expect(outcome.result).toBe(1); expect(outcome.elapsed).toBeLessThan(2500);
    expect(outcome.commands.some(args => args[0] === 'kill')).toBe(false);
  });
  it.each(['unsupported', 'changed', 'unclean'])('refuses %s state before replacement', async mode => {
    const outcome = await run(mode); expect(outcome.result).toBe(1);
    expect(outcome.commands.some(args => args[0] === 'kill')).toBe(false);
  });
});
