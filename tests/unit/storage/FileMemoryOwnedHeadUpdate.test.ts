import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { MEMORY_CONSTANTS } from '../../../src/elements/memories/constants.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import {
  FileMemoryOwnerSnapshots,
  type OwnedFileMemoryToken,
  type UnownedFileMemoryToken,
  type UpdatePublication,
} from '../../../src/storage/FileMemoryOwnerSnapshots.js';

const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
const sourceExtension = import.meta.url.endsWith('.js') ? 'js' : 'ts';
const moduleRoot = new URL(`../../../src/storage/`, import.meta.url);
const updateChild = `
  import { FileMemoryOwnerSnapshots } from ${JSON.stringify(new URL(`FileMemoryOwnerSnapshots.${sourceExtension}`, moduleRoot).href)};
  import { FileMemoryTransactionCoordinator } from ${JSON.stringify(new URL(`FileMemoryTransactionCoordinator.${sourceExtension}`, moduleRoot).href)};
  import { FileMemoryFence } from ${JSON.stringify(new URL(`FileMemoryFence.${sourceExtension}`, moduleRoot).href)};
  const [tenantRoot, userId, tokenJson, stopPhase] = process.argv.slice(1);
  const coordinator = new FileMemoryTransactionCoordinator({
    tenantRoot, getCurrentUserId: () => userId, fence: new FileMemoryFence(),
  });
  const store = new FileMemoryOwnerSnapshots({ coordinator,
    afterUpdatePublication: phase => {
      if (phase === stopPhase) {
        process.stdout.write('STOPPED\\n');
        process.stdin.resume();
        return new Promise(() => {});
      }
    },
  });
  await store.updateOwnedHead(JSON.parse(tokenJson), 'name: Child update\\nentries: []\\n');
`;

