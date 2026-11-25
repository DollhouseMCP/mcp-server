const { mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

/** Reset only the harness-owned home; preserve logs and process-control files. */
function freshFixtureHome(runDirectory) {
  const home = path.join(runDirectory, 'home');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  return home;
}

async function withMigrationHome(run) {
  const home = mkdtempSync(path.join(tmpdir(), 'dollhouse-migration-home-'));
  try { return await run(home); }
  finally { rmSync(home, { recursive: true, force: true }); }
}
/** Preview defaults retain the historical run-directory layout and its state. */
function appHome(runDirectory, options = {}) {
  if (options.fresh) return freshFixtureHome(runDirectory);
  mkdirSync(runDirectory, { recursive: true });
  return runDirectory;
}
module.exports = { freshFixtureHome, withMigrationHome, appHome };
