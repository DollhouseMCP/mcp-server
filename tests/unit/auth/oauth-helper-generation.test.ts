import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../../oauth-helper.mjs', import.meta.url), 'utf8');
const names = ['generationTransaction', 'transactionSucceeded', 'cleanupOwnedGenerationSync',
  'cleanupUnclaimedStateSync', 'writePidFile', 'claimPreparedStateSync',
  'buildTerminalResult', 'commitTerminalResultSync', 'stateFileBelongsToThisHelperSync', 'installTerminationHandlers'];
function declaration(name: string): string {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n(?:async )?function /);
  if (start < 0 || end < 0) throw new Error(`Missing bounded source declaration: ${name}`);
  return rest.slice(0, end + 1);
}

function fixture() {
  const files = new Map<string, string>([['state', JSON.stringify({ flowId: 'A', pid: 123 })], ['pid', '123']]);
  const events: string[] = [];
  let count = 0, held = false;
  const handlers = new Map<string, () => unknown>(); const exits: number[] = [];
  const controls: {
    beforeLock?: () => void; operationError?: { error: unknown }; releaseError?: { error: unknown };
    acquireError?: { error: unknown }; unlinkError?: string; writeError?: { error: unknown };
    handoff: boolean;
  } = { handoff: false };
  const fsSync = {
    mkdirSync() {},
    readFileSync(key: string) {
      events.push(`read:${key}`);
      if (controls.operationError) throw controls.operationError.error;
      if (!files.has(key)) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
      return files.get(key)!;
    },
    unlinkSync(key: string) {
      events.push(`unlink:${key}`);
      if (controls.unlinkError === key) throw new Error(`unlink-${key}`);
      files.delete(key);
    },
  };
  // Only source declarations are evaluated; no helper startup, processes or I/O.
  const api = runInNewContext(`let terminalCleanupAttempted=false, terminalCleanupResult;
    let terminalOutcome=null, terminalWriteAttempted=false, terminalResultWritten=false; ${names.map(declaration).join('\n')}
    ({generationTransaction, cleanupOwnedGenerationSync, cleanupUnclaimedStateSync,
      writePidFile, claimPreparedStateSync, commitTerminalResultSync, installTerminationHandlers, success(){terminalOutcome={status:'success'};}})`, {
    ALLOWED_RESULT_ERROR_CODES: new Set(['success', 'fatal_error']), RESULT_MESSAGES: { fatal_error: 'failed' },
    attempts: 1, RESULT_FILE: 'result', FLOW_ID: 'A', STATE_FILE: 'state', PID_FILE: 'pid', AUTH_DIR: 'auth', process: { pid: 123, once: (name: string, fn: () => unknown) => handlers.set(name, fn), exit: (code: number) => exits.push(code) },
    fsSync, fs: { mkdir: async () => { events.push('mkdir'); } }, log: async () => {},
    hasCommittedHandoffSync: () => controls.handoff,
    writeFileAtomicallySync(key: string, value: string) {
      events.push(`atomic:${key}`);
      if (controls.writeError) throw controls.writeError.error;
      files.set(key, value);
    },
    withOAuthStateLockSync(_key: string, callback: () => unknown) {
      count++; if (held) throw new Error('nested lock');
      controls.beforeLock?.();
      if (controls.acquireError) throw controls.acquireError.error;
      held = true;
      let value;
      try { value = callback(); } finally { held = false; }
      if (controls.releaseError) throw controls.releaseError.error;
      return value;
    },
  });
  return { api, files, events, controls, handlers, exits, count: () => count };
}