async function fixture(afterUpdatePublication?: (phase: UpdatePublication) => void | Promise<void>) {
  const tenantRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-owned-update-'));
  roots.push(tenantRoot);
  const locator = 'Notes/ÜberNote.yaml';
  const headPath = path.join(tenantRoot, locator);
  await fs.mkdir(path.dirname(headPath), { recursive: true });
  await fs.writeFile(headPath, 'name: Original\nentries: []\n');
  const coordinator = new FileMemoryTransactionCoordinator({
    tenantRoot, getCurrentUserId: () => USER, fence: new FileMemoryFence(),
  });
  const store = new FileMemoryOwnerSnapshots({ coordinator, afterUpdatePublication });
  const before = await store.readHeadSnapshot(locator);
  const owned = await store.adoptUnowned(before.token as UnownedFileMemoryToken);
  const hash = createHash('sha256').update(path.basename(headPath)).digest('hex');
  return { tenantRoot, locator, headPath, hash, coordinator, store, owned };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('dormant owned file head conditional UPDATE', () => {
  if (process.platform === 'win32') {
    it('fails closed where POSIX owner and mode checks are unavailable', () => {
      const coordinator = new FileMemoryTransactionCoordinator({
        tenantRoot: 'C:\\', getCurrentUserId: () => USER, fence: new FileMemoryFence(),
      });
      expect(() => new FileMemoryOwnerSnapshots({ coordinator })).toThrow('requires POSIX');
    });
    return;
  }

  it('advances revision and actual post-rename identity, including for same-content saves', async () => {
    const { locator, store, owned, headPath, hash } = await fixture();
    const updated = await store.updateOwnedHead(owned, 'name: Updated\nentries: []\n');
    expect(updated.revision).toBe('2');
    expect(updated.ownerId).toBe(owned.ownerId);
    expect(updated.fileIdentity.inode).not.toBe(owned.fileIdentity.inode);
    expect((await store.readHeadSnapshot(locator)).token).toEqual(updated);
    const unchangedContent = await store.updateOwnedHead(updated, 'name: Updated\nentries: []\n');
    expect(unchangedContent.revision).toBe('3');
    expect((await store.readHeadSnapshot(locator)).token).toEqual(unchangedContent);
    expect(await fs.readFile(headPath, 'utf8')).toBe('name: Updated\nentries: []\n');
    await expect(fs.stat(path.join(path.dirname(headPath), `.${hash}.memory-write.json`)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects stale and cross-user tokens without creating an artifact', async () => {
    const { store, owned, headPath, hash } = await fixture();
    const next = await store.updateOwnedHead(owned, 'name: Next\nentries: []\n');
    await expect(store.updateOwnedHead(owned, 'name: Stale\nentries: []\n'))
      .rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    await expect(store.updateOwnedHead({ ...next, userId: 'other' }, 'name: Other\nentries: []\n'))
      .rejects.toMatchObject({ code: 'EHEADCONFLICT' });
    expect(await fs.readFile(headPath, 'utf8')).toBe('name: Next\nentries: []\n');
    expect((await fs.readdir(path.dirname(headPath))).filter(name =>
      name.startsWith(`.${hash}.memory-write.`))).toHaveLength(0);
  });

  it('serializes two old-token updates under the tenant fence', async () => {
    const { store, owned, locator } = await fixture();
    const outcomes = await Promise.allSettled([
      store.updateOwnedHead(owned, 'name: One\nentries: []\n'),
      store.updateOwnedHead(owned, 'name: Two\nentries: []\n'),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find(outcome => outcome.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected', reason: { code: 'EHEADCONFLICT' } });
    expect((await store.readHeadSnapshot(locator)).token).toMatchObject({ revision: '2' });
  });

  it('reports revision exhaustion as recovery-needed, without creating an artifact', async () => {
    const { tenantRoot, store, owned, locator, headPath, hash } = await fixture();
    const sidecar = path.join(path.dirname(headPath), `.${hash}.memory-owner.json`);
    const registry = path.join(tenantRoot, '.memory-owners', 'owners', `${owned.ownerId}.json`);
    for (const file of [sidecar, registry]) {
      const record = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      record.revision = '9223372036854775807';
      await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });
    }
    const current = (await store.readHeadSnapshot(locator)).token as OwnedFileMemoryToken;
    await expect(store.updateOwnedHead(current, 'name: New\nentries: []\n'))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    expect((await fs.readdir(path.dirname(headPath))).filter(name =>
      name.startsWith(`.${hash}.memory-write.`))).toHaveLength(0);
  });

  it('rejects a non-roundtrippable UTF-16 surrogate before creating an artifact', async () => {
    const { store, owned, headPath, hash } = await fixture();
    await expect(store.updateOwnedHead(owned, `name: Invalid \ud800\nentries: []\n`))
      .rejects.toMatchObject({ code: 'EINVALIDHEAD' });
    expect((await fs.readdir(path.dirname(headPath))).filter(name =>
      name.startsWith(`.${hash}.memory-write.`))).toHaveLength(0);
  });

  it('rejects oversized and invalid YAML before creating an artifact', async () => {
    const { store, owned, headPath, hash } = await fixture();
    for (const content of [`name: ${'x'.repeat(MEMORY_CONSTANTS.MAX_YAML_SIZE)}\n`, 'name: [broken']) {
      await expect(store.updateOwnedHead(owned, content))
        .rejects.toMatchObject({ code: 'EINVALIDHEAD' });
      expect((await fs.readdir(path.dirname(headPath))).filter(name =>
        name.startsWith(`.${hash}.memory-write.`))).toHaveLength(0);
    }
  });

  it.each([
    'name: Bad\ngatekeeper: invalid\nentries: []\n',
    'name: Bad\nexternalRestrictions:\n  denyPatterns:\n    - Bash:rm *\nentries: []\n',
    'name: Bad\nmetadata:\n  gatekeeper:\n    externalRestrictions:\n      denyPatterns:\n        - Bash:rm *\nentries: []\n',
  ])('rejects invalid or misplaced gatekeeper policy before creating an artifact', async content => {
    const { store, owned, headPath, hash } = await fixture();
    await expect(store.updateOwnedHead(owned, content))
      .rejects.toMatchObject({ code: 'EINVALIDHEAD' });
    expect((await fs.readdir(path.dirname(headPath))).filter(name =>
      name.startsWith(`.${hash}.memory-write.`))).toHaveLength(0);
    expect(await fs.readFile(headPath, 'utf8')).toBe('name: Original\nentries: []\n');
  });

  it('accepts an authored gatekeeper policy that normal memory saves accept', async () => {
    const { store, owned, locator } = await fixture();
    const content = 'name: Valid\nmetadata:\n  gatekeeper:\n    externalRestrictions:\n' +
      '      description: Block removal\n      denyPatterns:\n        - "Bash:rm *"\nentries: []\n';
    const updated = await store.updateOwnedHead(owned, content);
    expect(updated.revision).toBe('2');
    expect((await store.readHeadSnapshot(locator)).content).toBe(content);
  });

  it.each<UpdatePublication>([
    'prepared-temp', 'prepared-journal', 'renamed-head', 'published-journal',
    'updated-registry', 'updated-sidecar',
  ])('fails closed after %s interruption', async phase => {
    const { store, owned, locator } = await fixture(current => {
      if (current === phase) throw new Error('interrupted');
    });
    await expect(store.updateOwnedHead(owned, 'name: New\nentries: []\n'))
      .rejects.toMatchObject({
        code: phase === 'prepared-temp' || phase === 'prepared-journal'
          ? 'EOWNERRECOVERY' : 'EHEADCOMMITUNKNOWN',
        residual: true,
        cause: expect.objectContaining({ message: 'interrupted' }),
      });
    await expect(store.readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    await expect(store.updateOwnedHead(owned, 'name: Retry\nentries: []\n'))
      .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
  });

  it('reports a committed token if a post-unlink hook fails', async () => {
    const { store, owned, locator } = await fixture(phase => {
      if (phase === 'unlinked-journal') throw new Error('response lost');
    });
    let committed: OwnedFileMemoryToken | undefined;
    try {
      await store.updateOwnedHead(owned, 'name: Committed\nentries: []\n');
    } catch (error) {
      expect(error).toMatchObject({ code: 'EHEADCOMMITTED', committed: true });
      committed = (error as { token: OwnedFileMemoryToken }).token;
    }
    expect(committed).toBeDefined();
    expect((await store.readHeadSnapshot(locator)).token).toEqual(committed);
  });

  it('retains a committed token if the outer tenant-fence release fails', async () => {
    const { tenantRoot, store, owned, locator } = await fixture();
    const coordinator = new FileMemoryTransactionCoordinator({
      tenantRoot, getCurrentUserId: () => USER,
      fence: {
        async withTenantFence<T>(_root: string, operation: () => Promise<T> | T): Promise<T> {
          await operation();
          throw new Error('lease release failed');
        },
      },
    });
    const failingReleaseStore = new FileMemoryOwnerSnapshots({ coordinator });
    let committed: OwnedFileMemoryToken | undefined;
    try {
      await failingReleaseStore.updateOwnedHead(owned, 'name: New\nentries: []\n');
    } catch (error) {
      expect(error).toMatchObject({ code: 'EHEADCOMMITTED', committed: true });
      committed = (error as { token: OwnedFileMemoryToken }).token;
    }
    expect(committed).toBeDefined();
    expect((await store.readHeadSnapshot(locator)).token).toEqual(committed);
  });

  it.each<UpdatePublication>(['renamed-head', 'updated-sidecar'])(
    'rejects a mutated journal at %s without committing', async phase => {
      const { store, owned, locator, headPath, hash } = await fixture(async current => {
        if (current !== phase) return;
        const journalPath = path.join(path.dirname(headPath), `.${hash}.memory-write.json`);
        const journal = JSON.parse(await fs.readFile(journalPath, 'utf8')) as Record<string, unknown>;
        journal.unexpected = 'extra';
        await fs.writeFile(journalPath, JSON.stringify(journal));
      });
      await expect(store.updateOwnedHead(owned, 'name: New\nentries: []\n'))
        .rejects.toMatchObject({ code: 'EHEADCOMMITUNKNOWN', residual: true });
      await expect(store.readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    },
  );

  it('blocks orphan and malformed matching artifacts without treating a legacy head as clean', async () => {
    const { tenantRoot, store, owned, locator, headPath, hash } = await fixture();
    const orphan = path.join(path.dirname(headPath), `.${hash}.memory-write.${owned.ownerId}.bad.tmp`);
    await fs.writeFile(orphan, 'orphan');
    await expect(store.readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    await fs.unlink(orphan);
    const uppercaseAlias = path.join(path.dirname(headPath), `.${hash}.MEMORY-WRITE.unknown.tmp`);
    await fs.writeFile(uppercaseAlias, 'orphan');
    await expect(store.readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    const reservedLocator = path.relative(tenantRoot, uppercaseAlias).split(path.sep).join('/');
    await expect(store.readHeadSnapshot(reservedLocator)).rejects.toThrow('confined relative POSIX path');
    await fs.unlink(uppercaseAlias);
    const journal = path.join(path.dirname(headPath), `.${hash}.memory-write.json`);
    await fs.writeFile(journal, '{broken', { mode: 0o600 });
    await expect(store.readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
  });

  it.each<UpdatePublication>([
    'prepared-temp', 'prepared-journal', 'renamed-head', 'published-journal',
    'updated-registry', 'updated-sidecar', 'unlinked-journal',
  ])('keeps reads fail-closed or committed after a real SIGKILL at %s', async phase => {
    const { tenantRoot, store, owned, locator } = await fixture();
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', updateChild,
      tenantRoot, USER, JSON.stringify(owned), phase,
    ], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        let errors = '';
        const timeout = setTimeout(() => reject(new Error(`Child did not reach ${phase}: ${errors}`)), 8_000);
        child.stdout.on('data', (data: Buffer) => {
          output += data.toString();
          if (output.includes('STOPPED\n')) { clearTimeout(timeout); resolve(); }
        });
        child.stderr.on('data', (data: Buffer) => { errors += data.toString(); });
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Writer exited ${code}: ${errors}`)); });
      });
      const exit = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exit;
      expect(await store.inspectInterruptedOwnedHead(locator)).toMatchObject({ kind: 'blocked-by-fence' });
      if (phase === 'unlinked-journal') {
        expect((await store.readHeadSnapshot(locator)).token).toMatchObject({ revision: '2' });
      } else {
        await expect(store.readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
      }
      // Only the test harness removes a confirmed orphan lease, after its writer is dead.
      await fs.rm(path.join(tenantRoot, '.memory-fences', 'tenant.lock'), { recursive: true });
      const diagnostic = await store.inspectInterruptedOwnedHead(locator);
      const expected = {
        'prepared-temp': 'pre-journal-orphan-candidate',
        'prepared-journal': 'prepared-not-published',
        'renamed-head': 'renamed-before-published-journal',
        'published-journal': 'published-before-registry',
        'updated-registry': 'registry-advanced',
        'updated-sidecar': 'metadata-advanced-before-unlink',
        'unlinked-journal': 'clean-consistent',
      } satisfies Record<UpdatePublication, string>;
      expect(diagnostic.kind).toBe(expected[phase]);
      expect(diagnostic).not.toHaveProperty('token');
      expect(diagnostic).not.toHaveProperty('content');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('does not create a lock directory or alter head and metadata when diagnosing a clean owner', async () => {
    const { tenantRoot, store, locator, headPath, hash } = await fixture();
    await fs.rmdir(path.join(tenantRoot, '.memory-fences'));
    const sidecar = path.join(path.dirname(headPath), `.${hash}.memory-owner.json`);
    const before = await Promise.all([headPath, sidecar].map(async name => ({
      bytes: await fs.readFile(name), mtimeMs: (await fs.stat(name)).mtimeMs,
    })));
    expect((await store.inspectInterruptedOwnedHead(locator)).kind).toBe('clean-consistent');
    await expect(fs.lstat(path.join(tenantRoot, '.memory-fences'))).rejects.toMatchObject({ code: 'ENOENT' });
    const after = await Promise.all([headPath, sidecar].map(async name => ({
      bytes: await fs.readFile(name), mtimeMs: (await fs.stat(name)).mtimeMs,
    })));
    expect(after).toEqual(before);
  });

  it('leaves malformed metadata and a missing head unknown without fabricating ownership', async () => {
    const { store, locator, headPath, hash } = await fixture();
    const journal = path.join(path.dirname(headPath), `.${hash}.memory-write.json`);
    await fs.writeFile(journal, '{broken', { mode: 0o600 });
    expect(await store.inspectInterruptedOwnedHead(locator)).toMatchObject({
      kind: 'unknown-manual-review', artifactCount: null, evidenceComplete: false,
    });
    await fs.unlink(journal);
    await fs.unlink(headPath);
    expect((await store.inspectInterruptedOwnedHead(locator)).kind).toBe('unknown-manual-review');
  });

  it('treats an extra owner field or unsafe temporary mode as unknown', async () => {
    const { store, locator, headPath, hash, owned } = await fixture();
    const sidecar = path.join(path.dirname(headPath), `.${hash}.memory-owner.json`);
    const original = await fs.readFile(sidecar, 'utf8');
    await fs.writeFile(sidecar, JSON.stringify({ ...JSON.parse(original), unexpected: true }), { mode: 0o600 });
    expect((await store.inspectInterruptedOwnedHead(locator)).kind).toBe('unknown-manual-review');
    await fs.writeFile(sidecar, original, { mode: 0o600 });
    const temp = path.join(path.dirname(headPath),
      `.${hash}.memory-write.${owned.ownerId}.22222222-2222-4222-8222-222222222222.tmp`);
    await fs.writeFile(temp, 'name: partial\n', { mode: 0o644 });
    expect((await store.inspectInterruptedOwnedHead(locator)).kind).toBe('unknown-manual-review');
  });

  it('rejects an extra journal field and an equal-content replacement inode as proof', async () => {
    const { store, locator, headPath, hash, owned } = await fixture(phase => {
      if (phase === 'prepared-journal') throw new Error('pause');
    });
    const journal = path.join(path.dirname(headPath), `.${hash}.memory-write.json`);
    await expect(store.updateOwnedHead(owned, 'name: New\nentries: []\n')).rejects.toMatchObject({
      code: 'EOWNERRECOVERY', residual: true,
    });
    const otherwiseValid = JSON.parse(await fs.readFile(journal, 'utf8'));
    await fs.writeFile(journal, JSON.stringify({ ...otherwiseValid, unexpected: true }), { mode: 0o600 });
    expect((await store.inspectInterruptedOwnedHead(locator)).kind).toBe('unknown-manual-review');
    await fs.unlink(journal);
    const [temp] = (await fs.readdir(path.dirname(headPath))).filter(name =>
      name.startsWith(`.${hash}.memory-write.`));
    await fs.unlink(path.join(path.dirname(headPath), temp));
    const replacement = `${headPath}.replacement`;
    await fs.copyFile(headPath, replacement);
    await fs.rename(replacement, headPath);
    expect((await store.inspectInterruptedOwnedHead(locator)).kind).toBe('unknown-manual-review');
  });

  it('detects exact metadata changes between passes and bounds artifact-name disclosure', async () => {
    const { store, locator, headPath, hash } = await fixture();
    const sidecar = path.join(path.dirname(headPath), `.${hash}.memory-owner.json`);
    const diagnosticStore = store as unknown as {
      readDiagnosticEvidence: (...args: unknown[]) => Promise<unknown>;
    };
    const original = diagnosticStore.readDiagnosticEvidence.bind(store);
    let reads = 0;
    diagnosticStore.readDiagnosticEvidence = async (...args) => {
      const evidence = await original(...args);
      if (++reads === 1) {
        const replacement = `${sidecar}.replacement`;
        await fs.copyFile(sidecar, replacement);
        await fs.rename(replacement, sidecar);
      }
      return evidence;
    };
    expect((await store.inspectInterruptedOwnedHead(locator)).kind).toBe('unstable-or-unknown');
    diagnosticStore.readDiagnosticEvidence = original;
    for (let index = 0; index < 40; index++) {
      await fs.writeFile(path.join(path.dirname(headPath), `.${hash}.memory-write.unknown-${index}`), 'x');
    }
    const result = await store.inspectInterruptedOwnedHead(locator);
    expect(result.kind).toBe('unknown-manual-review');
    expect(result.artifactCount).toBe(40);
    expect(result.artifactNames).toHaveLength(32);
    expect(result.artifactNamesTruncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain('name: Original');
  });

  it('reports a fence appearing between evidence passes as unstable', async () => {
    const { tenantRoot, store, locator } = await fixture();
    const diagnosticStore = store as unknown as {
      readDiagnosticEvidence: (...args: unknown[]) => Promise<unknown>;
    };
    const original = diagnosticStore.readDiagnosticEvidence.bind(store);
    let reads = 0;
    diagnosticStore.readDiagnosticEvidence = async (...args) => {
      const evidence = await original(...args);
      if (++reads === 1) await fs.mkdir(path.join(tenantRoot, '.memory-fences', 'tenant.lock'));
      return evidence;
    };
    expect(await store.inspectInterruptedOwnedHead(locator)).toMatchObject({
      kind: 'unstable-or-unknown', artifactCount: null, evidenceComplete: false,
    });
  });

  it('rejects invalid UTF-8 in a matching pre-journal temporary file', async () => {
    const { store, locator, headPath, hash, owned } = await fixture();
    const temp = path.join(path.dirname(headPath),
      `.${hash}.memory-write.${owned.ownerId}.22222222-2222-4222-8222-222222222222.tmp`);
    await fs.writeFile(temp, Buffer.from([0xff]), { mode: 0o600 });
    expect(await store.inspectInterruptedOwnedHead(locator)).toMatchObject({
      kind: 'unknown-manual-review', artifactCount: null, evidenceComplete: false,
    });
  });

  it('keeps out-of-order owner metadata and a mismatched journal user unknown', async () => {
    const { tenantRoot, store, locator, headPath, hash, owned } = await fixture(phase => {
      if (phase === 'updated-sidecar') throw new Error('pause');
    });
    const registry = path.join(tenantRoot, '.memory-owners', 'owners', `${owned.ownerId}.json`);
    const oldRegistry = await fs.readFile(registry);
    await expect(store.updateOwnedHead(owned, 'name: New\nentries: []\n')).rejects.toMatchObject({
      code: 'EHEADCOMMITUNKNOWN', residual: true,
    });
    await fs.writeFile(registry, oldRegistry, { mode: 0o600 });
    expect((await store.inspectInterruptedOwnedHead(locator)).kind).toBe('unknown-manual-review');
    const journalPath = path.join(path.dirname(headPath), `.${hash}.memory-write.json`);
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    await fs.writeFile(journalPath, JSON.stringify({ ...journal, userId: 'another-user' }), { mode: 0o600 });
    expect((await store.inspectInterruptedOwnedHead(locator)).kind).toBe('unknown-manual-review');
  });

  it('does not diagnose a symlink or hard-linked alias as an owned head', async () => {
    const { tenantRoot, store, locator, headPath } = await fixture();
    const symlink = path.join(path.dirname(headPath), 'Sym.yaml');
    await fs.symlink(headPath, symlink);
    expect((await store.inspectInterruptedOwnedHead('Notes/Sym.yaml')).kind).toBe('unknown-manual-review');
    await fs.unlink(symlink);
    const hardlink = path.join(path.dirname(headPath), 'Hard.yaml');
    await fs.link(headPath, hardlink);
    expect((await store.inspectInterruptedOwnedHead(locator)).kind).toBe('unknown-manual-review');
    expect((await store.inspectInterruptedOwnedHead(path.relative(tenantRoot, hardlink))).kind)
      .toBe('unknown-manual-review');
  });
});
