import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanupDuplicateMemories } from '../../../src/utils/cleanup-duplicate-memories.js';

function buildMemoryYaml(params: {
  name: string;
  author: string;
  uniqueId: string;
  entries: Array<{ id: string; content: string; timestamp: string }>;
}): string {
  const { name, author, uniqueId, entries } = params;
  const entryYaml = entries
    .map(entry => [
      '  -',
      `    id: ${entry.id}`,
      `    content: ${JSON.stringify(entry.content)}`,
      `    timestamp: ${entry.timestamp}`
    ].join('\n'))
    .join('\n');

  return [
    'metadata:',
    `  name: ${JSON.stringify(name)}`,
    '  memoryType: user',
    `  author: ${JSON.stringify(author)}`,
    `  unique_id: ${JSON.stringify(uniqueId)}`,
    'entries:',
    entryYaml
  ].join('\n');
}

describe('cleanupDuplicateMemories', () => {
  let testDir: string;
  let memoriesDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-duplicate-memories-'));
    memoriesDir = path.join(testDir, 'memories');
    await fs.mkdir(memoriesDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function writeMemory(relativePath: string, content: string): Promise<void> {
    const absolutePath = path.join(memoriesDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, 'utf-8');
  }

  it('reports duplicates in dry-run mode without changing files', async () => {
    await writeMemory('2026-03-06/project-context.yaml', buildMemoryYaml({
      name: 'Project Context',
      author: 'alpha',
      uniqueId: 'id-old',
      entries: [{ id: 'e1', content: 'same content', timestamp: '2026-03-06T10:00:00.000Z' }]
    }));
    await writeMemory('2026-03-07/project-context.yaml', buildMemoryYaml({
      name: 'Project Context',
      author: 'beta',
      uniqueId: 'id-new',
      entries: [{ id: 'e1', content: 'same content', timestamp: '2026-03-06T10:00:00.000Z' }]
    }));
    await writeMemory('2026-03-07/another-memory.yaml', buildMemoryYaml({
      name: 'Another Memory',
      author: 'alpha',
      uniqueId: 'id-x',
      entries: [{ id: 'x1', content: 'different content', timestamp: '2026-03-07T10:00:00.000Z' }]
    }));

    const report = await cleanupDuplicateMemories(memoriesDir, { apply: false });

    expect(report.mode).toBe('dry-run');
    expect(report.scannedFiles).toBe(3);
    expect(report.duplicateGroups).toBe(1);
    expect(report.filesToMove).toBe(1);
    expect(report.filesMoved).toBe(0);
    expect(report.indexInvalidated).toBe(false);
    expect(report.groups[0]?.memoryName).toBe('Project Context');

    await expect(fs.access(path.join(memoriesDir, '2026-03-06/project-context.yaml'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(memoriesDir, '2026-03-07/project-context.yaml'))).resolves.toBeUndefined();
  });

  it('moves redundant files to backup in apply mode and invalidates _index.json', async () => {
    await writeMemory('2026-03-06/project-context.yaml', buildMemoryYaml({
      name: 'Project Context',
      author: 'alpha',
      uniqueId: 'id-old',
      entries: [{ id: 'e1', content: 'same content', timestamp: '2026-03-06T10:00:00.000Z' }]
    }));
    await writeMemory('2026-03-07/project-context.yaml', buildMemoryYaml({
      name: 'Project Context',
      author: 'beta',
      uniqueId: 'id-new',
      entries: [{ id: 'e1', content: 'same content', timestamp: '2026-03-06T10:00:00.000Z' }]
    }));
    await writeMemory('_index.json', JSON.stringify({ stale: true }));

    const backupDir = path.join(testDir, 'backup-quarantine');
    const reportPath = path.join(testDir, 'cleanup-report.json');

    const report = await cleanupDuplicateMemories(memoriesDir, {
      apply: true,
      backupDir,
      jsonReportPath: reportPath
    });

    expect(report.mode).toBe('apply');
    expect(report.duplicateGroups).toBe(1);
    expect(report.filesToMove).toBe(1);
    expect(report.filesMoved).toBe(1);
    expect(report.indexInvalidated).toBe(true);

    const removedPath = report.groups[0]?.remove[0];
    const keptPath = report.groups[0]?.keep;
    expect(removedPath).toBeDefined();
    expect(keptPath).toBeDefined();

    await expect(fs.access(path.join(memoriesDir, keptPath as string))).resolves.toBeUndefined();
    await expect(fs.access(path.join(memoriesDir, removedPath as string))).rejects.toThrow();
    await expect(fs.access(path.join(backupDir, removedPath as string))).resolves.toBeUndefined();
    await expect(fs.access(path.join(memoriesDir, '_index.json'))).rejects.toThrow();
    await expect(fs.access(reportPath)).resolves.toBeUndefined();
  });

  it('is idempotent when run multiple times in apply mode', async () => {
    await writeMemory('2026-03-06/project-context.yaml', buildMemoryYaml({
      name: 'Project Context',
      author: 'alpha',
      uniqueId: 'id-old',
      entries: [{ id: 'e1', content: 'same content', timestamp: '2026-03-06T10:00:00.000Z' }]
    }));
    await writeMemory('2026-03-07/project-context.yaml', buildMemoryYaml({
      name: 'Project Context',
      author: 'beta',
      uniqueId: 'id-new',
      entries: [{ id: 'e1', content: 'same content', timestamp: '2026-03-06T10:00:00.000Z' }]
    }));

    const backupDir = path.join(testDir, 'backup-quarantine');

    const first = await cleanupDuplicateMemories(memoriesDir, {
      apply: true,
      backupDir
    });
    expect(first.filesMoved).toBe(1);

    const second = await cleanupDuplicateMemories(memoriesDir, {
      apply: true,
      backupDir
    });
    expect(second.filesMoved).toBe(0);
    expect(second.duplicateGroups).toBe(0);
    expect(second.filesToMove).toBe(0);
  });

  it('skips unparseable files and continues cleanup planning', async () => {
    await writeMemory('2026-03-06/project-context.yaml', buildMemoryYaml({
      name: 'Project Context',
      author: 'alpha',
      uniqueId: 'id-old',
      entries: [{ id: 'e1', content: 'same content', timestamp: '2026-03-06T10:00:00.000Z' }]
    }));
    await writeMemory('2026-03-07/project-context.yaml', buildMemoryYaml({
      name: 'Project Context',
      author: 'beta',
      uniqueId: 'id-new',
      entries: [{ id: 'e1', content: 'same content', timestamp: '2026-03-06T10:00:00.000Z' }]
    }));
    await writeMemory('2026-03-07/bad.yaml', 'metadata: [\n');

    const report = await cleanupDuplicateMemories(memoriesDir, { apply: false });

    expect(report.duplicateGroups).toBe(1);
    expect(report.errors.length).toBe(1);
    expect(report.errors[0]).toContain('Failed to parse 2026-03-07/bad.yaml');
  });
});
