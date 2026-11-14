import { describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listWebConsoleSetupChecks } from '../../../../src/web-console/setup/WebConsoleSetupChecks.js';

const GUIDE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../docs/guides/console-setup-checks.md');

// The guide is written by hand, the catalog is code. These keep the two from
// drifting apart without anyone noticing.
describe('the console setup checks guide', () => {
  it('has a section for every check in the catalog, under the catalog\'s own title and ID', async () => {
    const guide = await readFile(GUIDE, 'utf8');

    for (const check of listWebConsoleSetupChecks()) {
      expect(guide).toContain(`### ${check.title}\n\n\`${check.id}\``);
    }
  });

  it('describes no check the catalog does not have', async () => {
    const guide = await readFile(GUIDE, 'utf8');
    const ids = new Set(listWebConsoleSetupChecks().map(check => check.id as string));

    const described = [...guide.matchAll(/^### .+\n\n`([a-z_]+)`/gm)].map(match => match[1]);

    expect(described).toHaveLength(ids.size);
    expect(described.filter(id => !ids.has(id))).toEqual([]);
  });

  it('files each check under the right heading: run by the server, or dependent on use', async () => {
    const guide = await readFile(GUIDE, 'utf8');
    const dependsOnUse = guide.slice(guide.indexOf('## Checks that depend on somebody doing something'), guide.indexOf('## Qualifying a deployment'));

    for (const check of listWebConsoleSetupChecks()) {
      expect({ id: check.id, underUse: dependsOnUse.includes(`\`${check.id}\``) })
        .toEqual({ id: check.id, underUse: check.verification === 'usage-record' });
    }
  });
});
