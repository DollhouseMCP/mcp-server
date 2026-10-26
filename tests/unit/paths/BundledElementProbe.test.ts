import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BundledElementProbe } from '../../../src/paths/BundledElementProbe.js';
import { PackageResourceLocator } from '../../../src/paths/PackageResourceLocator.js';
import { SEED_MEMORY_FILENAME } from '../../../src/elements/memories/constants.js';

const defaultName = 'translation.md';
const defaultPath = path.join(new PackageResourceLocator().getPackageRoot(), 'data', 'skills', defaultName);

function observeDefaultReads(probe: BundledElementProbe) {
  return jest.spyOn(probe as unknown as { readDefault(source: string): Promise<Buffer | undefined> }, 'readDefault');
}

describe('BundledElementProbe', () => {
  let root: string;
  let probe: BundledElementProbe;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bundled-element-probe-'));
    probe = new BundledElementProbe();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('recognizes a byte-identical top-level shipped markdown default', async () => {
    const candidate = path.join(root, defaultName);
    await fs.copyFile(defaultPath, candidate);
    expect(await probe.isBundled(candidate, 'skills', defaultName)).toBe(true);
  });

  it('treats an edited default as user content', async () => {
    const candidate = path.join(root, defaultName);
    await fs.copyFile(defaultPath, candidate);
    await fs.appendFile(candidate, '\nUser edits');
    expect(await probe.isBundled(candidate, 'skills', defaultName)).toBe(false);
  });

  it('does not read the candidate when its shipped default is missing', async () => {
    const name = `${randomUUID()}.md`;
    const candidate = path.join(root, name);
    // A read would reject; the missing default must short-circuit it.
    await expect(fs.readFile(candidate)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await probe.isBundled(candidate, 'skills', name)).toBe(false);
  });

  it.each(['translation.yaml', path.join('nested', defaultName)])(
    'rejects %s without looking up defaults', async relativePath => {
      const candidate = path.join(root, relativePath);
      await fs.mkdir(path.dirname(candidate), { recursive: true });
      await fs.copyFile(defaultPath, candidate);
      const reads = observeDefaultReads(probe);
      expect(await probe.isBundled(candidate, 'skills', relativePath)).toBe(false);
      expect(reads).not.toHaveBeenCalled();
    });

  const seedBase = path.basename(SEED_MEMORY_FILENAME, '.yaml');
  it.each([
    SEED_MEMORY_FILENAME,
    `${seedBase}.backup-2026-01-02-03-04-05-006.yaml`,
    `${seedBase}.backup-2026-01-02-03-04-05-006-v2.yaml`,
  ])('recognizes system seed %s', async name => {
    const relativePath = path.join('system', name);
    const candidate = path.join(root, relativePath);
    await fs.mkdir(path.dirname(candidate));
    await fs.writeFile(candidate, 'Generated seed bytes');
    expect(await probe.isBundled(candidate, 'memories', relativePath)).toBe(true);
  });

  it('rejects a near-miss seed backup filename', async () => {
    const name = `${seedBase}.backup-2026-01-02-03-04-05-006-vx.yaml`;
    const candidate = path.join(root, 'system', name);
    await fs.mkdir(path.dirname(candidate));
    await fs.writeFile(candidate, 'Generated seed bytes');
    expect(await probe.isBundled(candidate, 'memories', path.join('system', name))).toBe(false);
  });

  it('reads each default once per probe while checking candidate bytes each time', async () => {
    const candidate = path.join(root, defaultName);
    await fs.copyFile(defaultPath, candidate);
    const reads = observeDefaultReads(probe);
    expect(await probe.isBundled(candidate, 'skills', defaultName)).toBe(true);
    await fs.appendFile(candidate, '\nChanged after the first check');
    expect(await probe.isBundled(candidate, 'skills', defaultName)).toBe(false);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenCalledWith(defaultPath);
    const nextProbe = new BundledElementProbe();
    const nextReads = observeDefaultReads(nextProbe);
    expect(await nextProbe.isBundled(candidate, 'skills', defaultName)).toBe(false);
    expect(nextReads).toHaveBeenCalledTimes(1);
  });
});
