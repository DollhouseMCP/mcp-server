import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import { FileLogSink } from '../../../../src/logging/sinks/FileLogSink.js';
import { PlainTextFormatter } from '../../../../src/logging/formatters/PlainTextFormatter.js';
import { JsonlFormatter } from '../../../../src/logging/formatters/JsonlFormatter.js';
import type { UnifiedLogEntry } from '../../../../src/logging/types.js';

function makeEntry(overrides: Partial<UnifiedLogEntry> = {}): UnifiedLogEntry {
  return {
    id: 'LOG-1234-0',
    timestamp: '2026-02-10T15:30:02.123Z',
    category: 'application',
    level: 'info',
    source: 'TestSource',
    message: 'Test message',
    ...overrides,
  };
}

describe('FileLogSink', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'filelogsink-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createSink(overrides: Partial<{
    logDir: string;
    maxFileSize: number;
    retentionDays: number;
    securityRetentionDays: number;
    formatter: PlainTextFormatter | JsonlFormatter;
    maxDirSizeBytes: number;
    maxFilesPerCategory: number;
  }> = {}): FileLogSink {
    return new FileLogSink({
      logDir: overrides.logDir ?? tmpDir,
      formatter: overrides.formatter ?? new PlainTextFormatter(),
      maxFileSize: overrides.maxFileSize ?? 100 * 1024 * 1024,
      retentionDays: overrides.retentionDays ?? 30,
      securityRetentionDays: overrides.securityRetentionDays ?? 90,
      maxDirSizeBytes: overrides.maxDirSizeBytes ?? 0,
      maxFilesPerCategory: overrides.maxFilesPerCategory ?? 0,
    });
  }

  test('first flush creates log directory with correct permissions', async () => {
    const logDir = path.join(tmpDir, 'nested', 'logs');
    const sink = createSink({ logDir });
    sink.write(makeEntry());
    await sink.flush();

    const stat = await fs.stat(logDir);
    expect(stat.isDirectory()).toBe(true);
    // Unix: check owner-only permissions (0o700). Windows: NTFS ignores chmod, skip.
    if (process.platform !== 'win32') {
      const mode = stat.mode & 0o777;
      expect(mode).toBe(0o700);
    }
    await sink.close();
  });

  test('correct file naming pattern: {category}-{date}{extension}', async () => {
    const sink = createSink();
    sink.write(makeEntry({ category: 'application' }));
    await sink.flush();

    const files = await fs.readdir(tmpDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^application-\d{4}-\d{2}-\d{2}\.log$/);
    await sink.close();
  });

  test('entries appear in correct file after flush', async () => {
    const sink = createSink();
    sink.write(makeEntry({ message: 'hello disk' }));
    await sink.flush();

    const files = await fs.readdir(tmpDir);
    const content = await fs.readFile(path.join(tmpDir, files[0]), 'utf-8');
    expect(content).toContain('hello disk');
    await sink.close();
  });

  test('different categories write to different files', async () => {
    const sink = createSink();
    sink.write(makeEntry({ category: 'application' }));
    sink.write(makeEntry({ category: 'security' }));
    await sink.flush();

    const files = (await fs.readdir(tmpDir)).sort();
    expect(files.length).toBe(2);
    expect(files[0]).toMatch(/^application-/);
    expect(files[1]).toMatch(/^security-/);
    await sink.close();
  });

  test('JSONL formatter produces .jsonl extension files', async () => {
    const sink = createSink({ formatter: new JsonlFormatter() });
    sink.write(makeEntry());
    await sink.flush();

    const files = await fs.readdir(tmpDir);
    expect(files[0]).toMatch(/\.jsonl$/);
    await sink.close();
  });

  test('size rotation creates new file with sequence suffix', async () => {
    // Use a tiny max so the first flush fills the file
    const sink = createSink({ maxFileSize: 50 });

    // Write and flush first entry to create initial file
    sink.write(makeEntry({ message: 'first entry with enough content' }));
    await sink.flush();

    // Write and flush second entry — should trigger rotation since file > 50 bytes
    sink.write(makeEntry({ message: 'second entry for rotated file' }));
    await sink.flush();

    const files = (await fs.readdir(tmpDir)).sort();
    expect(files.length).toBe(2);
    // One base file and one with .1 suffix
    expect(files.some(f => f.includes('.1.'))).toBe(true);
    await sink.close();
  });

  test('retention cleanup deletes files older than retention period', async () => {
    // Create fake old log files
    const oldDate = '2025-01-01';
    const recentDate = new Date().toISOString().slice(0, 10);

    await fs.writeFile(path.join(tmpDir, `application-${oldDate}.log`), 'old');
    await fs.writeFile(path.join(tmpDir, `application-${recentDate}.log`), 'recent');

    const sink = createSink({ retentionDays: 30 });
    await sink.cleanupExpiredFiles();

    const files = await fs.readdir(tmpDir);
    expect(files).not.toContain(`application-${oldDate}.log`);
    expect(files).toContain(`application-${recentDate}.log`);
    await sink.close();
  });

  test('security files use longer retention period', async () => {
    const oldDate = '2025-10-01'; // ~4 months old
    const recentDate = new Date().toISOString().slice(0, 10);

    await fs.writeFile(path.join(tmpDir, `security-${oldDate}.log`), 'old security');
    await fs.writeFile(path.join(tmpDir, `application-${oldDate}.log`), 'old app');
    await fs.writeFile(path.join(tmpDir, `security-${recentDate}.log`), 'recent');

    const sink = createSink({ retentionDays: 30, securityRetentionDays: 365 });
    await sink.cleanupExpiredFiles();

    const files = await fs.readdir(tmpDir);
    // Security file should survive (< 365 days old), app file should be deleted (> 30 days)
    expect(files).toContain(`security-${oldDate}.log`);
    expect(files).not.toContain(`application-${oldDate}.log`);
    await sink.close();
  });

  test('files created with 0o600 permissions', async () => {
    if (process.platform === 'win32') {
      // NTFS does not support Unix file permissions; skip on Windows
      return;
    }
    const sink = createSink();
    sink.write(makeEntry());
    await sink.flush();

    const files = await fs.readdir(tmpDir);
    const stat = await fs.stat(path.join(tmpDir, files[0]));
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
    await sink.close();
  });

  test('empty flush is a no-op', async () => {
    const sink = createSink();
    await sink.flush();
    // Directory should not even be created
    const logDir = path.join(tmpDir, 'nonexistent');
    const sink2 = createSink({ logDir });
    await sink2.flush();
    await expect(fs.stat(logDir)).rejects.toThrow();
    await sink.close();
    await sink2.close();
  });

  test('close flushes remaining buffer and stops cleanup timer', async () => {
    const sink = createSink();
    sink.startCleanupTimer();
    sink.write(makeEntry({ message: 'final entry' }));
    await sink.close();

    const files = await fs.readdir(tmpDir);
    expect(files.length).toBe(1);
    const content = await fs.readFile(path.join(tmpDir, files[0]), 'utf-8');
    expect(content).toContain('final entry');
  });

  test('tilde in logDir is expanded to os.homedir()', async () => {
    const homedir = os.homedir();
    const subdir = `.dollhouse-test-${Date.now()}`;
    const tildeDir = `~/${subdir}`;

    const sink = createSink({ logDir: tildeDir });
    sink.write(makeEntry());
    await sink.flush();

    const expandedDir = path.join(homedir, subdir);
    const files = await fs.readdir(expandedDir);
    expect(files.length).toBe(1);

    // Cleanup
    await sink.close();
    await fs.rm(expandedDir, { recursive: true, force: true });
  });

  test('multiple entries buffered and flushed together', async () => {
    const sink = createSink();
    sink.write(makeEntry({ message: 'one' }));
    sink.write(makeEntry({ message: 'two' }));
    sink.write(makeEntry({ message: 'three' }));
    await sink.flush();

    const files = await fs.readdir(tmpDir);
    const content = await fs.readFile(path.join(tmpDir, files[0]), 'utf-8');
    expect(content).toContain('one');
    expect(content).toContain('two');
    expect(content).toContain('three');
    await sink.close();
  });

  test('cleanup ignores non-log files', async () => {
    await fs.writeFile(path.join(tmpDir, 'random.txt'), 'not a log');
    await fs.writeFile(path.join(tmpDir, 'application-2025-01-01.log'), 'old');

    const sink = createSink({ retentionDays: 30 });
    await sink.cleanupExpiredFiles();

    const files = await fs.readdir(tmpDir);
    expect(files).toContain('random.txt');
    expect(files).not.toContain('application-2025-01-01.log');
    await sink.close();
  });

  // ---------------------------------------------------------------------------
  // New tests for issue #709: log directory unbounded growth fixes
  // ---------------------------------------------------------------------------

  test('restart sequence recovery: new content goes to next sequence, not into old files', async () => {
    const today = new Date().toISOString().slice(0, 10);
    // Pre-create rotated files as if the server had been running
    await fs.writeFile(path.join(tmpDir, `application-${today}.log`), 'original');
    await fs.writeFile(path.join(tmpDir, `application-${today}.1.log`), 'rotated-1');
    await fs.writeFile(path.join(tmpDir, `application-${today}.2.log`), 'rotated-2');

    // Construct a fresh sink (simulates a restart) with a tiny maxFileSize so
    // it will rotate immediately on the first write
    const sink = createSink({ maxFileSize: 1 });
    sink.write(makeEntry({ message: 'post-restart entry' }));
    await sink.flush();

    // The new content should go to .3, NOT mix into .1 or .2
    const files = await fs.readdir(tmpDir);
    expect(files).toContain(`application-${today}.3.log`);
    const content1 = await fs.readFile(path.join(tmpDir, `application-${today}.1.log`), 'utf-8');
    const content2 = await fs.readFile(path.join(tmpDir, `application-${today}.2.log`), 'utf-8');
    expect(content1).not.toContain('post-restart entry');
    expect(content2).not.toContain('post-restart entry');

    await sink.close();
  });

  test('per-category file count cap deletes oldest files', async () => {
    // Create 6 files with distinct old dates + ensure some are older
    for (const d of ['2025-01-01', '2025-02-01', '2025-03-01', '2025-04-01', '2025-05-01', '2025-06-01']) {
      await fs.writeFile(path.join(tmpDir, `application-${d}.log`), `content-${d}`);
    }

    const sink = createSink({ maxFilesPerCategory: 3, retentionDays: 9999 });
    await sink.cleanupExpiredFiles();

    const files = await fs.readdir(tmpDir);
    const appFiles = files.filter(f => f.startsWith('application-'));
    expect(appFiles.length).toBe(3);
    // Most recent 3 should survive
    expect(appFiles).toContain('application-2025-04-01.log');
    expect(appFiles).toContain('application-2025-05-01.log');
    expect(appFiles).toContain('application-2025-06-01.log');

    await sink.close();
  });

  test('count cap handles rotated sequence files: seq ordering respected', async () => {
    // Rotated files for 2026-01-01, plus single files for 2026-01-02 and 2026-01-03
    await fs.writeFile(path.join(tmpDir, 'application-2026-01-01.log'), 'base');
    await fs.writeFile(path.join(tmpDir, 'application-2026-01-01.1.log'), 'rot1');
    await fs.writeFile(path.join(tmpDir, 'application-2026-01-01.2.log'), 'rot2');
    await fs.writeFile(path.join(tmpDir, 'application-2026-01-02.log'), 'day2');
    await fs.writeFile(path.join(tmpDir, 'application-2026-01-03.log'), 'day3');

    const sink = createSink({ maxFilesPerCategory: 3, retentionDays: 9999 });
    await sink.cleanupExpiredFiles();

    const files = await fs.readdir(tmpDir);
    const appFiles = files.filter(f => f.startsWith('application-'));
    expect(appFiles.length).toBe(3);
    // The two oldest (base + .1 from 2026-01-01) should be deleted
    expect(appFiles).not.toContain('application-2026-01-01.log');
    expect(appFiles).not.toContain('application-2026-01-01.1.log');
    expect(appFiles).toContain('application-2026-01-01.2.log');
    expect(appFiles).toContain('application-2026-01-02.log');
    expect(appFiles).toContain('application-2026-01-03.log');

    await sink.close();
  });

  test('dir size cap deletes oldest files by mtime until under cap', async () => {
    // Write 4 files with known sizes (~100 bytes each), stagger mtime
    const files = ['application-2026-01-01.log', 'application-2026-01-02.log',
      'application-2026-01-03.log', 'application-2026-01-04.log'];
    const content = 'x'.repeat(100);
    for (let i = 0; i < files.length; i++) {
      const filePath = path.join(tmpDir, files[i]);
      await fs.writeFile(filePath, content);
      // Adjust mtime so ordering is deterministic
      const mtime = new Date(Date.now() - (files.length - i) * 10000);
      await fs.utimes(filePath, mtime, mtime);
    }

    // Cap at 250 bytes — should force deletion of 2 oldest files
    const sink = createSink({ maxDirSizeBytes: 250, retentionDays: 9999 });
    await sink.cleanupExpiredFiles();

    const remaining = await fs.readdir(tmpDir);
    const appFiles = remaining.filter(f => f.startsWith('application-'));
    expect(appFiles.length).toBe(2);
    // The two most recent should survive
    expect(appFiles).toContain('application-2026-01-03.log');
    expect(appFiles).toContain('application-2026-01-04.log');

    await sink.close();
  });

  test('dir size cap emits stderr warning when deleting security log', async () => {
    const stderrMessages: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation((msg: unknown) => {
      stderrMessages.push(String(msg));
      return true;
    });

    try {
      const content = 'x'.repeat(200);
      const secFile = path.join(tmpDir, 'security-2026-01-01.log');
      const appFile = path.join(tmpDir, 'application-2026-01-02.log');

      await fs.writeFile(secFile, content);
      await fs.writeFile(appFile, content);

      // Make security file oldest
      const oldMtime = new Date(Date.now() - 20000);
      await fs.utimes(secFile, oldMtime, oldMtime);

      // Cap at 250 — must delete at least one file; security file is oldest
      const sink = createSink({ maxDirSizeBytes: 250, retentionDays: 9999 });
      await sink.cleanupExpiredFiles();

      const warnings = stderrMessages.filter(m => m.includes('dir-size cap') && m.includes('security'));
      expect(warnings.length).toBeGreaterThan(0);

      await sink.close();
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('count cap disabled when maxFilesPerCategory is 0', async () => {
    // Create 50 files
    for (let i = 1; i <= 50; i++) {
      const name = `application-2025-01-${String(i).padStart(2, '0')}.log`;
      await fs.writeFile(path.join(tmpDir, name), `content-${i}`);
    }

    const sink = createSink({ maxFilesPerCategory: 0, retentionDays: 9999 });
    await sink.cleanupExpiredFiles();

    const files = await fs.readdir(tmpDir);
    const appFiles = files.filter(f => f.startsWith('application-'));
    expect(appFiles.length).toBe(50);

    await sink.close();
  });
});
