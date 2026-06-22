/**
 * Tests for PublicElementDiscovery — file-mode shared element listing.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { PublicElementDiscovery } from '../../../../src/collection/shared-pool/PublicElementDiscovery.js';

describe('PublicElementDiscovery', () => {
  let tmpDir: string;
  let discovery: PublicElementDiscovery;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'public-discovery-test-'));
    discovery = new PublicElementDiscovery(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeSharedElement(type: string, name: string): Promise<void> {
    const dir = path.join(tmpDir, type);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${name}.md`),
      `---\nname: ${name}\n---\nShared content`,
      'utf-8',
    );
  }

  it('returns shared element paths for a type', async () => {
    await writeSharedElement('personas', 'code-reviewer');
    await writeSharedElement('personas', 'tech-writer');

    const result = await discovery.discoverPublicElements('personas', new Set());

    expect(result).toHaveLength(2);
    expect(result.some(p => p.endsWith('code-reviewer.md'))).toBe(true);
    expect(result.some(p => p.endsWith('tech-writer.md'))).toBe(true);
  });

  it('returns absolute paths', async () => {
    await writeSharedElement('skills', 'git-helper');

    const result = await discovery.discoverPublicElements('skills', new Set());

    expect(result).toHaveLength(1);
    expect(path.isAbsolute(result[0])).toBe(true);
  });

  it('excludes files the user already has (dedup by filename)', async () => {
    await writeSharedElement('personas', 'shared-only');
    await writeSharedElement('personas', 'user-has-this');

    const userFiles = new Set(['user-has-this.md']);
    const result = await discovery.discoverPublicElements('personas', userFiles);

    expect(result).toHaveLength(1);
    expect(result[0]).toContain('shared-only.md');
  });

  it('returns empty array when shared type directory does not exist', async () => {
    const result = await discovery.discoverPublicElements('nonexistent', new Set());
    expect(result).toEqual([]);
  });

  it('returns empty array when shared pool directory does not exist', async () => {
    const noSuchDir = new PublicElementDiscovery(
      path.join(os.tmpdir(), 'nonexistent-shared-pool-test'),
    );
    const result = await noSuchDir.discoverPublicElements('personas', new Set());
    expect(result).toEqual([]);
  });

  it('ignores non-element files', async () => {
    const dir = path.join(tmpDir, 'personas');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'readme.txt'), 'not an element');
    await fs.writeFile(path.join(dir, 'data.json'), '{}');
    await fs.writeFile(path.join(dir, 'real.md'), '---\nname: real\n---\nContent');

    const result = await discovery.discoverPublicElements('personas', new Set());

    expect(result).toHaveLength(1);
    expect(result[0]).toContain('real.md');
  });

  it('accepts .yaml and .yml extensions', async () => {
    const dir = path.join(tmpDir, 'memories');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'base.yaml'), 'entries: []');
    await fs.writeFile(path.join(dir, 'extra.yml'), 'entries: []');

    const result = await discovery.discoverPublicElements('memories', new Set());
    expect(result).toHaveLength(2);
  });

  it('handles multiple types independently', async () => {
    await writeSharedElement('personas', 'shared-persona');
    await writeSharedElement('skills', 'shared-skill');

    const personas = await discovery.discoverPublicElements('personas', new Set());
    const skills = await discovery.discoverPublicElements('skills', new Set());

    expect(personas).toHaveLength(1);
    expect(skills).toHaveLength(1);
  });

  it('returns empty when all shared elements are also in user portfolio', async () => {
    await writeSharedElement('personas', 'common-one');
    await writeSharedElement('personas', 'common-two');

    const userFiles = new Set(['common-one.md', 'common-two.md']);
    const result = await discovery.discoverPublicElements('personas', userFiles);

    expect(result).toEqual([]);
  });
});
