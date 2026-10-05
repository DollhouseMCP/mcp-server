import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { Dir } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SecurityMonitor } from '../../../src/security/securityMonitor.js';
import { logger } from '../../../src/utils/logger.js';
import {
  admitEvidenceAncestor, applyEvidenceAncestorTransition, applyEvidenceDirectoryTransition,
  captureEvidenceConfinement, inspectEvidenceNames, observeEvidenceCanonicalVolume,
  observeEvidenceDirectory, readEvidenceFile, withEvidenceFileClose, writeEvidenceFile,
  type EvidenceClose, type ExclusiveEvidenceWrite, type HeadDirectory, type HeadFileEvidence,
} from '../../../src/storage/FileMemoryOwnedHeadEvidence.js';

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-audit-private-'));
  roots.push(root);
  return root;
}
const events = () => SecurityMonitor.getRecentEvents().filter(event => event.source === 'FileMemoryOwnedHeadEvidence');
const stages = () => events().map(event => event.details.match(/stage=([^;]+)/u)?.[1]);
const refusal = Object.assign(new Error('private-error-sentinel'), { code: 'EHEADCONFLICT' });
const fail = (): never => { throw refusal; };
const closed: EvidenceClose = (handle, body) => withEvidenceFileClose(handle, body,
  (primary, secondary) => new AggregateError([primary, secondary], 'paired failure', { cause: primary }));