describe('actual OAuth helper generation publication and cleanup', () => {
  it.each(['none', 'write', 'rename'])('uses unchanged atomic writer with %s failure', failure => {
    const coordinator = readFileSync(new URL('../../../oauth-state-coordinator.mjs', import.meta.url), 'utf8');
    const calls: string[] = []; const files = new Map([['pid', 'old']]);
    const error = new Error(failure);
    const atomic = runInNewContext(coordinator.slice(coordinator.indexOf('export function writeFileAtomicallySync')).replace('export ', '') + ';writeFileAtomicallySync', {
      process: { pid: 123 }, randomUUID: () => 'fixed',
      fs: {
        writeFileSync(key: string, value: string, options: { mode: number }) {
          calls.push('write'); expect(options.mode).toBe(0o600);
          if (failure === 'write') throw error; files.set(key, value); expect(files.get('pid')).toBe('old');
        },
        renameSync(from: string, to: string) {
          calls.push('rename'); if (failure === 'rename') throw error;
          files.set(to, files.get(from)!); files.delete(from);
        },
        unlinkSync(key: string) { calls.push('unlink-temp'); files.delete(key); },
      },
    });
    if (failure === 'none') atomic('pid', '123'); else expect(() => atomic('pid', '123')).toThrow(error);
    expect(files.get('pid')).toBe(failure === 'none' ? '123' : 'old');
    expect(calls).toEqual(failure === 'write' ? ['write', 'unlink-temp'] : ['write', 'rename', 'unlink-temp']);
    expect(files.size).toBe(1);
  });
  it.each(['999999', '12', ''])('current state authorizes whole PID replacement (%p)', async oldPid => {
    const f = fixture(); f.files.set('pid', oldPid);
    expect((await f.api.writePidFile()).published).toBe(true);
    expect(f.files.get('pid')).toBe('123');
    expect(f.events).toEqual(['mkdir', 'read:state', 'atomic:pid']);
  });
  it('refuses delayed old publication after newer state, even before newer PID', async () => {
    const f = fixture(); const state = JSON.stringify({ flowId: 'B', pid: 456 });
    f.controls.beforeLock = () => { f.files.set('state', state); f.files.set('pid', '123'); };
    expect((await f.api.writePidFile()).published).toBe(false);
    expect(f.files.get('state')).toBe(state); expect(f.files.get('pid')).toBe('123');
    expect(f.events).not.toContain('atomic:pid');
  });
  it.each([null, {}, { flowId: 'B', pid: 123 }, { flowId: 'A' }, { flowId: 'A', pid: '123' }])(
    'refuses unknown or nonowned publication state %p', async state => {
      const f = fixture(); f.files.set('state', JSON.stringify(state));
      expect((await f.api.writePidFile()).published).toBe(false); expect(f.files.get('pid')).toBe('123');
    });
  it('snapshots both owners and removes PID before failed state, only once', () => {
    const f = fixture(); expect(f.api.cleanupOwnedGenerationSync().operation.value).toBe(true);
    expect(f.events).toEqual(['read:state', 'read:pid', 'unlink:pid', 'unlink:state']);
    expect(f.api.cleanupOwnedGenerationSync().operation.value).toBe(true); expect(f.count()).toBe(1);
  });
  it.each(['999999', '123\n', ''])('never removes mismatching PID during cleanup %p', pid => {
    const f = fixture(); f.files.set('pid', pid); f.api.cleanupOwnedGenerationSync();
    expect(f.files.size).toBe(2); expect(f.events.some(e => e.startsWith('unlink:'))).toBe(false);
  });
  it('refuses same numeric PID in newer flow and serializes replacement after cleanup', () => {
    const f = fixture(); f.controls.beforeLock = () => f.files.set('state', JSON.stringify({ flowId: 'B', pid: 123 }));
    f.api.cleanupOwnedGenerationSync(); expect(f.files.size).toBe(2);
    const g = fixture(); g.api.cleanupOwnedGenerationSync();
    g.files.set('state', 'new-state'); g.files.set('pid', '456');
    g.api.cleanupOwnedGenerationSync(); expect(g.files.get('pid')).toBe('456'); expect(g.files.get('state')).toBe('new-state');
  });
  it.each(['pid', 'state'])('retains truthful partial cleanup when %s unlink fails', key => {
    const f = fixture(); f.controls.unlinkError = key;
    expect(f.api.cleanupOwnedGenerationSync().operation.returned).toBe(false);
    expect(f.files.has('state')).toBe(true); expect(f.files.has('pid')).toBe(key === 'pid');
    f.controls.unlinkError = undefined; f.api.cleanupOwnedGenerationSync(); expect(f.count()).toBe(1);
  });
  it.each([false, undefined, null, 0, ''])('preserves primary falsy error and separate release failure %p', error => {
    const f = fixture(); const release = new Error('release');
    f.controls.operationError = { error }; f.controls.releaseError = { error: release };
    const outcome = f.api.cleanupOwnedGenerationSync();
    expect(outcome.operation.error).toBe(error); expect(outcome.lockFailure.error).toBe(release);
    f.api.cleanupOwnedGenerationSync(); expect(f.count()).toBe(1); expect(f.files.size).toBe(2);
  });
  it('does not retry admission failure or accept committed publication after release failure', async () => {
    const f = fixture(); f.controls.acquireError = { error: false };
    expect(f.api.cleanupOwnedGenerationSync().lockFailure.error).toBe(false);
    f.controls.acquireError = undefined; f.api.cleanupOwnedGenerationSync(); expect(f.count()).toBe(1);
    const g = fixture(); const failure = new Error('release'); g.controls.releaseError = { error: failure };
    const result = await g.api.writePidFile(); expect(result.published).toBe(false);
    expect(result.outcome.operation.value).toBe(true); expect(result.outcome.lockFailure.error).toBe(failure);
    expect(g.files.get('pid')).toBe('123');
  });
  it.each(['success', 'handoff'])('preserves committed %s state while removing own PID', mode => {
    const f = fixture(); if (mode === 'success') f.api.success(); else f.controls.handoff = true;
    f.api.cleanupOwnedGenerationSync(); expect(f.files.has('state')).toBe(true); expect(f.files.has('pid')).toBe(false);
  });
  it.each(['success', 'failed'])('uses exactly four nonnested admissions for normal %s', async status => {
    const f = fixture(); expect(f.api.claimPreparedStateSync()).toBe(true);
    expect((await f.api.writePidFile()).published).toBe(true);
    f.api.commitTerminalResultSync(status, 1, status === 'success' ? 'success' : 'fatal_error', status === 'success' ? 0 : 1);
    f.api.cleanupOwnedGenerationSync(); f.api.cleanupOwnedGenerationSync();
    expect(f.count()).toBe(4); expect(JSON.parse(f.files.get('result')!).status).toBe(status);
    expect(f.files.has('state')).toBe(status === 'success'); expect(f.files.has('pid')).toBe(false);
  });
  it.each([false, undefined, null, 0, ''])('refuses atomic publication errors preserving payload %p', async error => {
    const f = fixture(); f.files.set('pid', '999999'); f.controls.writeError = { error };
    const result = await f.api.writePidFile(); expect(result.published).toBe(false);
    expect(result.outcome.operation.error).toBe(error); expect(f.files.get('pid')).toBe('999999');
  });
  it('shares a single cleanup attempt across actual signal, beforeExit and exit handlers', async () => {
    const f = fixture(); f.api.installTerminationHandlers();
    f.handlers.get('SIGTERM')!(); await f.handlers.get('beforeExit')!(); f.handlers.get('exit')!();
    expect(f.exits).toEqual([1]); expect(f.count()).toBe(2);
    expect(f.events.filter(e => e === 'unlink:pid')).toHaveLength(1);
    expect(f.events.filter(e => e === 'unlink:state')).toHaveLength(1);
  });
  it('cleans an absent-PID failed state but not malformed claim preparation or another PID', () => {
    const f = fixture(); f.files.delete('pid'); f.api.cleanupOwnedGenerationSync(); expect(f.files.size).toBe(0);
    const g = fixture(); g.files.set('state', JSON.stringify({ flowId: 'A' }));
    g.files.set('pid', '999999'); g.api.cleanupUnclaimedStateSync();
    expect(g.files.has('state')).toBe(false); expect(g.files.get('pid')).toBe('999999');
    g.api.cleanupOwnedGenerationSync(); expect(g.count()).toBe(1);
    const h = fixture(); h.files.set('state', JSON.stringify({ flowId: 'A', pid: 'unknown' }));
    h.api.cleanupUnclaimedStateSync(); expect(h.files.size).toBe(2);
  });
});
