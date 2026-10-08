import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ElementFileOperations } from '../../../src/elements/base/ElementFileOperations.js';
import { FileLockManager } from '../../../src/security/fileLockManager.js';

const sentinel = globalThis as typeof globalThis & { __elementFrontmatterExecuted?: boolean };
const executableBody = '---javascript\n(() => { globalThis.__elementFrontmatterExecuted = true; return { name: "benign marker" }; })()\n---\nBody';
let directory: string;
let operations: ElementFileOperations;
let locks: FileLockManager;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'element-frontmatter-security-'));
  locks = new FileLockManager(); operations = new ElementFileOperations(locks);
  delete sentinel.__elementFrontmatterExecuted;
});
afterEach(async () => {
  jest.restoreAllMocks(); delete sentinel.__elementFrontmatterExecuted;
  await rm(directory, { recursive: true, force: true });
});

describe('shipped ElementFileOperations nonexecuting frontmatter boundary', () => {
  it.each(['', '\ufeff'])('refuses executable read language before a harmless marker runs (BOM=%j)', async bom => {
    await writeFile(path.join(directory, 'read.md'), bom + executableBody);
    await expect(operations.readFileWithFrontmatter('read.md', directory)).rejects.toThrow('Unsupported frontmatter language');
    expect(sentinel.__elementFrontmatterExecuted).toBeUndefined();
  });
  it.each(['', '\ufeff'])('refuses executable write-body language before a harmless marker or file write (BOM=%j)', async bom => {
    const write = jest.spyOn(locks, 'atomicWriteFile');
    await expect(operations.writeFileWithFrontmatter('write.md', { name: 'outer' }, bom + executableBody, directory))
      .rejects.toThrow('Unsupported frontmatter language');
    expect(sentinel.__elementFrontmatterExecuted).toBeUndefined(); expect(write).not.toHaveBeenCalled();
    await expect(readFile(path.join(directory, 'write.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([
    ['---\nname: ordinary\nactive: true\ncount: 2\ntags: [one, two]\n---\n\nBody', { name: 'ordinary', active: true, count: 2, tags: ['one', 'two'] }],
    ['---yaml\nname: named\n---\nBody', { name: 'named' }],
    ['\ufeff---json\n{"name":"json","active":true,"nested":{"value":2}}\n---\nBody', { name: 'json', active: true, nested: { value: 2 } }],
    ['Plain Markdown body', {}]
  ])('returns admitted metadata and untouched raw input through the real injected read: %s', async (raw, metadata) => {
    const read = jest.spyOn(locks, 'atomicReadFile');
    await writeFile(path.join(directory, 'read.md'), raw);
    const result = await operations.readFileWithFrontmatter('read.md', directory);
    expect(result.metadata).toEqual(metadata); expect(result.raw).toBe(raw);
    expect(result.content).toContain(raw === 'Plain Markdown body' ? raw : 'Body');
    expect(read).toHaveBeenCalledWith(path.join(directory, 'read.md'), { encoding: 'utf-8' });
  });
  it.each(['---\nname: inner\nextra: keep\n---\nBody', '---json\n{"name":"inner","extra":"keep"}\n---\nBody'])(
    'keeps body-unwrapping precedence, insertion order and metadata cleaning: %s', async body => {
      const write = jest.spyOn(locks, 'atomicWriteFile');
      await operations.writeFileWithFrontmatter('nested/write.md', { z: 1, name: 'outer', a: false,
        description: undefined, gatekeeperDiagnostics: 'internal-only' }, body, directory);
      const target = path.join(directory, 'nested', 'write.md');
      const raw = await readFile(target, 'utf8');
      const z = body.startsWith('---json') ? '"z": 1' : 'z: 1';
      const a = body.startsWith('---json') ? '"a": false' : 'a: false';
      expect(raw).toContain(z); expect(raw).toContain(a);
      expect(raw.indexOf(z)).toBeLessThan(raw.indexOf(a));
      expect(raw).not.toContain('gatekeeperDiagnostics'); expect(raw).not.toContain('description:');
      expect(write).toHaveBeenCalledWith(target, raw, { encoding: 'utf-8' });
      const result = await operations.readFileWithFrontmatter('nested/write.md', directory);
      expect(result.metadata).toEqual({ name: 'outer', extra: 'keep', z: 1, a: false }); expect(result.content.trim()).toBe('Body');
    });
  it('uses the helper size policy without introducing the wrapper default frontmatter cap', async () => {
    const raw = `---\nname: ordinary\nnotes: ${'x'.repeat(65 * 1024)}\n---\nBody`;
    await writeFile(path.join(directory, 'read.md'), raw);
    expect((await operations.readFileWithFrontmatter('read.md', directory, { maxSize: 128 * 1024 })).metadata.notes)
      .toHaveLength(65 * 1024);
    await expect(operations.readFileWithFrontmatter('read.md', directory, { maxSize: 64 * 1024 })).rejects.toThrow('File too large');
  });
  it('refuses default-schema-only explicit tags without changing the owned file', async () => {
    const raw = '---\nname: ordinary\ncreated: !!timestamp 2026-10-01\n---\nBody';
    await writeFile(path.join(directory, 'read.md'), raw);
    await expect(operations.readFileWithFrontmatter('read.md', directory)).rejects.toThrow();
    expect(await readFile(path.join(directory, 'read.md'), 'utf8')).toBe(raw);
  });
  it('refuses unsupported metadata objects instead of silently dropping them', async () => {
    const write = jest.spyOn(locks, 'atomicWriteFile');
    await expect(operations.writeFileWithFrontmatter('write.md', { name: 'ordinary',
      created: new Date('2026-10-01T00:00:00Z') }, 'Body', directory)).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    await operations.writeFileWithFrontmatter('write.md', { name: 'ordinary', created: '2026-10-01T00:00:00Z' }, 'Body', directory);
    expect((await operations.readFileWithFrontmatter('write.md', directory)).metadata.created).toBe('2026-10-01T00:00:00Z');
  });
});
