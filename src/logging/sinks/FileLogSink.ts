/**
 * File-based log sink: writes buffered entries to date-rotated files on disk.
 *
 * Error reporting in this file intentionally uses `process.stderr.write` rather
 * than the application logger. Using the logger would create a circular
 * dependency (logger → sink → logger) and risk infinite loops or masking the
 * original error. `process.stderr.write` is the correct pattern for any code
 * inside the logging subsystem itself.
 */

import os from 'os';
import fs from 'fs/promises';
import path from 'path';
import type { ILogSink, ILogFormatter, UnifiedLogEntry, LogCategory } from '../types.js';

export interface FileLogSinkOptions {
  logDir: string;
  formatter: ILogFormatter;
  maxFileSize: number;
  retentionDays: number;
  securityRetentionDays: number;
  maxDirSizeBytes: number;
  maxFilesPerCategory: number;
}

const CATEGORY_PATTERN = /^(application|security|performance|telemetry)-(\d{4}-\d{2}-\d{2})/;

// Captures category, date, optional sequence number, and extension
const ROTATED_FILE_PATTERN = /^(application|security|performance|telemetry)-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?(\.[^.]+)$/;

export class FileLogSink implements ILogSink {
  private readonly logDir: string;
  private readonly formatter: ILogFormatter;
  private readonly maxFileSize: number;
  private readonly retentionDays: number;
  private readonly securityRetentionDays: number;
  private readonly maxDirSizeBytes: number;
  private readonly maxFilesPerCategory: number;

