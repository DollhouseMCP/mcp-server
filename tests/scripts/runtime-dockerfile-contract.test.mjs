import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const digest = 'sha256:b8cec4b2f2126ff7bd034ec9ac207ffb3272667dfdc48376e3b035d3270549ba';
for (const file of ['docker/Dockerfile', 'docker/Dockerfile.prebuilt']) {
  test(`${file} keeps builder tooling outside the shell-free runtime`, () => {
    const source = readFileSync(file, 'utf8');
    const [builder, runtime] = source.split(' AS production\n');
    assert.ok(runtime && builder.includes(`nodejs24-debian13@${digest}`));
    assert.match(builder, /FROM node-base AS runtime-assets/);
    assert.match(builder, /FROM node-base AS runtime-security\nUSER 0:0\nRUN mkdir -m 0700 \/root\/zlib-runtime && mkdir -m 0700 \/root\/zlib-runtime\/download/);
    assert.match(builder, /node \/root\/zlib-runtime\/stage-zlib-runtime\.mjs/);
    assert.match(runtime, /COPY --from=runtime-security \/root\/zlib-runtime\/overlay\/ \//);
    assert.match(runtime, /COPY --from=runtime-security --chown=1001:1001 --chmod=0640 \/root\/zlib-runtime\/receipt\.json/);
    assert.match(builder, /apt=3\.0\.4/);
    assert.match(builder, /libapt-pkg7\.0=3\.0\.4/);
    assert.match(builder, /chmod 700 \/app\/tmp \/app\/logs \/app\/\.memory-upgrade-control \/home\/dollhouse/);
    const commands = runtime.match(/^RUN .+$/gm) ?? [];
    assert.equal(commands.length, 1);
    assert.ok(commands[0].startsWith('RUN ["/nodejs/bin/node", "-e", '));
    assert.ok(commands[0].includes('fs.lstatSync(p)'));
    assert.ok(commands[0].includes('fs.chmodSync(p,m)'));
    assert.ok(commands[0].includes("['/app',0o750],['/app/dist',0o750]"));
    assert.ok(commands[0].includes("['/app/.memory-upgrade-control',0o700]"));
    assert.doesNotMatch(runtime, /\/usr\/local\/lib\/node_modules\/npm/);
    assert.match(runtime, /COPY --from=runtime-assets --chown=1001:1001 \/app \/app/);
    assert.match(runtime, /^USER 1001:1001$/m);
    const users = runtime.match(/^USER .+$/gm) ?? [];
    assert.equal(users.at(-1), 'USER 1001:1001');
    assert.match(runtime, /^ENTRYPOINT \[\]$/m);
    assert.match(runtime, /^CMD \["node", "--trace-warnings", "dist\/index\.js"\]$/m);
    const [beforeMigration, afterMigration] = source.split('FROM production AS migration\n');
    assert.ok(beforeMigration && afterMigration, 'named migration stage is required');
    const [migration, defaultProduction] = afterMigration.split('FROM production AS default-production\n');
    assert.equal(defaultProduction, '', 'plain Docker build must end at the production alias');
    assert.match(migration, /COPY --chown=1001:1001 src\/database\/migrations\/\*\.sql \/app\/src\/database\/migrations\//);
    assert.match(migration, /COPY --chown=1001:1001 src\/database\/migrations\/meta\/_journal\.json/);
    assert.match(migration, /^HEALTHCHECK NONE$/m);
    assert.match(migration, /^CMD \["node", "dist\/cli\/migrate-database\.js"\]$/m);
    assert.doesNotMatch(migration, /^RUN |\bnpm\b|\/bin\/sh/m);
    assert.ok(runtime.includes('HOME=/home/dollhouse'));
    assert.ok(runtime.includes('/app/node_modules/.bin:/nodejs/bin:'));
    if (file === 'docker/Dockerfile') assert.match(runtime, /CMD \["\/nodejs\/bin\/node", "-e",/);
  });
}

test('prebuilt context retains the root exclusions while admitting compiled dist', () => {
  const root = readFileSync('.dockerignore', 'utf8');
  const prebuilt = readFileSync('docker/Dockerfile.prebuilt.dockerignore', 'utf8');
  assert.equal(prebuilt, root.replace('# Build artifacts (rebuilt in container)\ndist/\n',
    '# Prebuilt Dockerfile consumes the supplied compiled dist.\n'));
});
