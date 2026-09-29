import { afterEach, describe, expect, it } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { classifyFileMemoryWrite } from '../../../src/storage/FileMemoryWriteClassification.js';
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
  const [tenantRoot, userId, tokenJson, stopPhase, stopStage, stopPoint] = process.argv.slice(1);
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
    duringUpdateMetadataStage: (stage, point) => {
      if (stage === stopStage && point === stopPoint) {
        process.stdout.write('STOPPED\\n');
        process.stdin.resume();
        return new Promise(() => {});
      }
    },
  });
  await store.updateOwnedHead(JSON.parse(tokenJson), 'name: Child update\\nentries: []\\n');
`;
const inspectChild = `
  import { FileMemoryOwnerSnapshots } from ${JSON.stringify(new URL(`FileMemoryOwnerSnapshots.${sourceExtension}`, moduleRoot).href)};
  import { FileMemoryTransactionCoordinator } from ${JSON.stringify(new URL(`FileMemoryTransactionCoordinator.${sourceExtension}`, moduleRoot).href)};
  import { FileMemoryFence } from ${JSON.stringify(new URL(`FileMemoryFence.${sourceExtension}`, moduleRoot).href)};
  const [tenantRoot, userId, locator] = process.argv.slice(1);
  const coordinator = new FileMemoryTransactionCoordinator({
    tenantRoot, getCurrentUserId: () => userId, fence: new FileMemoryFence(),
  });
  const store = new FileMemoryOwnerSnapshots({ coordinator });
  let readCode = 'clean';
  try { await store.readHeadSnapshot(locator); } catch (error) { readCode = error.code ?? 'unknown'; }
  const diagnostic = await store.inspectInterruptedOwnedHead(locator);
  process.stdout.write(JSON.stringify({ readCode, kind: diagnostic.kind,
    evidenceComplete: diagnostic.evidenceComplete, artifactCount: diagnostic.artifactCount,
    artifactNamesRedacted: diagnostic.artifactNamesRedacted }));
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

  it.each([
    ['published-journal', 'existing'], ['published-journal', 'malformed'],
    ['published-journal', 'wrong-operation'], ['active-registry', 'case-alias'],
    ['active-registry', 'non-private'], ['active-registry', 'symlink'],
    ['active-registry', 'wrong-owner'],
    ['active-sidecar', 'hardlink'], ['active-sidecar', 'legacy-random'],
  ] as const)('preserves a %s %s collision without replacing metadata', async (stage, variant) => {
    const { tenantRoot, owned, locator, headPath, hash, store } = await fixture();
    let artifact = '';
    let target = '';
    let targetBefore = Buffer.alloc(0);
    const coordinator = new FileMemoryTransactionCoordinator({
      tenantRoot, getCurrentUserId: () => USER, fence: new FileMemoryFence(),
    });
    const colliding = new FileMemoryOwnerSnapshots({
      coordinator,
      afterUpdatePublication: async phase => {
        const beforeStage = stage === 'published-journal' ? 'renamed-head'
          : stage === 'active-registry' ? 'published-journal' : 'updated-registry';
        if (phase !== beforeStage) return;
        const journal = JSON.parse(await fs.readFile(
          path.join(path.dirname(headPath), `.${hash}.memory-write.json`), 'utf8',
        )) as { operationId: string };
        target = stage === 'published-journal'
          ? path.join(path.dirname(headPath), `.${hash}.memory-write.json`)
          : stage === 'active-registry'
            ? path.join(tenantRoot, '.memory-owners', 'owners', `${owned.ownerId}.json`)
            : path.join(path.dirname(headPath), `.${hash}.memory-owner.json`);
        targetBefore = await fs.readFile(target);
        artifact = `${target}.update-${journal.operationId}.tmp`;
        if (variant === 'wrong-operation') artifact = `${target}.update-${randomUUID()}.tmp`;
        if (variant === 'legacy-random') artifact = `${target}.${randomUUID()}.tmp`;
        if (variant === 'case-alias') artifact = artifact.replace('.update-', '.UPDATE-');
        if (variant === 'symlink') await fs.symlink(target, artifact);
        else if (variant === 'hardlink') await fs.link(target, artifact);
        else {
          let content: string | Buffer = variant === 'malformed' ? '{broken' : targetBefore;
          if (variant === 'wrong-owner') {
            const wrong = JSON.parse(targetBefore.toString('utf8')) as Record<string, unknown>;
            wrong.ownerId = randomUUID();
            content = JSON.stringify(wrong);
          }
          await fs.writeFile(artifact, content,
            { mode: variant === 'non-private' ? 0o644 : 0o600, flag: 'wx' });
        }
      },
    });
    await expect(colliding.updateOwnedHead(owned, 'name: Collision\nentries: []\n'))
      .rejects.toMatchObject({ residual: true });
    expect(await fs.readFile(target)).toEqual(targetBefore);
    expect(await fs.lstat(artifact)).toBeDefined();
    await expect(store.readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
  });

  it('accepts an uppercase owner UUID yet catches its case-folded registry stage alias', async () => {
    const { tenantRoot, store, owned, locator, headPath, hash } = await fixture();
    const upperId = owned.ownerId.toUpperCase();
    const registry = path.join(tenantRoot, '.memory-owners', 'owners', `${owned.ownerId}.json`);
    const upperRegistry = path.join(tenantRoot, '.memory-owners', 'owners', `${upperId}.json`);
    const sidecar = path.join(path.dirname(headPath), `.${hash}.memory-owner.json`);
    for (const recordPath of [registry, sidecar]) {
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as Record<string, unknown>;
      record.ownerId = upperId;
      await fs.writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
    }
    await fs.rename(registry, upperRegistry);
    const upperToken = (await store.readHeadSnapshot(locator)).token as OwnedFileMemoryToken;
    expect(upperToken.ownerId).toBe(upperId);
    let alias = '';
    const coordinator = new FileMemoryTransactionCoordinator({
      tenantRoot, getCurrentUserId: () => USER, fence: new FileMemoryFence(),
    });
    const colliding = new FileMemoryOwnerSnapshots({
      coordinator,
      afterUpdatePublication: async phase => {
        if (phase !== 'published-journal') return;
        const journal = JSON.parse(await fs.readFile(
          path.join(path.dirname(headPath), `.${hash}.memory-write.json`), 'utf8',
        )) as { operationId: string };
        alias = `${upperRegistry}.UPDATE-${journal.operationId}.TMP`;
        await fs.writeFile(alias, '{broken', { mode: 0o600, flag: 'wx' });
      },
    });
    await expect(colliding.updateOwnedHead(upperToken, 'name: New\nentries: []\n'))
      .rejects.toMatchObject({ residual: true });
    expect(await fs.readFile(alias, 'utf8')).toBe('{broken');
    await expect(store.readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
  });

  it('accepts an authored gatekeeper policy that normal memory saves accept', async () => {
    const { store, owned, locator } = await fixture();
    const content = 'name: Valid\nmetadata:\n  gatekeeper:\n    externalRestrictions:\n' +
      '      description: Block removal\n      denyPatterns:\n        - "Bash:rm *"\nentries: []\n';
    const updated = await store.updateOwnedHead(owned, content);
    expect(updated.revision).toBe('2');
    expect((await store.readHeadSnapshot(locator)).content).toBe(content);
  });

  it('stages only the three UPDATE metadata replacements at operation-bound names', async () => {
    const { tenantRoot, store, owned, headPath, hash } = await fixture();
    const observed: string[] = [];
    const coordinator = new FileMemoryTransactionCoordinator({
      tenantRoot, getCurrentUserId: () => USER, fence: new FileMemoryFence(),
    });
    const inspected = new FileMemoryOwnerSnapshots({
      coordinator,
      duringUpdateMetadataStage: async (stage, point) => {
        if (point !== 'verified-before-rename') return;
        const journal = JSON.parse(await fs.readFile(
          path.join(path.dirname(headPath), `.${hash}.memory-write.json`), 'utf8',
        )) as { operationId: string };
        const target = stage === 'published-journal'
          ? path.join(path.dirname(headPath), `.${hash}.memory-write.json`)
          : stage === 'active-registry'
            ? path.join(tenantRoot, '.memory-owners', 'owners', `${owned.ownerId}.json`)
            : path.join(path.dirname(headPath), `.${hash}.memory-owner.json`);
        const staged = `${target}.update-${journal.operationId}.tmp`;
        const siblings = (await fs.readdir(path.dirname(target)))
          .filter(name => name.toLowerCase().startsWith(`${path.basename(target).toLowerCase()}.`));
        expect(siblings).toEqual([path.basename(staged)]);
        const raw = await fs.readFile(staged, 'utf8');
        const parsed = JSON.parse(raw) as { state: string; operationId?: string; revision?: string };
        expect(parsed.state).toBe(stage === 'published-journal' ? 'PUBLISHED_WRITE' : 'ACTIVE');
        expect(parsed.operationId ?? journal.operationId).toBe(journal.operationId);
        if (stage !== 'published-journal') expect(parsed.revision).toBe('2');
        const stat = await fs.stat(staged);
        expect(stat.isFile()).toBe(true);
        expect(stat.nlink).toBe(1);
        expect(stat.mode & 0o077).toBe(0);
        observed.push(staged);
      },
    });
    await inspected.updateOwnedHead(owned, 'name: Staged\nentries: []\n');
    expect(observed).toHaveLength(3);
    for (const staged of observed) await expect(fs.stat(staged)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.readHeadSnapshot('Notes/ÜberNote.yaml')).token).toMatchObject({ revision: '2' });
  });

  it.each(['published-journal', 'active-registry', 'active-sidecar'] as const)(
    'rejects a same-byte replacement inode before %s rename', async stage => {
      const { tenantRoot, store, owned, headPath, hash, locator } = await fixture();
      const coordinator = new FileMemoryTransactionCoordinator({
        tenantRoot, getCurrentUserId: () => USER, fence: new FileMemoryFence(),
      });
      const swapping = new FileMemoryOwnerSnapshots({
        coordinator,
        duringUpdateMetadataStage: async (current, point) => {
          if (current !== stage || point !== 'verified-before-rename') return;
          const journal = JSON.parse(await fs.readFile(
            path.join(path.dirname(headPath), `.${hash}.memory-write.json`), 'utf8',
          )) as { operationId: string };
          const target = stage === 'published-journal'
            ? path.join(path.dirname(headPath), `.${hash}.memory-write.json`)
            : stage === 'active-registry'
              ? path.join(tenantRoot, '.memory-owners', 'owners', `${owned.ownerId}.json`)
              : path.join(path.dirname(headPath), `.${hash}.memory-owner.json`);
          const staged = `${target}.update-${journal.operationId}.tmp`;
          const bytes = await fs.readFile(staged);
          const replacement = `${staged}.replacement`;
          await fs.writeFile(replacement, bytes, { mode: 0o600, flag: 'wx' });
          await fs.rename(replacement, staged);
        },
      });
      await expect(swapping.updateOwnedHead(owned, 'name: Swapped\nentries: []\n'))
        .rejects.toMatchObject({ residual: true, cause: { code: 'EOWNERRECOVERY' } });
      await expect(store.readHeadSnapshot(locator)).rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
    },
  );

  it.each([
    ['published-journal', 'partial-write'], ['published-journal', 'verified-before-rename'],
    ['active-registry', 'partial-write'], ['active-registry', 'verified-before-rename'],
    ['active-sidecar', 'partial-write'], ['active-sidecar', 'verified-before-rename'],
  ] as const)('preserves %s %s stage after a real SIGKILL', async (stage, point) => {
    const { tenantRoot, store, owned, locator, headPath, hash } = await fixture();
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', updateChild,
      tenantRoot, USER, JSON.stringify(owned), 'none', stage, point,
    ], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        let errors = '';
        const timeout = setTimeout(() => reject(new Error(`Child did not stage ${stage}/${point}: ${errors}`)), 8_000);
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
      const journal = JSON.parse(await fs.readFile(
        path.join(path.dirname(headPath), `.${hash}.memory-write.json`), 'utf8',
      )) as { operationId: string };
      const target = stage === 'published-journal'
        ? path.join(path.dirname(headPath), `.${hash}.memory-write.json`)
        : stage === 'active-registry'
          ? path.join(tenantRoot, '.memory-owners', 'owners', `${owned.ownerId}.json`)
          : path.join(path.dirname(headPath), `.${hash}.memory-owner.json`);
      const staged = `${target}.update-${journal.operationId}.tmp`;
      const beforeBytes = await fs.readFile(staged);
      const beforeStat = await fs.stat(staged, { bigint: true });
      const beforeHead = await fs.readFile(headPath);
      const beforeTarget = await fs.readFile(target);
      if (point === 'partial-write') {
        expect(() => JSON.parse(beforeBytes.toString('utf8'))).toThrow();
      } else {
        expect(JSON.parse(beforeBytes.toString('utf8'))).toMatchObject({
          state: stage === 'published-journal' ? 'PUBLISHED_WRITE' : 'ACTIVE',
        });
      }
      const probe = JSON.parse(execFileSync(process.execPath, [
        '--import', 'tsx', '--input-type=module', '--eval', inspectChild,
        tenantRoot, USER, locator,
      ], { cwd: process.cwd(), encoding: 'utf8', timeout: 8_000 })) as {
        readCode: string; kind: string; evidenceComplete: boolean; artifactCount: number | null;
        artifactNamesRedacted: boolean;
      };
      expect(probe.readCode).toBe('EOWNERRECOVERY');
      expect(probe.kind).toBe('blocked-by-fence');
      // Operator-controlled test teardown after the child is confirmed dead;
      // no production reader or writer removes an abandoned lease.
      const lease = path.join(tenantRoot, '.memory-fences', 'tenant.lock');
      expect(await fs.readdir(lease)).toEqual(['owner']);
      await fs.unlink(path.join(lease, 'owner'));
      await fs.rmdir(lease);
      const afterQuiescence = JSON.parse(execFileSync(process.execPath, [
        '--import', 'tsx', '--input-type=module', '--eval', inspectChild,
        tenantRoot, USER, locator,
      ], { cwd: process.cwd(), encoding: 'utf8', timeout: 8_000 })) as typeof probe;
      expect(afterQuiescence).toMatchObject({
        readCode: 'EOWNERRECOVERY', kind: 'unknown-manual-review',
        evidenceComplete: true, artifactNamesRedacted: true,
      });
      expect(afterQuiescence.artifactCount).toBeGreaterThan(0);
      await expect(store.updateOwnedHead(owned, 'name: Retry\nentries: []\n'))
        .rejects.toMatchObject({ code: 'EOWNERRECOVERY' });
      expect(await fs.readFile(staged)).toEqual(beforeBytes);
      expect(await fs.readFile(headPath)).toEqual(beforeHead);
      expect(await fs.readFile(target)).toEqual(beforeTarget);
      const afterStat = await fs.stat(staged, { bigint: true });
      expect(afterStat.mtimeNs).toBe(beforeStat.mtimeNs);
      expect(afterStat.ino).toBe(beforeStat.ino);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exit;
      }
    }
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

  it('detects exact metadata changes between passes and redacts unexpected artifact names', async () => {
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
    expect(result.artifactNames).toHaveLength(0);
    expect(result.artifactNamesRedacted).toBe(true);
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

  it('does not disclose unbound journal or owner identifiers while diagnosing', async () => {
    const { tenantRoot, store, locator, headPath, hash, owned } = await fixture(phase => {
      if (phase === 'prepared-journal') throw new Error('pause');
    });
    await expect(store.updateOwnedHead(owned, 'name: New\nentries: []\n')).rejects.toMatchObject({
      code: 'EOWNERRECOVERY', residual: true,
    });
    const journalPath = path.join(path.dirname(headPath), `.${hash}.memory-write.json`);
    const sidecarPath = path.join(path.dirname(headPath), `.${hash}.memory-owner.json`);
    const registryPath = path.join(tenantRoot, '.memory-owners', 'owners', `${owned.ownerId}.json`);
    const originalJournal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    const originalSidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8'));
    const originalRegistry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    const foreignUser = '22222222-2222-4222-8222-222222222222';
    const foreignOwner = '33333333-3333-4333-8333-333333333333';
    const foreignOperation = '44444444-4444-4444-8444-444444444444';
    const foreignLocator = 'Other/ÜberNote.yaml';
    const originalTemp = path.join(path.dirname(headPath), originalJournal.preparedTempName);
    const foreignTempName = `.${hash}.memory-write.${foreignOwner}.${originalJournal.operationId}.tmp`;
    const foreignTemp = path.join(path.dirname(headPath), foreignTempName);
    await fs.copyFile(originalTemp, foreignTemp);
    await fs.chmod(foreignTemp, 0o600);
    const foreignTempStat = await fs.stat(foreignTemp, { bigint: true });
    const foreignTempIdentity = {
      device: foreignTempStat.dev.toString(), inode: foreignTempStat.ino.toString(),
      size: foreignTempStat.size.toString(), ctimeNs: foreignTempStat.ctimeNs.toString(),
      mtimeNs: foreignTempStat.mtimeNs.toString(),
    };
    const cases = [
      { target: journalPath, record: { ...originalJournal, userId: foreignUser } },
      { target: journalPath, record: { ...originalJournal, ownerId: foreignOwner,
        preparedTempName: foreignTempName, preparedTempIdentity: foreignTempIdentity } },
      { target: journalPath, record: { ...originalJournal, locator: foreignLocator } },
      { target: sidecarPath, record: { ...originalSidecar, userId: foreignUser } },
      { target: registryPath, record: { ...originalRegistry, userId: foreignUser } },
    ];
    const journalReader = store as unknown as {
      readJournalEvidence: (name: string) => Promise<{ record: unknown } | undefined>;
    };
    for (const { target, record } of cases) {
      await fs.writeFile(journalPath, JSON.stringify(originalJournal), { mode: 0o600 });
      await fs.writeFile(sidecarPath, JSON.stringify(originalSidecar), { mode: 0o600 });
      await fs.writeFile(registryPath, JSON.stringify(originalRegistry), { mode: 0o600 });
      await fs.writeFile(target, JSON.stringify(record), { mode: 0o600 });
      // Prove the changed journal passes structural validation; otherwise the
      // test would merely exercise the malformed-JSON fallback.
      expect((await journalReader.readJournalEvidence(journalPath))?.record).toBeDefined();
      const paths = [headPath, journalPath, sidecarPath, registryPath, originalTemp, foreignTemp];
      const before = await Promise.all(paths.map(async name => ({
        bytes: await fs.readFile(name), mtimeMs: (await fs.stat(name)).mtimeMs,
      })));
      const diagnostic = await store.inspectInterruptedOwnedHead(locator);
      expect(diagnostic).toMatchObject({
        kind: 'unknown-manual-review', artifactNames: [], artifactCount: null, evidenceComplete: false,
      });
      const output = JSON.stringify(diagnostic);
      for (const secret of [foreignUser, foreignOwner, foreignOperation, foreignLocator,
        originalJournal.operationId, foreignTempName]) {
        expect(output).not.toContain(secret);
      }
      const after = await Promise.all(paths.map(async name => ({
        bytes: await fs.readFile(name), mtimeMs: (await fs.stat(name)).mtimeMs,
      })));
      expect(after).toEqual(before);
    }
  });

  it('counts but redacts an unexpected foreign-named artifact beside a bound journal', async () => {
    const { store, locator, headPath, hash, owned } = await fixture(phase => {
      if (phase === 'prepared-journal') throw new Error('pause');
    });
    await expect(store.updateOwnedHead(owned, 'name: New\nentries: []\n')).rejects.toMatchObject({
      code: 'EOWNERRECOVERY', residual: true,
    });
    const foreignOwner = '33333333-3333-4333-8333-333333333333';
    const foreignOperation = '44444444-4444-4444-8444-444444444444';
    const extra = path.join(path.dirname(headPath),
      `.${hash}.memory-write.${foreignOwner}.${foreignOperation}.tmp`);
    await fs.writeFile(extra, 'foreign residual', { mode: 0o600 });
    const before = await fs.readFile(extra);
    const diagnostic = await store.inspectInterruptedOwnedHead(locator);
    expect(diagnostic).toMatchObject({
      kind: 'unknown-manual-review', artifactNames: [], artifactNamesRedacted: true,
      evidenceComplete: true,
    });
    expect(diagnostic.artifactCount).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostic)).not.toContain(foreignOwner);
    expect(JSON.stringify(diagnostic)).not.toContain(foreignOperation);
    expect(await fs.readFile(extra)).toEqual(before);
  });

  it('sanitizes unbound evidence even when the pure classifier is called directly', () => {
    const identity = { device: '1', inode: '2', size: '3', ctimeNs: '4', mtimeNs: '5' };
    const foreignOperation = '44444444-4444-4444-8444-444444444444';
    const foreignOwner = '33333333-3333-4333-8333-333333333333';
    const diagnostic = classifyFileMemoryWrite({
      userId: USER, locator: 'Notes/ÜberNote.yaml', head: { hash: 'a', identity },
      sidecar: { state: 'ACTIVE', userId: USER, ownerId: USER,
        locator: 'Notes/ÜberNote.yaml', revision: '1', contentHash: 'a', fileIdentity: identity },
      registry: { state: 'ACTIVE', userId: USER, ownerId: USER,
        locator: 'Notes/ÜberNote.yaml', revision: '1', contentHash: 'a', fileIdentity: identity },
      journal: { state: 'PREPARED_WRITE', userId: USER, ownerId: foreignOwner,
        locator: 'Notes/ÜberNote.yaml', operationId: foreignOperation,
        oldRevision: '1', newRevision: '2', oldContentHash: 'a', newContentHash: 'b',
        oldFileIdentity: identity, preparedTempName: `foreign-${foreignOperation}`,
        preparedTempIdentity: identity },
      artifactNames: [`foreign-${foreignOperation}`], unexpectedArtifacts: true,
    });
    expect(diagnostic).toMatchObject({
      kind: 'unknown-manual-review', artifactNames: [], artifactCount: null, evidenceComplete: false,
    });
    expect(JSON.stringify(diagnostic)).not.toContain(foreignOperation);
    expect(JSON.stringify(diagnostic)).not.toContain(foreignOwner);
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
