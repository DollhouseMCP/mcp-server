import test from 'node:test';
import assert from 'node:assert/strict';
import { runOfflineScanner } from '../../scripts/grype-offline-runner.mjs';

function fixture({ failedAt = -1, scanStatus = 0, dbSize = 100, reportSize = 20, missingDb = false } = {}) {
  const commands = []; const envelopes = []; const directories = [];
  const fileSystem = {
    mkdirSync(path, options) { directories.push([path, options]); },
    statSync(path) {
      if (path === '/work/db/6/vulnerability.db') {
        if (missingDb) throw new Error('missing fixture database');
        return { size: dbSize };
      }
      assert.equal(path, '/work/reports/application-image-vulnerabilities.json');
      return { size: reportSize };
    },
    readFileSync(path) {
      return path.startsWith('/sys/fs/cgroup/') ? '1\n' : '{"matches":[]}';
    },
  };
  function spawn(command, args, options) {
    const index = commands.length;
    commands.push({ command, args, options });
    return { status: index === failedAt ? 1 : index === 6 ? scanStatus : 0, stdout: 'out', stderr: 'err', signal: null };
  }
  const outcome = runOfflineScanner({ fileSystem, spawn, write: value => envelopes.push(JSON.parse(value)) });
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].exit_code, outcome);
  assert.equal(envelopes[0].kind, 'grype-offline-envelope-v1');
  assert.deepEqual(directories.map(([path]) => path), ['/work/reports', '/work/tmp', '/work/home']);
  for (const command of commands) {
    assert.equal(command.command, '/inputs/grype');
    assert.deepEqual(command.args.slice(0, 2), ['--config', '/inputs/grype.yaml']);
    assert.equal(command.options.cwd, '/work');
    assert.equal(command.options.killSignal, 'SIGKILL');
    assert.equal(command.options.maxBuffer, 16 * 1024 * 1024);
    assert.ok(command.options.timeout > 0 && command.options.timeout <= 90000);
  }
  return { outcome, envelope: envelopes[0], commands };
}

test('all pre-scan commands must succeed', () => {
  for (let failedAt = 0; failedAt < 6; failedAt++) {
    const result = fixture({ failedAt });
    assert.equal(result.outcome, 1);
    assert.equal(result.commands.length, failedAt + 1);
    assert.ok(result.envelope.files['failure.json']);
  }
});

test('missing or oversized hydrated database refuses the scan', () => {
  for (const options of [{ missingDb: true }, { dbSize: 3.5 * 1024 ** 3 + 1 }]) {
    const result = fixture(options);
    assert.equal(result.outcome, 1); assert.equal(result.commands.length, 6);
    assert.ok(result.envelope.files['failure.json']);
  }
});

test('scan exit 0 or 2 is retained and other statuses fail closed', () => {
  for (const status of [0, 2, 1, null]) {
    const result = fixture({ scanStatus: status });
    assert.equal(result.commands.length, 7);
    assert.equal(result.outcome, status === 0 || status === 2 ? status : 1);
    assert.equal(Boolean(result.envelope.files['failure.json']), status !== 0 && status !== 2);
    assert.equal(Boolean(result.envelope.files['application-image-vulnerabilities.json']), status === 0 || status === 2);
  }
});

test('oversized report fails without publishing its contents', () => {
  const result = fixture({ reportSize: 32 * 1024 * 1024 + 1 });
  assert.equal(result.outcome, 1);
  assert.ok(result.envelope.files['failure.json']);
  assert.equal(result.envelope.files['application-image-vulnerabilities.json'], undefined);
});
