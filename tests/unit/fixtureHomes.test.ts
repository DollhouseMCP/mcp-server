import { expect, it } from '@jest/globals';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freshFixtureHome, withMigrationHome, appHome } from '../helpers/fixtureHomes.cjs';

it('clears state from the previous app home while retaining run diagnostics', () => {
  const run = mkdtempSync(path.join(tmpdir(), 'fresh-home-proof-'));
  try {
    const home = freshFixtureHome(run);
    writeFileSync(path.join(home, 'stale-state'), 'old run');
    writeFileSync(path.join(run, 'app.log'), 'diagnostic');
    expect(freshFixtureHome(run)).toBe(home);
    expect(existsSync(path.join(home, 'stale-state'))).toBe(false);
    expect(existsSync(path.join(run, 'app.log'))).toBe(true);
  } finally { rmSync(run, { recursive: true, force: true }); }
});

it.each([false, true])('removes a temporary migration home after failure=%s', async fail => {
  let home = '';
  const migration = withMigrationHome(async directory => {
    home = directory;
    writeFileSync(path.join(home, 'migration-state'), 'fixture');
    if (fail) throw new Error('migration failed');
    return 'done';
  });
  if (fail) await expect(migration).rejects.toThrow('migration failed');
  else await expect(migration).resolves.toBe('done');
  expect(existsSync(home)).toBe(false);
});

it('retains preview state at the historical path unless freshness is explicitly requested', () => {
  const run = mkdtempSync(path.join(tmpdir(), 'preview-home-proof-'));
  try {
    const sentinel = path.join(run, 'portfolio-state');
    writeFileSync(sentinel, 'keep');
    expect(appHome(run)).toBe(run);
    expect(appHome(run, { fresh: false })).toBe(run);
    expect(existsSync(sentinel)).toBe(true);
    expect(appHome(run, { fresh: true })).toBe(path.join(run, 'home'));
    expect(existsSync(sentinel)).toBe(true);
  } finally { rmSync(run, { recursive: true, force: true }); }
});
