import { describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const require = createRequire(import.meta.url);

describe('persona benchmark routing', () => {
  it('keeps the absolute benchmarks runnable through the visible Core performance step', async () => {
    const core = require('../jest.config.cjs') as { testPathIgnorePatterns: string[] };
    const performance = require('../jest.performance.config.cjs') as { testMatch: string[]; testPathIgnorePatterns: string[] };
    expect(core.testPathIgnorePatterns).toContain('/tests/performance/');
    expect(performance.testPathIgnorePatterns).not.toContain('/tests/performance/');
    expect(performance.testMatch).toContain('<rootDir>/tests/performance/**/*.test.ts');
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(manifest.scripts['test:performance']).toContain('tests/jest.performance.config.cjs');
    const workflow = await readFile(path.join(process.cwd(), '.github/workflows/core-build-test.yml'), 'utf8');
    const parsed = yaml.load(workflow) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> };
    const step = Object.values(parsed.jobs).flatMap(job => job.steps)
      .find(candidate => candidate.name === 'Run performance tests (separate process)');
    expect(step?.run).toBe('npm run test:performance');
    const benchmark = await readFile(path.join(process.cwd(), 'tests/performance/persona-finding.performance.test.ts'), 'utf8');
    for (const threshold of [1, 5, 20]) expect(benchmark).toContain(`expect(duration).toBeLessThan(${threshold})`);
  });
});
