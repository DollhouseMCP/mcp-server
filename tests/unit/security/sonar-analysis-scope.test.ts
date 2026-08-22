import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Sonar analysis scope', () => {
  const projectRoot = process.cwd();

  it.each(['.sonarcloud.properties', 'sonar-project.properties'])(
    'keeps SQL migrations in analysis for %s',
    (configurationFile) => {
      const content = readFileSync(join(projectRoot, configurationFile), 'utf8');
      const exclusions = content
        .split('\n')
        .filter(line => line.startsWith('sonar.exclusions='))
        .join('\n');

      expect(exclusions).not.toContain('**/*.sql');
    },
  );

  it('uses targeted PL/SQL rule exclusions instead of excluding every migration', () => {
    const content = readFileSync(join(projectRoot, 'sonar-project.properties'), 'utf8');

    expect(content).toContain('sonar.issue.ignore.multicriteria');
    expect(content).toContain('plsql:');
    expect(content).toContain('resourceKey=src/database/migrations/**');
  });
});
