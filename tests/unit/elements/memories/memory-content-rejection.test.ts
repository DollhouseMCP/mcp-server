/**
 * A memory whose own bytes the loader refuses is a content rejection, like a broken-YAML memory:
 * the read reports a rejected definition (details answer "Invalid") and delete repairs it by exact
 * reference. A name lookup reports the same typed rejection; beta did not delete it by name either.
 * A refusal is marked where the bytes are refused, so the provenance holds through every wrapper on
 * the way out.
 */
import { describe, expect, it, afterEach, beforeEach } from '@jest/globals';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRealManagerSuite } from '../../../helpers/di-mocks.js';
import { ElementReadError, isRejectedDefinition } from '../../../../src/elements/base/ElementReadError.js';
import { isContentRejection } from '../../../../src/security/contentRejection.js';
import { MEMORY_CONSTANTS } from '../../../../src/elements/memories/constants.js';

const BOUND = 15_000;
const REFERENCE = '2026-01-02/bad.yaml';

describe('memory content rejections (M1)', () => {
  let root: string;
  let suite: ReturnType<typeof createRealManagerSuite>;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'memory-content-rejection-'));
    suite = createRealManagerSuite(root);
    dir = (suite.memoryManager as any)['memoriesDir'];
    await mkdir(path.join(dir, '2026-01-02'), { recursive: true });
  });
  afterEach(async () => {
    await suite.memoryManager.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const exists = () => access(path.join(dir, REFERENCE)).then(() => true, () => false);
  const readFailure = (reference: string) =>
    suite.memoryManager.findByStorageIdentity(reference).then(() => undefined, (error: unknown) => error);

  it.each([
    ['a numeric description', 'name: bad\ndescription: 42\nentries: []\n'],
    ['a numeric name', 'name: 12345\ndescription: d\nentries: []\n'],
    ['a name that sanitizes to empty', "name: '<<<>>>'\ndescription: d\nentries: []\n"],
    ['a retention policy that is not text', 'name: bad\ndescription: d\nretention_policy:\n  default: true\nentries: []\n'],
    ['a markdown body that sanitizes to empty', '---\nname: bad\ndescription: d\n---\n<script>alert(1)</script>\n'],
    ['a file over the legacy read limit', `name: bad\ndescription: d\nentries: []\n# ${'x'.repeat(MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE)}\n`],
  ])('reads %s as a rejected definition and deletes it by reference', async (_label, body) => {
    await writeFile(path.join(dir, REFERENCE), body);
    const failure = await readFailure(REFERENCE);
    expect(failure).toBeInstanceOf(ElementReadError);
    expect(isRejectedDefinition(failure)).toBe(true);
    // The one input the details branch reads: a content rejection answers "Invalid", never "Unavailable".
    expect((failure as ElementReadError).failures.some(entry => entry.contentRejected)).toBe(true);
    await suite.memoryManager.delete(REFERENCE);
    expect(await exists()).toBe(false);
  }, BOUND);

  // #618 L2: the memory path rule accepts the extension in any case, like every other reference rule,
  // so delete by reference removes the file a read by that reference finds.
  it.each(['Upper.YAML', 'low.YML'])('reads and deletes %s by reference alike', async reference => {
    await writeFile(path.join(dir, reference), 'name: cased\ndescription: d\nentries: []\n');
    expect((await suite.memoryManager.findByStorageIdentity(reference))?.metadata.name).toBe('cased');
    await suite.memoryManager.delete(reference);
    expect(await access(path.join(dir, reference)).then(() => true, () => false)).toBe(false);
  }, BOUND);

  it('answers a name lookup of a rejected description as a rejected definition, like broken YAML', async () => {
    await writeFile(path.join(dir, REFERENCE), 'name: bad\ndescription: 42\nentries: []\n');
    const failure = await suite.memoryManager.findByName('bad').then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(ElementReadError);
    expect((failure as ElementReadError).failures.some(entry => entry.contentRejected)).toBe(true);
  }, BOUND);

  it('keeps an entry rejection typed through deserialize, which marks nothing itself', async () => {
    await writeFile(path.join(dir, REFERENCE), 'name: good\ndescription: d\nentries: []\n');
    const loaded = await suite.memoryManager.findByStorageIdentity(REFERENCE);
    const frame = { id: loaded!.id, type: loaded!.type, version: '1.0.0', metadata: loaded!.metadata, extensions: {} };
    const oversized = { id: 'e1', timestamp: '2026-01-01T00:00:00.000Z', source: 'file',
      content: 'x'.repeat(MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE + 1) };
    const refusal = (data: object) => { try { loaded!.deserialize(JSON.stringify(data)); } catch (error) { return error; } };
    expect(isContentRejection(refusal({ ...frame, entries: [oversized] }))).toBe(true);
    expect(isContentRejection(refusal({ ...frame, type: 'skills' }))).toBe(true);
  }, BOUND);
});
