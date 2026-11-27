import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  appendPermissionDiagnostic,
  getPermissionDiagnosticPath,
  readLatestPermissionDiagnostic,
} from '../../../scripts/permission-hook-diagnostics.mjs';

const describePosix = process.getuid ? describe : describe.skip;

describePosix('private permission-hook diagnostics', () => {
  let home: string;
  let log: string;
  const base = { platform: 'codex', stage: 'curl_retry', outcome: 'retrying' };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'private-hook-diagnostics-'));
    log = getPermissionDiagnosticPath(join(home, 'run'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('uses mode 0600 and persists only allowlisted fields', async () => {
    const secret = 'fixture-private-tool-data';
    await appendPermissionDiagnostic(log, {
      ...base, toolName: 'Bash', elapsedMs: 1000, attempt: 1, timeoutSeconds: 5, curlExit: 28,
      rawInput: secret, toolInput: secret, payload: secret, response: secret,
    });
    const stored = await readFile(log, 'utf8');
    expect(stored).not.toContain(secret);
    expect(JSON.parse(stored)).toEqual({
      ...base, toolName: 'Bash', elapsedMs: 1000, attempt: 1, timeoutSeconds: 5, curlExit: 28,
      timestamp: expect.any(String),
    });
    expect((await stat(log)).mode & 0o777).toBe(0o600);
    expect(await readLatestPermissionDiagnostic(log)).toEqual(JSON.parse(stored));
  });

  it('rotates by size and retains every segment as a private file', async () => {
    await appendPermissionDiagnostic(log, { ...base, toolName: 'Tool1' });
    const oneRecord = (await stat(log)).size;
    for (const toolName of ['Tool2', 'Tool3', 'Tool4', 'Tool5']) {
      await appendPermissionDiagnostic(log, { ...base, toolName }, oneRecord + 8);
    }

    const segments = await readdir(dirname(log), { withFileTypes: true });
    const rotatedTools = [];
    for (const segment of segments.filter(entry => entry.isDirectory())) {
      expect(segment.name).toMatch(/^rotated-/);
      const rotation = join(dirname(log), segment.name);
      expect((await stat(rotation)).mode & 0o777).toBe(0o700);
      const stored = join(rotation, basename(log));
      rotatedTools.push(JSON.parse(await readFile(stored, 'utf8')).toolName);
      const info = await stat(stored);
      expect(info.mode & 0o777).toBe(0o600);
      expect(info.size).toBeLessThanOrEqual(oneRecord + 8);
    }
    expect(rotatedTools.sort()).toEqual(['Tool1', 'Tool2', 'Tool3', 'Tool4']);
    expect(await readLatestPermissionDiagnostic(log)).toMatchObject({ toolName: 'Tool5' });
    expect((await stat(log)).mode & 0o777).toBe(0o600);
  });

  it('leaves the historical archive and previous log untouched during rotation', async () => {
    const archiveDir = join(home, 'diagnostics-archive');
    const history = join(archiveDir, 'permission-hook-diagnostics-through-2026-11-27.jsonl');
    const previousLog = join(home, 'run', basename(log));
    await mkdir(archiveDir, { mode: 0o700 });
    await mkdir(dirname(previousLog), { mode: 0o700 });
    await writeFile(history, 'historical fixture', { mode: 0o600 });
    await writeFile(previousLog, '', { mode: 0o600 });

    await appendPermissionDiagnostic(log, { ...base, toolName: 'Tool1' });
    await appendPermissionDiagnostic(log, { ...base, toolName: 'Tool2' }, (await stat(log)).size);

    expect(await readdir(archiveDir)).toEqual([basename(history)]);
    expect(await readFile(history, 'utf8')).toBe('historical fixture');
    expect(await readFile(previousLog, 'utf8')).toBe('');
    expect((await stat(history)).mode & 0o777).toBe(0o600);
    expect((await stat(previousLog)).mode & 0o777).toBe(0o600);
  });

  it('leaves an existing nonprivate file unchanged', async () => {
    await mkdir(dirname(log), { recursive: true, mode: 0o700 });
    await writeFile(log, 'unmodified fixture');
    await chmod(log, 0o644);
    await expect(appendPermissionDiagnostic(log, base)).rejects.toThrow('private regular file');
    expect(await readFile(log, 'utf8')).toBe('unmodified fixture');
    expect((await stat(log)).mode & 0o777).toBe(0o644);
    expect(await readLatestPermissionDiagnostic(log)).toBeNull();
  });

  it('reads the latest complete record during a partial append', async () => {
    await appendPermissionDiagnostic(log, { ...base, toolName: 'Read' });
    await appendFile(log, '{"toolName":"Write"');
    expect(await readLatestPermissionDiagnostic(log)).toMatchObject({ toolName: 'Read' });
  });
});
