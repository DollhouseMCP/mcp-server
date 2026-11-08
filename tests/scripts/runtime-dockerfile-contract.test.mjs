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
    assert.match(builder, /FROM node-base AS runtime-security/);
    assert.match(builder, /node \/tmp\/stage-zlib-runtime\.mjs/);
    assert.match(runtime, /COPY --from=runtime-security \/tmp\/zlib-overlay\/ \//);
    assert.match(runtime, /COPY --from=runtime-security --chown=1001:1001 --chmod=0640 \/tmp\/zlib-receipt\.json/);
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
    assert.ok(runtime.includes('HOME=/home/dollhouse'));
    assert.ok(runtime.includes('/app/node_modules/.bin:/nodejs/bin:'));
    if (file === 'docker/Dockerfile') assert.match(runtime, /CMD \["\/nodejs\/bin\/node", "-e",/);
  });
}
