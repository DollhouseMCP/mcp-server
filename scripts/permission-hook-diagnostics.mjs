#!/usr/bin/env node
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { withRecoverableFileWriteLock } from './recoverable-file-write-lock.mjs';

const MAX_BYTES = 50 * 1024 * 1024;
const TAIL_BYTES = 8192;
const LOCK_WAIT_MS = 200;
const PRIVATE_FILE = 0o600;
const PRIVATE_DIRECTORY = 0o700;
const FIELD = /^[a-z][a-z_]{0,63}$/u;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,159}$/u;

export function getPermissionDiagnosticPath(runDir) {
  return join(runDir, 'permission-hook-diagnostics', 'permission-hook-diagnostics.jsonl');
}

function privateOwner(stat, mode) {
  return typeof process.getuid === 'function' && stat.uid === process.getuid() && (stat.mode & 0o7777) === mode;
}

function verifyLog(stat) {
  if (!stat.isFile() || stat.nlink !== 1 || !privateOwner(stat, PRIVATE_FILE)) {
    throw new Error('Permission hook diagnostics require a private regular file');
  }
}

async function existingLog(path) {
  try {
    const stat = await lstat(path);
    verifyLog(stat);
    return stat;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function projectRecord(data, timestamp) {
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      ![data.platform, data.stage, data.outcome].every(value => typeof value === 'string' && FIELD.test(value))) return null;

  const compact = { timestamp, platform: data.platform, stage: data.stage, outcome: data.outcome };
  if (typeof data.toolName === 'string' && TOOL_NAME.test(data.toolName)) compact.toolName = data.toolName;
  for (const key of ['elapsedMs', 'attempt', 'timeoutSeconds', 'curlExit']) {
    if (Number.isSafeInteger(data[key]) && data[key] >= 0) compact[key] = data[key];
  }
  return compact;
}

export async function appendPermissionDiagnostic(path, diagnostic, limit = MAX_BYTES) {
  const record = projectRecord(diagnostic, new Date().toISOString());
  if (!record) return;
  const line = JSON.stringify(record) + '\n';
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY });
  const directoryState = await lstat(directory);
  if (!directoryState.isDirectory() || !privateOwner(directoryState, PRIVATE_DIRECTORY)) return;
  await withRecoverableFileWriteLock(path + '.lock', async () => {
    const current = await existingLog(path);
    if (current && current.size + Buffer.byteLength(line) > limit) {
      const first = path + '.1';
      await existingLog(path + '.2');
      if (await existingLog(first)) await rename(first, path + '.2');
      await rename(path, first);
    }
    const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT |
      constants.O_NOFOLLOW | constants.O_NONBLOCK, PRIVATE_FILE);
    try {
      verifyLog(await file.stat());
      await file.writeFile(line, 'utf8');
    } finally {
      await file.close();
    }
  }, LOCK_WAIT_MS);
}

export async function readLatestPermissionDiagnostic(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    verifyLog(stat);
    const tail = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    const { bytesRead } = await file.read(tail, 0, tail.length, stat.size - tail.length);
    const raw = tail.subarray(0, bytesRead).toString('utf8');
    const end = raw.lastIndexOf('\n');
    if (end < 0) return null;
    const start = raw.lastIndexOf('\n', end - 1);
    const value = JSON.parse(raw.slice(start + 1, end));
    if (typeof value?.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) return null;
    return projectRecord(value, new Date(value.timestamp).toISOString());
  } catch {
    return null;
  } finally {
    await file?.close();
  }
}

function isInvokedDirectly() {
  try {
    return Boolean(process.argv[1]) && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isInvokedDirectly()) {
  const [, , path, platform, stage, outcome, toolName, elapsedMs, attempt, timeoutSeconds, curlExit] = process.argv;
  appendPermissionDiagnostic(path, {
    platform, stage, outcome, toolName,
    elapsedMs: Number(elapsedMs), attempt: Number(attempt), timeoutSeconds: Number(timeoutSeconds),
    curlExit: curlExit === '' ? undefined : Number(curlExit),
  }).catch(() => { process.exitCode = 1; });
}
