/**
 * Tests for FileSharedPoolWriteStrategy — file-mode element writing.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileSharedPoolWriteStrategy } from '../../../../src/collection/shared-pool/SharedPoolInstaller.js';
import type { SharedPoolInstallRequest } from '../../../../src/collection/shared-pool/types.js';

describe('FileSharedPoolWriteStrategy', () => {
  let tmpDir: string;
  let strategy: FileSharedPoolWriteStrategy;

  const makeRequest = (overrides?: Partial<SharedPoolInstallRequest>): SharedPoolInstallRequest => ({
    content: '---\nname: test-element\nversion: 1.0.0\n---\nContent body',
    elementType: 'personas',
    name: 'test-element',
    origin: 'collection',
    sourceUrl: null,
    sourceVersion: null,
    ...overrides,
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shared-pool-write-'));
    strategy = new FileSharedPoolWriteStrategy(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes element content to shared/<type>/<name>.md', async () => {
    const request = makeRequest();
    const elementId = await strategy.writeElement(request, 'a'.repeat(64));

    expect(elementId).toBe('personas/test-element.md');
    const content = await fs.readFile(path.join(tmpDir, 'personas', 'test-element.md'), 'utf-8');
    expect(content).toBe(request.content);
  });

  it('creates the type directory if it does not exist', async () => {
    await strategy.writeElement(makeRequest({ elementType: 'skills' }), 'a'.repeat(64));

    const stat = await fs.stat(path.join(tmpDir, 'skills'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('preserves .md extension if name already has it', async () => {
    const request = makeRequest({ name: 'my-agent.md' });
    const elementId = await strategy.writeElement(request, 'a'.repeat(64));

    expect(elementId).toBe('personas/my-agent.md');
  });

  it('overwrites existing content on repeated writes', async () => {
    const request1 = makeRequest({ content: 'version 1' });
    await strategy.writeElement(request1, 'a'.repeat(64));

    const request2 = makeRequest({ content: 'version 2' });
    await strategy.writeElement(request2, 'b'.repeat(64));

    const content = await fs.readFile(path.join(tmpDir, 'personas', 'test-element.md'), 'utf-8');
    expect(content).toBe('version 2');
  });

  it('no .tmp files left behind after write', async () => {
    await strategy.writeElement(makeRequest(), 'a'.repeat(64));

    const files = await fs.readdir(path.join(tmpDir, 'personas'));
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('handles different element types', async () => {
    for (const type of ['personas', 'skills', 'templates', 'agents']) {
      const request = makeRequest({ elementType: type, name: `${type}-test` });
      const elementId = await strategy.writeElement(request, 'a'.repeat(64));
      expect(elementId).toBe(`${type}/${type}-test.md`);
    }
  });
});
