import { afterEach, describe, expect, it as test, jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileMemoryDirectoryScanBudget } from '../../../src/storage/FileMemoryDirectoryScanBudget.js';
import { FileMemoryListProofBudget } from '../../../src/storage/FileMemoryListProofBudget.js';
import { FileMemoryFence } from '../../../src/storage/FileMemoryFence.js';
import { FileMemoryOwnerSnapshots, type UnownedFileMemoryToken } from '../../../src/storage/FileMemoryOwnerSnapshots.js';
import { FileMemoryTransactionCoordinator } from '../../../src/storage/FileMemoryTransactionCoordinator.js';
import { FileMemoryVolumeStore } from '../../../src/storage/FileMemoryVolumeStore.js';

const it = process.platform === 'win32' || !process.getuid ? test.skip : test;
const USER = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];
afterEach(async () => { jest.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function portfolio(count: number, nested: boolean, archived: boolean) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'archive-list-capacity-')));
  roots.push(root);
  const locator = nested ? 'Notes/head.yaml' : 'head.yaml';
  const parent = path.dirname(path.join(root, locator));
  if (nested) await fs.mkdir(parent);
  const raw = 'entries: []\n';
  await fs.writeFile(path.join(root, locator), raw, { mode: 0o600 });
  const coordinator = new FileMemoryTransactionCoordinator({ tenantRoot: root, getCurrentUserId: () => USER, fence: new FileMemoryFence() });
  const owners = new FileMemoryOwnerSnapshots({ coordinator });
  const token = await owners.adoptUnowned((await owners.readHeadSnapshot(locator)).token as UnownedFileMemoryToken);
  const store = new FileMemoryVolumeStore({ coordinator, owners });
  if (archived) await store.createExclusive(token, { minimumVolume: 1, rawContent: raw, entryCount: 0, sealedAt: new Date('2026-10-01T00:00:00Z') });
  const registry = path.join(root, '.memory-owners', 'owners');
  const byId = path.join(root, 'volumes', 'by-id');
  await fs.mkdir(byId, { recursive: true, mode: 0o700 });
  // Valid persisted fixtures, not a claim about adoption throughput: each real head
  // has exact current identity and matching ACTIVE sidecar/registry records.
  for (let index = 1; index < count; index++) {
    const siblingLocator = path.posix.join(path.posix.dirname(locator), `Existing${index}.yaml`);
    const head = path.join(root, siblingLocator), ownerId = randomUUID();
    await fs.writeFile(head, raw, { mode: 0o600 });
    const stat = await fs.stat(head, { bigint: true });
    const record = JSON.stringify({ schema: 1, state: 'ACTIVE', userId: USER, ownerId, locator: siblingLocator, revision: '1',
      contentHash: createHash('sha256').update(raw).digest('hex'), fileIdentity: {
        device: String(stat.dev), inode: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
      } });
    const hash = createHash('sha256').update(path.basename(head)).digest('hex');
    await fs.writeFile(path.join(parent, `.${hash}.memory-owner.json`), record, { mode: 0o600 });
    await fs.writeFile(path.join(registry, `${ownerId}.json`), record, { mode: 0o600 });
    await fs.mkdir(path.join(byId, ownerId), { mode: 0o700 });
  }
  expect((await owners.readHeadSnapshot(path.posix.join(path.posix.dirname(locator), 'Existing1.yaml'))).token.ownership).toBe('owned');
  const current = await owners.readHeadSnapshot(locator);
  expect(current.token).toEqual(token);
  return { root, store, token };
}

describe('file archive listing in populated portfolios', () => {
  for (const count of [100, 250, 1000]) {
    it.each([[false, false], [false, true], [true, false], [true, true]])(
      `lists a ${count}-owner portfolio (nested=%s, archived=%s)`, async (nested, archived) => {
        const f = await portfolio(count, nested, archived);
        const before = await fs.readdir(f.root);
        const records: { budget: FileMemoryListProofBudget; discovery: number }[] = [];
        const reserve = FileMemoryListProofBudget.prototype.reserve;
        jest.spyOn(FileMemoryListProofBudget.prototype, 'reserve').mockImplementation(function(this: FileMemoryListProofBudget, ...args) {
          records.push({ budget: this, discovery: this.consumed }); return reserve.apply(this, args);
        });
        const archiveReads = jest.spyOn(FileMemoryDirectoryScanBudget.prototype, 'read');
        const started = performance.now();
        const result = await f.store.list(f.token);
        expect(records).toHaveLength(1);
        const proof = records[0].budget;
        const archiveBudget = archiveReads.mock.contexts[0] as FileMemoryDirectoryScanBudget | undefined;
        const archiveAttempts = archiveBudget?.consumed ?? 0;
        expect(result.scannedCount).toBe(proof.consumed + archiveAttempts);
        expect(proof.consumed).toBeGreaterThanOrEqual(records[0].discovery);
        expect(proof.consumed).toBeLessThanOrEqual(proof.limit); expect(proof.limit).toBeLessThanOrEqual(327680);
        expect(archiveAttempts).toBeLessThanOrEqual(1000);
        process.stderr.write(`Listing capacity ${JSON.stringify({ count, nested, archived, proofAttempts: proof.consumed,
          archiveAttempts, discovery: records[0].discovery, reserved: proof.limit, identityChecks: proof.identityChecks,
          scannedCount: result.scannedCount, elapsedMs: performance.now() - started })}\n`);
        expect(result).toMatchObject({ complete: true, totalCount: archived ? 1 : 0, returnedCount: archived ? 1 : 0 });
        expect(result.entries.map(entry => entry.volume)).toEqual(archived ? [1] : []);
        expect(await fs.readdir(f.root)).toEqual(before);
      });
  }
});
