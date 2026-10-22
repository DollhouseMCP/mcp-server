import { expect, it } from '@jest/globals';
import { validationTimingFailureSummary } from './fixtures/validationTimingDiagnostics.js';

const context = { platform: 'darwin', node: 'v20.20.2', worker: '3' };
it('admits a bounded failure summary with exact statistics without mutating the 100 samples', () => {
  const samples = Array.from({ length: 100 }, (_, index) => ({ duration: 100 - index, path: `private-${index}` }));
  const before = samples.map(sample => sample.duration);
  const summary = validationTimingFailureSummary(samples, 200, 95, 1000, context);
  expect(summary).toEqual({ count: 100, worstIndex: 0, indexBase: 0, minMs: 1, medianMs: 50.5, p95Ms: 95, maxMs: 100,
    overLimitCount: 6, totalMs: 200, individualLimitMs: 95, totalLimitMs: 1000, platform: 'darwin', node: 'v20.20.2', worker: '3' });
  expect(samples.map(sample => sample.duration)).toEqual(before);
  expect(JSON.stringify(summary)).not.toContain('private-');
});

it('stays silent on a passing batch and reports individual and aggregate equality as failures', () => {
  const samples = Array.from({ length: 100 }, () => ({ duration: 1 }));
  expect(validationTimingFailureSummary(samples, 100, 18, 360, context)).toBeUndefined();
  samples[73].duration = 18;
  expect(validationTimingFailureSummary(samples, 100, 18, 360, context)).toMatchObject({ worstIndex: 73, overLimitCount: 1 });
  samples[73].duration = 1;
  expect(validationTimingFailureSummary(samples, 360, 18, 360, context)).toMatchObject({ totalMs: 360, overLimitCount: 0 });
});

it('bounds context fields and selects the first worst index on ties', () => {
  const samples = Array.from({ length: 100 }, () => ({ duration: 1 }));
  samples[2].duration = 34.708; samples[90].duration = 34.708;
  const summary = validationTimingFailureSummary(samples, 100, 18, 360, { platform: 'x'.repeat(10000), node: 'y'.repeat(10000), worker: 'z'.repeat(10000) });
  expect(summary).toMatchObject({ worstIndex: 2, overLimitCount: 2, platform: 'x'.repeat(32), node: 'y'.repeat(32), worker: 'z'.repeat(32) });
  expect(JSON.stringify(summary).length).toBeLessThan(1024);
  expect(validationTimingFailureSummary(samples, 100, 18, 360, { ...context, worker: undefined })?.worker).toBeNull();
});
