import { describe, it, expect } from '@jest/globals';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('../../../scripts/hosted-graceful-stop.sh', import.meta.url));
const target = 'a'.repeat(64);

async function run(mode: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'owned-graceful-stop-'));
  const trace = path.join(directory, 'trace.jsonl');
  await writeFile(path.join(directory, 'docker'), `#!/usr/bin/env python3
import json,os,sys,time
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
`, { mode: 0o700 });
  try {
    const started = Date.now();
    const child = spawn('bash', [helper, target, '1'], {
      env: { PATH: `${directory}:${process.env.PATH}`, HOME: directory, OWNED_TRACE: trace, OWNED_MODE: mode },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.resume(); child.stderr!.resume();
    const result = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', code => resolve(code));
    });
    const commands = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    expect(commands.every(args => ['inspect', 'kill'].includes(args[0]))).toBe(true);
    expect(commands.filter(args => args[0] === 'kill').every(args => args.join('|') === `kill|--signal=TERM|${target}`)).toBe(true);
    return { result, commands, elapsed: Date.now() - started };
  } finally { await rm(directory, { recursive: true, force: true }); }
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