  private readonly buffers = new Map<LogCategory, string[]>();
  private readonly currentDates = new Map<LogCategory, string>();
  private readonly sequenceCounters = new Map<LogCategory, number>();
  private readonly fileSizes = new Map<LogCategory, number>();
  private initialized = false;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: FileLogSinkOptions) {
    this.logDir = options.logDir.startsWith('~')
      ? path.join(os.homedir(), options.logDir.slice(1))
      : options.logDir;
    this.formatter = options.formatter;
    this.maxFileSize = options.maxFileSize;
    this.retentionDays = options.retentionDays;
    this.securityRetentionDays = options.securityRetentionDays;
    this.maxDirSizeBytes = options.maxDirSizeBytes;
    this.maxFilesPerCategory = options.maxFilesPerCategory;
  }

  write(entry: UnifiedLogEntry): void {
    const formatted = this.formatter.format(entry);
    let buffer = this.buffers.get(entry.category);
    if (!buffer) {
      buffer = [];
      this.buffers.set(entry.category, buffer);
    }
    buffer.push(formatted);
  }

  async flush(): Promise<void> {
    const categoriesToFlush: Array<[LogCategory, string]> = [];

    for (const [category, buffer] of this.buffers) {
      if (buffer.length === 0) continue;
      const content = buffer.splice(0).join('');
      categoriesToFlush.push([category, content]);
    }

    if (categoriesToFlush.length === 0) return;

    try {
      await this.ensureLogDir();

      for (const [category, content] of categoriesToFlush) {
        const filePath = await this.resolveFilePath(category, content.length);
        await fs.appendFile(filePath, content, { mode: 0o600 });

        const currentSize = this.fileSizes.get(category) ?? 0;
        this.fileSizes.set(category, currentSize + content.length);
      }
    } catch (err) {
      // Best-effort: log to stderr, don't throw
      process.stderr.write(`[FileLogSink] flush error: ${err}\n`);
    }
  }

  async close(): Promise<void> {
    await this.flush();
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  async cleanupExpiredFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.logDir);
      const now = Date.now();

      for (const file of files) {
        const match = CATEGORY_PATTERN.exec(file);
        if (!match) continue;

        const category = match[1] as string;
        const dateStr = match[2];
        const fileDate = new Date(dateStr + 'T00:00:00Z');
        if (isNaN(fileDate.getTime())) continue;

        const ageMs = now - fileDate.getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        const retentionLimit = category === 'security'
          ? this.securityRetentionDays
          : this.retentionDays;

        if (ageDays > retentionLimit) {
          try {
            await fs.unlink(path.join(this.logDir, file));
          } catch {
            // best-effort: skip files that can't be deleted
          }
        }
      }
    } catch (err) {
      process.stderr.write(`[FileLogSink] cleanup error: ${err}\n`);
    }

    await this.cleanupByFileCount();
    await this.cleanupByDirSize();
  }

  startCleanupTimer(): void {
    if (this.cleanupTimer !== null) return;

    // Run initial cleanup
    void this.cleanupExpiredFiles();

    // Schedule every 24 hours
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredFiles();
    }, 24 * 60 * 60 * 1000);

    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  private async ensureLogDir(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.logDir, { recursive: true, mode: 0o700 });
    this.initialized = true;
  }

  /**
   * Scan the log directory to find the highest existing sequence number for a
   * given category+date. Used on startup/day-transition to resume from the
   * correct file instead of always resetting to sequence 0.
   *
   * Performance: O(n) over files in the directory, but called at most once per
   * category per calendar day (on process start or UTC midnight rollover). For
   * deployments with very large log directories, keep DOLLHOUSE_LOG_MAX_FILES_PER_CATEGORY
   * set (default 100) so this scan stays fast.
   *
   * NOTE: no inter-process locking — if two instances share a log dir they may
   * both scan and pick the same max seq, then both write to the same file. Each
   * instance should use its own dedicated log directory. See the troubleshooting
   * guide ("Multiple server instances sharing a log directory") for details.
   */
  private async scanMaxSequence(category: LogCategory, today: string): Promise<number> {
    try {
      const files = await fs.readdir(this.logDir);
      let maxSeq = 0;
      for (const file of files) {
        const m = ROTATED_FILE_PATTERN.exec(file);
        if (!m || m[1] !== category || m[2] !== today) continue;
        const seq = m[3] ? parseInt(m[3], 10) : 0;
        if (seq > maxSeq) maxSeq = seq;
      }
      return maxSeq;
    } catch {
      return 0; // log dir doesn't exist yet
    }
  }

  private async resolveFilePath(category: LogCategory, contentSize: number): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    const prevDate = this.currentDates.get(category);

    if (prevDate !== today) {
      this.currentDates.set(category, today);
      // Scan for max existing sequence to handle restarts correctly
      const existingMaxSeq = await this.scanMaxSequence(category, today);
      this.sequenceCounters.set(category, existingMaxSeq);
      this.fileSizes.set(category, 0);

      // Stat the highest-sequence file (not just base) to pick up its current size
      const suffix = existingMaxSeq > 0 ? `.${existingMaxSeq}` : '';
      const targetPath = path.join(
        this.logDir,
        `${category}-${today}${suffix}${this.formatter.fileExtension}`,
      );
      try {
        const stat = await fs.stat(targetPath);
        this.fileSizes.set(category, stat.size);
      } catch {
        // File doesn't exist yet
      }
    }

    const currentSize = this.fileSizes.get(category) ?? 0;
    let seq = this.sequenceCounters.get(category) ?? 0;

    // Check if we need to rotate
    if (currentSize > 0 && currentSize + contentSize > this.maxFileSize) {
      seq++;
      this.sequenceCounters.set(category, seq);
      this.fileSizes.set(category, 0);

      // Stat the new rotated file to get its size
      const rotatedPath = path.join(
        this.logDir,
        `${category}-${today}.${seq}${this.formatter.fileExtension}`,
      );
      try {
        const stat = await fs.stat(rotatedPath);
        this.fileSizes.set(category, stat.size);
      } catch {
        // File doesn't exist yet
      }
    }

    const suffix = seq > 0 ? `.${seq}` : '';
    return path.join(
      this.logDir,
      `${category}-${today}${suffix}${this.formatter.fileExtension}`,
    );
  }

  /**
   * Delete oldest files per category when the file count exceeds
   * `maxFilesPerCategory`. Sorting is date ASC, then seq ASC within
   * the same date, so the oldest files are removed first.
   */
  private async cleanupByFileCount(): Promise<void> {
    if (this.maxFilesPerCategory === 0) return;
    try {
      const files = await fs.readdir(this.logDir);
      const byCategory = new Map<string, Array<{ file: string; date: string; seq: number }>>();
      for (const file of files) {
        const m = ROTATED_FILE_PATTERN.exec(file);
        if (!m) continue;
        const cat = m[1];
        if (!byCategory.has(cat)) byCategory.set(cat, []);
        byCategory.get(cat)!.push({ file, date: m[2], seq: m[3] ? parseInt(m[3], 10) : 0 });
      }
      for (const [, entries] of byCategory) {
        if (entries.length <= this.maxFilesPerCategory) continue;
        // Sort oldest first: date ASC, then seq ASC within same date
        entries.sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
        const toDelete = entries.slice(0, entries.length - this.maxFilesPerCategory);
        for (const entry of toDelete) {
          try {
            await fs.unlink(path.join(this.logDir, entry.file));
          } catch { /* best-effort */ }
        }
      }
    } catch (err) {
      process.stderr.write(`[FileLogSink] cleanupByFileCount error: ${err}\n`);
    }
  }

  /**
   * Delete oldest log files (by mtime) when the total directory size exceeds
   * `maxDirSizeBytes`. Emits a stderr warning when a security log is deleted
   * so operators can investigate or increase the cap.
   */
  private async cleanupByDirSize(): Promise<void> {
    if (this.maxDirSizeBytes === 0) return;
    try {
      const files = await fs.readdir(this.logDir);
      const entries: Array<{ file: string; mtime: number; size: number; isSecurity: boolean }> = [];
      for (const file of files) {
        if (!ROTATED_FILE_PATTERN.exec(file)) continue;
        try {
          const stat = await fs.stat(path.join(this.logDir, file));
          entries.push({ file, mtime: stat.mtimeMs, size: stat.size, isSecurity: file.startsWith('security-') });
        } catch { /* best-effort */ }
      }
      const totalSize = entries.reduce((sum, e) => sum + e.size, 0);
      if (totalSize <= this.maxDirSizeBytes) return;
      // Sort oldest first by mtime
      entries.sort((a, b) => a.mtime - b.mtime);
      let remaining = totalSize;
      for (const entry of entries) {
        if (remaining <= this.maxDirSizeBytes) break;
        if (entry.isSecurity) {
          process.stderr.write(
            `[FileLogSink] dir-size cap: deleting security log ${entry.file} ` +
            `(dir=${remaining} > cap=${this.maxDirSizeBytes})\n`,
          );
        }
        try {
          await fs.unlink(path.join(this.logDir, entry.file));
          remaining -= entry.size;
        } catch { /* best-effort */ }
      }
    } catch (err) {
      process.stderr.write(`[FileLogSink] cleanupByDirSize error: ${err}\n`);
    }
  }
}
