#!/usr/bin/env node
/**
 * Cleanup utility for historical duplicate memory files.
 *
 * Issue #702: After Issue #699 fixed ongoing duplication, this utility
 * deduplicates already duplicated memory files across date folders.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateContentHash } from '../elements/memories/utils.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

const DATE_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const YAML_FILE_PATTERN = /\.ya?ml$/i;
const VOLATILE_METADATA_KEYS = new Set([
  'unique_id',
  'uniqueid',
  'author',
  'updated',
  'updatedat',
  'updated_at',
  'modified',
  'modifiedat',
  'modified_at',
  'lastmodified',
  'last_modified',
  'savedat',
  'saved_at',
  'id'
]);

interface MemoryCandidate {
  absolutePath: string;
  relativePath: string;
  identityKey: string;
  normalizedHash: string;
  memoryName: string;
  memoryType: string;
  entryCount: number;
  latestEntryTs: number;
  mtimeMs: number;
  sizeBytes: number;
}

interface CandidateScanResult {
  candidates: MemoryCandidate[];
  errors: string[];
}

export interface DuplicateGroup {
  key: string;
  memoryName: string;
  memoryType: string;
  keep: string;
  remove: string[];
}

export interface MemoryDuplicateCleanupReport {
  mode: 'dry-run' | 'apply';
  memoriesDir: string;
  backupDir?: string;
  scannedFiles: number;
  duplicateGroups: number;
  filesToMove: number;
  filesMoved: number;
  bytesReclaimedEstimate: number;
  indexInvalidated: boolean;
  groups: DuplicateGroup[];
  errors: string[];
}

export interface CleanupDuplicateMemoriesOptions {
  apply?: boolean;
  backupDir?: string;
  jsonReportPath?: string;
  now?: Date;
}

function isBackupFile(filename: string): boolean {
  return filename.toLowerCase().includes('backup');
}

function normalizePathInput(input: string): string {
  const normalized = UnicodeValidator.normalize(input);
  if (!normalized.isValid) {
    throw new Error(`Invalid path input: ${normalized.detectedIssues?.join(', ')}`);
  }
  return normalized.normalizedContent;
}

function stableSerialize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }

  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort((a, b) => a.localeCompare(b));
  const serializedPairs = keys.map(key => `${JSON.stringify(key)}:${stableSerialize(objectValue[key])}`);
  return `{${serializedPairs.join(',')}}`;
}

function normalizeForHash(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map(item => normalizeForHash(item));
  }

  const inputObj = value as Record<string, unknown>;
  const outputObj: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(inputObj)) {
    const normalizedKey = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (VOLATILE_METADATA_KEYS.has(normalizedKey)) {
      continue;
    }
    outputObj[key] = normalizeForHash(child);
  }
  return outputObj;
}

function getLatestEntryTimestamp(data: Record<string, unknown>): number {
  const entries = Array.isArray(data.entries) ? data.entries : [];
  let latest = 0;

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const typedEntry = entry as Record<string, unknown>;
    const candidates = [
      typedEntry.timestamp,
      typedEntry.created,
      typedEntry.createdAt,
      typedEntry.updatedAt
    ];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const parsed = Date.parse(candidate);
      if (!Number.isNaN(parsed) && parsed > latest) {
        latest = parsed;
      }
    }
  }

  return latest;
}

function parseMemoryData(rawContent: string): Record<string, unknown> {
  const wrapped = `---\n${rawContent}\n---\n`;
  const parsed = SecureYamlParser.parse(wrapped, {
    validateContent: false,
    validateFields: false
  });
  return parsed.data ?? {};
}

async function findMemoryCandidates(memoriesDir: string): Promise<CandidateScanResult> {
  const rootEntries = await fs.readdir(memoriesDir, { withFileTypes: true });
  const candidates: MemoryCandidate[] = [];
  const errors: string[] = [];

  for (const entry of rootEntries) {
    if (!entry.isDirectory() || !DATE_FOLDER_PATTERN.test(entry.name)) {
      continue;
    }

    const folderPath = path.join(memoriesDir, entry.name);
    const files = await fs.readdir(folderPath, { withFileTypes: true });
    for (const file of files) {
      if (!file.isFile()) continue;
      if (!YAML_FILE_PATTERN.test(file.name)) continue;
      if (isBackupFile(file.name)) continue;

      const absolutePath = path.join(folderPath, file.name);
      // Normalize to forward slashes for consistent cross-platform error messages and comparisons
      const relativePath = path.join(entry.name, file.name).split(path.sep).join('/');
      const rawContent = await fs.readFile(absolutePath, 'utf-8');
      const stats = await fs.stat(absolutePath);

      let data: Record<string, unknown>;
      try {
        data = parseMemoryData(rawContent);
      } catch (error) {
        errors.push(
          `Failed to parse ${relativePath}: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }

      const metadata = (data.metadata && typeof data.metadata === 'object')
        ? data.metadata as Record<string, unknown>
        : {};
      const nameFromMeta = typeof metadata.name === 'string' ? metadata.name : undefined;
      const memoryName = nameFromMeta || path.basename(file.name, path.extname(file.name));
      const memoryType = typeof metadata.memoryType === 'string' ? metadata.memoryType : 'user';
      const identityKey = `${memoryType.toLowerCase()}::${memoryName.trim().toLowerCase()}`;
      const normalizedHash = generateContentHash(stableSerialize(normalizeForHash(data)));
      const entries = Array.isArray(data.entries) ? data.entries : [];

      candidates.push({
        absolutePath,
        relativePath,
        identityKey,
        normalizedHash,
        memoryName,
        memoryType,
        entryCount: entries.length,
        latestEntryTs: getLatestEntryTimestamp(data),
        mtimeMs: stats.mtimeMs,
        sizeBytes: stats.size
      });
    }
  }

  return {
    candidates,
    errors
  };
}

function selectCanonicalAndRedundant(group: MemoryCandidate[]): {
  keep: MemoryCandidate;
  remove: MemoryCandidate[];
} {
  const sorted = [...group].sort((a, b) => {
    if (a.entryCount !== b.entryCount) return b.entryCount - a.entryCount;
    if (a.latestEntryTs !== b.latestEntryTs) return b.latestEntryTs - a.latestEntryTs;
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return b.relativePath.localeCompare(a.relativePath);
  });
  return {
    keep: sorted[0],
    remove: sorted.slice(1)
  };
}

function createRunId(now: Date): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

async function writeJsonReport(reportPath: string, report: MemoryDuplicateCleanupReport): Promise<void> {
  const reportDir = path.dirname(reportPath);
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');
}

async function invalidateMemoryIndex(memoriesDir: string): Promise<boolean> {
  const indexPath = path.join(memoriesDir, '_index.json');
  try {
    await fs.unlink(indexPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function cleanupDuplicateMemories(
  memoriesDirInput: string,
  options: CleanupDuplicateMemoriesOptions = {}
): Promise<MemoryDuplicateCleanupReport> {
  const memoriesDir = normalizePathInput(memoriesDirInput);
  const apply = options.apply ?? false;
  let errors: string[] = [];

  let candidates: MemoryCandidate[] = [];
  try {
    const scan = await findMemoryCandidates(memoriesDir);
    candidates = scan.candidates;
    errors = [...errors, ...scan.errors];
  } catch (error) {
    throw new Error(`Failed scanning memory files: ${error instanceof Error ? error.message : String(error)}`);
  }

  const grouped = new Map<string, MemoryCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.identityKey}::${candidate.normalizedHash}`;
    const list = grouped.get(key);
    if (list) {
      list.push(candidate);
    } else {
      grouped.set(key, [candidate]);
    }
  }

  const groups: DuplicateGroup[] = [];
  const movePlan: MemoryCandidate[] = [];
  let bytesReclaimedEstimate = 0;

  for (const [key, items] of grouped.entries()) {
    if (items.length < 2) continue;

    const { keep, remove } = selectCanonicalAndRedundant(items);
    if (remove.length === 0) continue;

    groups.push({
      key,
      memoryName: keep.memoryName,
      memoryType: keep.memoryType,
      keep: keep.relativePath,
      remove: remove.map(item => item.relativePath)
    });

    for (const removable of remove) {
      movePlan.push(removable);
      bytesReclaimedEstimate += removable.sizeBytes;
    }
  }

  const now = options.now ?? new Date();
  const runId = createRunId(now);
  const defaultBackupDir = path.join(memoriesDir, 'backups', 'dedup', runId);
  const backupDir = options.backupDir ? normalizePathInput(options.backupDir) : defaultBackupDir;

  let filesMoved = 0;
  let indexInvalidated = false;

  if (apply && movePlan.length > 0) {
    for (const item of movePlan) {
      try {
        const destinationPath = path.join(backupDir, item.relativePath);
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        await fs.rename(item.absolutePath, destinationPath);
        filesMoved += 1;
      } catch (error) {
        errors.push(
          `Failed to move ${item.relativePath}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    try {
      indexInvalidated = await invalidateMemoryIndex(memoriesDir);
    } catch (error) {
      errors.push(`Failed to invalidate _index.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const report: MemoryDuplicateCleanupReport = {
    mode: apply ? 'apply' : 'dry-run',
    memoriesDir,
    backupDir: apply ? backupDir : undefined,
    scannedFiles: candidates.length,
    duplicateGroups: groups.length,
    filesToMove: movePlan.length,
    filesMoved,
    bytesReclaimedEstimate,
    indexInvalidated,
    groups,
    errors
  };

  if (options.jsonReportPath) {
    await writeJsonReport(normalizePathInput(options.jsonReportPath), report);
  }

  return report;
}

function parseCliArgs(argv: string[]): {
  memoriesDir: string;
  options: CleanupDuplicateMemoriesOptions;
} {
  const args = [...argv];

  let memoriesDir = path.join(os.homedir(), '.dollhouse/portfolio/memories');
  const options: CleanupDuplicateMemoriesOptions = { apply: false };

  if (args.length > 0 && !args[0].startsWith('--')) {
    memoriesDir = args.shift() as string;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;

    if (arg === '--apply') {
      options.apply = true;
      continue;
    }

    if (arg === '--dry-run') {
      options.apply = false;
      continue;
    }

    if (arg === '--backup-dir') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('Missing value for --backup-dir');
      }
      options.backupDir = next;
      i += 1;
      continue;
    }

    if (arg === '--json-report') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('Missing value for --json-report');
      }
      options.jsonReportPath = next;
      i += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      console.log('Usage: cleanup-duplicate-memories [memoriesDir] [--dry-run] [--apply] [--backup-dir <path>] [--json-report <path>]');
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    memoriesDir,
    options
  };
}

function printReport(report: MemoryDuplicateCleanupReport): void {
  console.log('');
  console.log('Memory duplicate cleanup report');
  console.log(`Mode: ${report.mode}`);
  console.log(`Memories directory: ${report.memoriesDir}`);
  if (report.backupDir) {
    console.log(`Backup directory: ${report.backupDir}`);
  }
  console.log(`Scanned files: ${report.scannedFiles}`);
  console.log(`Duplicate groups: ${report.duplicateGroups}`);
  console.log(`Files to move: ${report.filesToMove}`);
  console.log(`Files moved: ${report.filesMoved}`);
  console.log(`Estimated bytes reclaimed: ${report.bytesReclaimedEstimate}`);
  console.log(`Index invalidated: ${report.indexInvalidated ? 'yes' : 'no'}`);

  if (report.groups.length > 0) {
    console.log('');
    console.log('Duplicate groups:');
    for (const group of report.groups) {
      console.log(`- ${group.memoryName} (${group.memoryType})`);
      console.log(`  keep: ${group.keep}`);
      for (const removePath of group.remove) {
        console.log(`  remove: ${removePath}`);
      }
    }
  }

  if (report.errors.length > 0) {
    console.log('');
    console.log('Errors:');
    for (const error of report.errors) {
      console.log(`- ${error}`);
    }
  }
  console.log('');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { memoriesDir, options } = parseCliArgs(process.argv.slice(2));
    const report = await cleanupDuplicateMemories(memoriesDir, options);
    printReport(report);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