afterEach(async () => {
  jest.restoreAllMocks();
  SecurityMonitor.clearAllEventsForTesting();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('owned-head evidence failure audit boundaries', () => {
  it('preserves two actual canonical-volume refusals in one real deduplication window without leaking data', async () => {
    const root = await fixture(), target = path.join(root, 'private-locator-sentinel');
    await fs.writeFile(target, 'private-content-sentinel');
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(observeEvidenceCanonicalVolume(target, fail)).rejects.toBe(refusal);
    }
    expect(stages()).toEqual(['canonical-volume', 'canonical-volume']);
    expect(new Set(events().map(event => event.details)).size).toBe(2);
    const serialized = JSON.stringify(events());
    for (const secret of [root, target, 'private-locator-sentinel', 'private-content-sentinel', refusal.message, refusal.code]) {
      expect(serialized).not.toContain(secret);
    }
    for (const event of events()) {
      expect(event.type).toBe('OPERATION_FAILED');
      expect(event.details).toContain('storage-outcome=unclassified');
    }
  });

  it('emits no failure event for a successful observation or optional missing volume', async () => {
    const root = await fixture();
    expect((await observeEvidenceCanonicalVolume(root, fail))?.isDirectory()).toBe(true);
    expect(await observeEvidenceCanonicalVolume(path.join(root, 'absent'), fail)).toBeUndefined();
    expect(events()).toEqual([]);
  });

  it('preserves a native failed file-open error without adding path or error metadata to its event', async () => {
    const root = await fixture(), target = path.join(root, 'absent-private-file');
    await expect(readEvidenceFile(target, 20, '1', false, () => {}, closed, fail))
      .rejects.toMatchObject({ code: 'ENOENT', path: target });
    expect(stages()).toEqual(['file-read']);
    expect(JSON.stringify(events())).not.toContain(root);
    expect(events()[0].additionalData).toBeUndefined();
  });

  it('treats only explicitly optional initial-open absence as a quiet normal probe', async () => {
    const root = await fixture(), target = path.join(root, 'absent-private-file');
    const active = jest.fn(), closeSeen = jest.fn();
    const close: EvidenceClose = (handle, body) => { closeSeen(); return closed(handle, body); };
    await expect(readEvidenceFile(target, 20, '1', false, active, close, fail,
      { optionalInitialAbsence: true })).resolves.toBeUndefined();
    expect(active).not.toHaveBeenCalled();
    expect(closeSeen).not.toHaveBeenCalled();
    expect(events()).toEqual([]);
    await expect(readEvidenceFile(target, 20, '1', false, active, close, fail))
      .rejects.toMatchObject({ code: 'ENOENT', path: target });
    expect(stages()).toEqual(['file-read']);
  });

  it.each([null, undefined])('audits a failed census after closing its actual directory, preserving primitive %s', async primary => {
    const root = await fixture();
    let directory: Dir | undefined;
    await expect(inspectEvidenceNames(root, () => {}, async opened => {
      directory = opened;
      throw primary;
    }, 'directory failure')).rejects.toBe(primary);
    await expect(directory!.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' });
    expect(stages()).toEqual(['directory-census']);
  });

  it.each([null, undefined])('retains paired body and actual descriptor-close failures with primitive %s', async primary => {
    const root = await fixture(), handle = await fs.open(path.join(root, 'private-file'), 'wx');
    const realClose = handle.close.bind(handle), secondary = new Error('private-close-sentinel');
    jest.spyOn(handle, 'close').mockImplementation(async () => { await realClose(); throw secondary; });
    const composed = new AggregateError([primary, secondary], 'paired', { cause: primary });
    const compose = jest.fn<(primary: unknown, secondary: unknown) => Error>(() => composed);
    const caught = await withEvidenceFileClose(handle, async () => { throw primary; }, compose).catch(cause => cause);
    expect(caught).toBe(composed);
    expect(caught.cause).toBe(primary);
    expect(caught.errors).toEqual([primary, secondary]);
    expect(compose).toHaveBeenCalledWith(primary, secondary);
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
    expect(stages()).toEqual(['file-close']);
    expect(JSON.stringify(events())).not.toContain(secondary.message);
  });

  it('contains both throwing audit and warning observers without inspecting the original hostile cause', async () => {
    const root = await fixture(), handle = await fs.open(path.join(root, 'private-file'), 'wx');
    const hostile = Object.defineProperty({}, 'code', { get: () => { throw new Error('must not inspect'); } });
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => { throw new Error('audit unavailable'); });
    const warning = jest.spyOn(logger, 'warn').mockImplementation(() => { throw new Error('warning unavailable'); });
    await expect(withEvidenceFileClose(handle, async () => { throw hostile; }, fail)).rejects.toBe(hostile);
    await expect(handle.stat()).rejects.toMatchObject({ code: 'EBADF' });
    expect(audit).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('reports an oversized exclusive write before opening a file without implying a storage outcome', async () => {
    const root = await fixture(), target = path.join(root, 'private-stage');
    const proof = jest.fn<() => Promise<void>>(), markResidual = jest.fn();
    const context = { proof, markResidual, fail } as unknown as ExclusiveEvidenceWrite;
    await expect(writeEvidenceFile(target, 'private-oversized-content', 1, context)).rejects.toBe(refusal);
    expect(proof).not.toHaveBeenCalled();
    expect(markResidual).not.toHaveBeenCalled();
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(stages()).toEqual(['file-write']);
    expect(events()[0].details).toContain('storage-outcome=unclassified');
  });

  const posixIt = process.platform === 'win32' || !process.getuid ? it.skip : it;

  posixIt('audits optional initial-open symlink refusal instead of treating it as absence', async () => {
    const root = await fixture(), target = path.join(root, 'symlink');
    await fs.writeFile(path.join(root, 'actual'), 'private-content');
    await fs.symlink(path.join(root, 'actual'), target);
    await expect(readEvidenceFile(target, 20, '1', false, () => {}, closed, fail,
      { optionalInitialAbsence: true })).rejects.toMatchObject({ code: 'ELOOP' });
    expect(stages()).toEqual(['file-read']);
  });

  posixIt.each([false, true])('retains optional post-open named ENOENT with close failure=%s', async closeFailed => {
    const root = await fixture(), target = path.join(root, 'private-file');
    await fs.writeFile(target, 'private-content', { mode: 0o600 });
    let opened: fs.FileHandle | undefined;
    const secondary = Object.assign(new Error('private-close-sentinel'), { code: 'ENOENT' });
    const observeClose: EvidenceClose = async (handle, body) => {
      opened = handle;
      const realStat = handle.stat.bind(handle);
      jest.spyOn(handle, 'stat').mockImplementationOnce(() => realStat({ bigint: true }))
        .mockImplementationOnce(async () => {
          const stat = await realStat({ bigint: true });
          await fs.unlink(target);
          return stat;
        });
      if (closeFailed) {
        const realClose = handle.close.bind(handle);
        jest.spyOn(handle, 'close').mockImplementation(async () => { await realClose(); throw secondary; });
      }
      return closed(handle, body);
    };
    const caught = await readEvidenceFile(target, 20, '1', true, () => {}, observeClose, fail,
      { optionalInitialAbsence: true }).catch(cause => cause);
    if (closeFailed) {
      expect(caught).toBeInstanceOf(AggregateError);
      expect(caught.cause).toMatchObject({ code: 'ENOENT', path: target });
      expect(caught.errors).toEqual([caught.cause, secondary]);
    } else expect(caught).toMatchObject({ code: 'ENOENT', path: target });
    await expect(opened!.stat()).rejects.toMatchObject({ code: 'EBADF' });
    expect(stages()).toEqual(['file-read']);
    expect(JSON.stringify(events())).not.toContain(root);
  });

  posixIt('retains optional read close ENOENT after a successful body', async () => {
    const root = await fixture(), target = path.join(root, 'private-file');
    await fs.writeFile(target, 'private-content', { mode: 0o600 });
    const secondary = Object.assign(new Error('private-close-sentinel'), { code: 'ENOENT' });
    let opened: fs.FileHandle | undefined;
    const observeClose: EvidenceClose = async (handle, body) => {
      opened = handle;
      const realClose = handle.close.bind(handle);
      jest.spyOn(handle, 'close').mockImplementation(async () => { await realClose(); throw secondary; });
      return closed(handle, body);
    };
    await expect(readEvidenceFile(target, 20, '1', true, () => {}, observeClose, fail,
      { optionalInitialAbsence: true })).rejects.toBe(secondary);
    await expect(opened!.stat()).rejects.toMatchObject({ code: 'EBADF' });
    expect(stages()).toEqual(['file-read']);
  });

  posixIt('keeps optional decode and active-context failures audited after opening', async () => {
    const root = await fixture(), target = path.join(root, 'private-file');
    await fs.writeFile(target, Buffer.from([255]), { mode: 0o600 });
    await expect(readEvidenceFile(target, 20, '1', true, () => {}, closed, fail,
      { optionalInitialAbsence: true })).rejects.toMatchObject({ code: 'ERR_ENCODING_INVALID_ENCODED_DATA' });
    await fs.writeFile(target, 'private-content');
    const primary = Object.assign(new Error('private-authority-sentinel'), { code: 'ENOENT' });
    await expect(readEvidenceFile(target, 20, '1', true, () => { throw primary; }, closed, fail,
      { optionalInitialAbsence: true })).rejects.toBe(primary);
    expect(stages()).toEqual(['file-read', 'file-read']);
  });

  posixIt('records one outer read refusal after nested close and before a throwing real audit listener', async () => {
    const root = await fixture(), target = path.join(root, 'private-file');
    await fs.writeFile(target, 'private-content', { mode: 0o600 });
    let opened: fs.FileHandle | undefined, closeCompleted = false, listenerSawClosed: boolean | undefined;
    const observeClose: EvidenceClose = async (handle, body) => {
      opened = handle;
      try { return await closed(handle, body); } finally { closeCompleted = true; }
    };
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const detach = SecurityMonitor.addLogListener(event => {
      if (event.source === 'FileMemoryOwnedHeadEvidence') {
        listenerSawClosed = closeCompleted;
        throw new Error('private-listener-failure');
      }
    });
    try {
      await expect(readEvidenceFile(target, 1, '1', true, () => {}, observeClose, fail)).rejects.toBe(refusal);
      await expect(opened!.stat()).rejects.toMatchObject({ code: 'EBADF' });
      expect(listenerSawClosed).toBe(true);
      expect(stages()).toEqual(['file-read']);
      expect(JSON.stringify(events())).not.toContain('private-listener-failure');
    } finally { detach(); }
  });

  posixIt('retains actual partial-write evidence and original failure while emitting one outer observation', async () => {
    const root = await fixture(), target = path.join(root, 'private-stage');
    const raw = 'private-content-sentinel';
    const primary = new Error('private-partial-failure'), handles: fs.FileHandle[] = [];
    const markResidual = jest.fn(), track = jest.fn<(target: string, evidence: HeadFileEvidence) => void>();
    const context: ExclusiveEvidenceWrite = {
      active: () => {}, proof: async () => {}, markResidual,
      closed: async (handle, body) => { handles.push(handle); return closed(handle, body); },
      read: (named, maximum) => readEvidenceFile(named, maximum, '1', true, () => {}, closed, fail),
      track, transition: async () => {}, partialBarrier: async () => { throw primary; },
      containingDevice: () => { throw new Error('must not complete'); }, fail,
    };
    await expect(writeEvidenceFile(target, raw, 100, context)).rejects.toBe(primary);
    expect(markResidual).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(target, 'utf8')).toBe(raw.slice(0, Math.floor(raw.length / 2)));
    await expect(handles[0].stat()).rejects.toMatchObject({ code: 'EBADF' });
    expect(stages()).toEqual(['file-write']);
    expect(events()[0].details).toContain('storage-outcome=unclassified');
    for (const secret of [root, raw, primary.message, track.mock.calls[0][1].digest]) expect(JSON.stringify(events())).not.toContain(secret);
  });

  posixIt('audits real unsafe confinement before granting capture authority', async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, '.memory-fences'), { mode: 0o700 });
    await fs.writeFile(path.join(root, '.memory-owners'), 'unsafe ancestor');
    const reset = jest.fn(), observe = jest.fn<() => Promise<HeadDirectory>>();
    await expect(captureEvidenceConfinement({
      sourceLocator: () => 'head.yaml', tenantRoot: () => root,
      absolute: locator => path.join(root, locator), canonicalVolume: async () => undefined,
      reset, admit: () => {}, observe, append: () => {}, validate: () => {}, fail,
    })).rejects.toBe(refusal);
    expect(reset).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
    expect(stages()).toEqual(['confinement']);
  });

  posixIt('audits failed directory transitions and admission without adopting rejected evidence', async () => {
    const root = await fixture();
    const before = await observeEvidenceDirectory('.', root, true,
      inspect => inspectEvidenceNames(root, inspect, directory => directory.read(), 'scan close'), () => {}, fail) as HeadDirectory;
    const directories = [before], after = { ...before, names: ['unadmitted'] };
    expect(() => applyEvidenceDirectoryTransition(directories, 0, before, after, { add: [], remove: [], changed: [] }, fail)).toThrow(refusal);
    expect(() => applyEvidenceAncestorTransition(directories, 0, before, after, 'unadmitted', fail)).toThrow(refusal);
    expect(() => admitEvidenceAncestor('unadmitted/child', directories, fail)).toThrow(refusal);
    expect(directories).toEqual([before]);
    expect(stages()).toEqual(['directory-transition', 'ancestor-transition', 'ancestor-admission']);
  });

  posixIt('reports one outer directory observation when a nested actual census fails', async () => {
    const root = await fixture(), primary = new Error('private-census-failure');
    await expect(observeEvidenceDirectory('.', root, true,
      inspect => inspectEvidenceNames(root, inspect, async () => { throw primary; }, 'scan close'), () => {}, fail))
      .rejects.toBe(primary);
    expect(stages()).toEqual(['directory-observation']);
  });
});
