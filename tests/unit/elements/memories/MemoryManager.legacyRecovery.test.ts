import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { jest } from '@jest/globals';
import { MemoryManager } from '../../../../src/elements/memories/MemoryManager.js';
import { MEMORY_CONSTANTS } from '../../../../src/elements/memories/constants.js';
import { PortfolioManager } from '../../../../src/portfolio/PortfolioManager.js';
import { FileLockManager } from '../../../../src/security/fileLockManager.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';
import { FileOperationsService } from '../../../../src/services/FileOperationsService.js';
import { SerializationService } from '../../../../src/services/SerializationService.js';
import { ValidationRegistry } from '../../../../src/services/validation/ValidationRegistry.js';
import { ValidationService } from '../../../../src/services/validation/ValidationService.js';
import { TriggerValidationService } from '../../../../src/services/validation/TriggerValidationService.js';
import { MemoryMetadataExtractor } from '../../../../src/storage/MemoryMetadataExtractor.js';
import { MetadataService } from '../../../../src/services/MetadataService.js';

function recoveryYaml(): string {
  return yaml.dump({
    metadata: { name: 'Legacy recovery', maxEntries: 1000 },
    entries: Array.from({ length: 30 }, (_, i) => ({
      id: `entry-${i}`, timestamp: '2026-01-01T00:00:00.000Z', content: `Entry ${i} ${'z'.repeat(10000)}`,
    })),
  });
}

describe('Oversized legacy memory recovery', () => {
  let root: string;
  let manager: MemoryManager;
  let target: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-legacy-recovery-'));
    const files = new FileOperationsService(new FileLockManager());
    const portfolio = new PortfolioManager(files, { baseDir: root });
    const metadata = new MetadataService();
    manager = new MemoryManager(portfolio, new FileLockManager(), files,
      new ValidationRegistry(new ValidationService(), new TriggerValidationService(), metadata),
      new SerializationService(), metadata);
    await fs.mkdir(path.join(root, 'memories'), { recursive: true });
    target = path.join(root, 'memories', 'legacy.yaml');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    manager.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('loads oversized YAML with all entries, warns, and rejects new entries/save without changing bytes', async () => {
    const raw = recoveryYaml();
    expect(raw.length).toBeGreaterThan(MEMORY_CONSTANTS.MAX_YAML_SIZE);
    expect(raw.length).toBeLessThan(MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE);
    await fs.writeFile(target, raw);
    const audit = jest.spyOn(SecurityMonitor, 'logSecurityEvent');
    const memory = await manager.load('legacy.yaml');
    expect(memory.metadata.name).toBe('Legacy recovery');
    expect(memory.getAllEntries().map(entry => entry.content)).toEqual(
      Array.from({ length: 30 }, (_, i) => `Entry ${i} ${'z'.repeat(10000)}`));
    expect(audit.mock.calls.some(([event]) => event.type === 'CONTENT_SIZE_EXCEEDED' && event.severity === 'HIGH')).toBe(true);
    const before = memory.serialize();
    await expect(memory.addEntry('Cannot append')).rejects.toThrow('read-only');
    expect(memory.serialize()).toBe(before);
    await expect(manager.save(memory, 'legacy.yaml')).rejects.toThrow('maximum serialized size');
    expect(await fs.readFile(target, 'utf8')).toBe(raw);
    expect(MemoryMetadataExtractor.extractMetadata(raw, 'legacy.yaml').name).toBe('Legacy recovery');
  });

  it('still rejects an oversized import instead of treating recovery admission as a write allowance', async () => {
    await expect(manager.importElement(recoveryYaml())).rejects.toThrow();
    expect(await fs.readdir(path.join(root, 'memories'))).toEqual([]);
  });

  it('rejects data above the bounded whole-file recovery limit without changing it', async () => {
    const raw = `metadata:\n  name: Too large\n#${'x'.repeat(MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE)}\n`;
    await fs.writeFile(target, raw);
    await expect(manager.load('legacy.yaml')).rejects.toThrow();
    expect(await fs.readFile(target, 'utf8')).toBe(raw);
  });

  it('recovers frontmatter beyond the ordinary 1Mi content parser limit, including multibyte text', async () => {
    const body = 'é'.repeat(1200000);
    const raw = `---\nname: Multibyte recovery\n---\n${body}`;
    expect(Buffer.byteLength(raw)).toBeGreaterThan(MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE);
    expect(raw.length).toBeLessThan(MEMORY_CONSTANTS.LEGACY_MAX_YAML_SIZE);
    await fs.writeFile(target, raw);
    const memory = await manager.load('legacy.yaml');
    expect(memory.getAllEntries()[0].content).toBe(body);
    await expect(memory.addEntry('No append')).rejects.toThrow('read-only');
    expect(await fs.readFile(target, 'utf8')).toBe(raw);
  });

  it('preserves a legacy markdown body larger than the normal per-entry add limit', async () => {
    const body = 'Legacy body '.repeat(25000);
    const raw = `---\nname: Legacy body\nmaxEntries: 1\nentries:\n  - id: prior\n    timestamp: 2026-01-01T00:00:00.000Z\n    content: Prior entry\n---\n${body}`;
    await fs.writeFile(target, raw);
    const memory = await manager.load('legacy.yaml');
    const entries = memory.getAllEntries();
    expect(entries).toHaveLength(2);
    expect(entries.find(entry => entry.id === 'prior')?.content).toBe('Prior entry');
    expect(entries.find(entry => entry.source === 'file')?.content).toBe(body.trim());
    await expect(memory.addEntry('No new body')).rejects.toThrow('read-only');
    expect(await fs.readFile(target, 'utf8')).toBe(raw);
  });

  it('preserves explicit onFull policy from both YAML metadata spellings', async () => {
    for (const field of ['onFull', 'on_full']) {
      manager.clearCache();
      await fs.writeFile(target, `metadata:\n  name: Cache\n  maxEntries: 1\n  ${field}: evict_oldest\nentries:\n  - id: old\n    timestamp: 2026-01-01T00:00:00.000Z\n    content: Old\n`);
      const memory = await manager.load('legacy.yaml');
      expect(memory.getOnFullPolicy()).toBe('evict_oldest');
      const entry = await memory.addEntry('New');
      expect(memory.getAllEntries().map(item => item.id)).toEqual([entry.id]);
    }
  });
});
