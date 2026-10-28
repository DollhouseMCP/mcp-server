import { describe, expect, it } from '@jest/globals';
import { open, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SecureYamlParser, matchFrontmatterFrame } from '../../../src/security/secureYamlParser.js';
import { readFrontmatter } from '../../../src/security/readFrontmatter.js';

async function read(content: string, chunk: number, limit: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'frontmatter-read-'));
  const filePath = path.join(directory, 'sample.md');
  try {
    await writeFile(filePath, content);
    const file = await open(filePath, 'r');
    try { return await readFrontmatter(file, Buffer.alloc(chunk), limit); }
    finally { await file.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

describe('bounded frontmatter reading', () => {
  it.each([1, 4, 16])('preserves UTF-8 and CRLF across %s-byte chunks', async chunk => {
    expect(await read('---\r\nname: café🙂\r\n---\r\nBody', chunk, 32)).toBe('name: café🙂');
  });

  it.each(['\n', '\r\n'])('treats an empty block as absent with %j line endings', async newline => {
    const input = `---${newline}---${newline}Body`;
    expect(matchFrontmatterFrame(input)).toBeNull();
    expect(SecureYamlParser.parse(input).data).toEqual({});
    expect(await read(input, 1, 32)).toBeUndefined();
  });

  it('refuses unmatched framing when the bound is reached before EOF', async () => {
    expect(await read(`---\n${'x'.repeat(100)}`, 4, 20)).toBeNull();
  });

  it('counts the YAML payload without fences at the exact parser bound', async () => {
    expect(await read('---\r\nname: abc\r\n---\nBody', 3, 9)).toBe('name: abc');
    expect(await read('---\r\nname: abcd\r\n---\nBody', 3, 9)).toBeNull();
  });

  it('treats unmatched framing at EOF as absent', async () => {
    expect(await read('Body', 1, 20)).toBeUndefined();
    expect(await read('---\nname: sample', 2, 20)).toBeUndefined();
    expect(await read('---', 1, 20)).toBeUndefined();
  });
});
