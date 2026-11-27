import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

  it('rotates by size and retains the active file and two private archives', async () => {
    await appendPermissionDiagnostic(log, { ...base, toolName: 'Tool1' });
    const oneRecord = (await stat(log)).size;
    for (const toolName of ['Tool2', 'Tool3', 'Tool4']) {
      await appendPermissionDiagnostic(log, { ...base, toolName }, oneRecord + 8);
    }

    expect(await readdir(dirname(log))).toHaveLength(3);
    for (const [suffix, toolName] of [['', 'Tool4'], ['.1', 'Tool3'], ['.2', 'Tool2']]) {
      expect(JSON.parse(await readFile(log + suffix, 'utf8'))).toMatchObject({ toolName });
      expect((await stat(log + suffix)).mode & 0o777).toBe(0o600);
      expect((await stat(log + suffix)).size).toBeLessThanOrEqual(oneRecord + 8);
    }
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
