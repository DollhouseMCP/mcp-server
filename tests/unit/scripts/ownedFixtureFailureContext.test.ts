import { describe, expect, it, jest } from '@jest/globals';
import { formatResultsErrors } from 'jest-message-util';
import { runInNewContext } from 'node:vm';
import { OwnedFixtureProcess, OwnedFixtureRegistry } from '../../helpers/ownedFixtureProcess.js';

const UNSETTLED = 'Prior owned fixture is unsettled; refusing another spawn';
const CLEANUP_MARKER = 'synthetic-secondary-finish-marker';
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
function captured<T>(work: Promise<T>) {
  return work.then(value => ({ failed: false as const, value }), cause => ({ failed: true as const, cause }));
}
function renderedTestFailure(error: Error): string | null {
  // Exact installed ordinary test/hook rendering boundary, not formatExecError.
  const results = [{ ancestorTitles: [], title: 'resource-free retained-owner refusal',
    fullName: 'resource-free retained-owner refusal', numPassingAsserts: 0, status: 'failed' as const,
    failureMessages: [error.stack ?? error.message], failureDetails: [error] }];
  return formatResultsErrors(results,
    { rootDir: process.cwd(), testMatch: [] } as Parameters<typeof formatResultsErrors>[1],
    { noStackTrace: true }, 'synthetic.test.ts');
}

describe('owned fixture failure context (resource-free)', () => {
  it.each([new Error('synthetic-primary-operation'), undefined, null, false, 0, ''])('reports settled cleanup failure through actual final refusal, retaining original %p', async primary => {
    const registry = new OwnedFixtureRegistry(), entered = deferred(), release = deferred();
    const secondary = new Error(CLEANUP_MARKER);
    const finish = jest.spyOn(OwnedFixtureProcess.prototype, 'finish').mockImplementationOnce(async () => {
      entered.release(); await release.promise; throw secondary;
    });
    const work = registry.run(async () => { throw primary; });
    const outcome = captured(work); // Attached before cancellation; do not reduce errors to .message.
    try {
      await entered.promise;
      const cleanup = captured(registry.cancelUnfinished());
      release.release();
      const refusal = await cleanup; // Match actual failed boundary BEFORE consuming mapped outcome.
      expect(refusal.failed).toBe(true);
      if (!refusal.failed) throw new Error('Expected retained-owner refusal');
      expect(refusal.cause).toBeInstanceOf(Error);
      const error = refusal.cause as Error;
      expect(error.message).toBe(UNSETTLED);
      const rendered = renderedTestFailure(error);
      process.stderr.write(`OWNED_CONTEXT_FORMAT ${JSON.stringify({ markerVisible: rendered?.includes(CLEANUP_MARKER), rendered })}\n`);
      expect(rendered).toContain(CLEANUP_MARKER);
      const pair = error.cause as AggregateError;
      expect(pair).toBeInstanceOf(AggregateError);
      expect(pair.errors).toHaveLength(2);
      expect(pair.errors[0]).toBe(primary); expect(pair.errors[1]).toBe(secondary);
      expect(pair.cause).toBe(secondary);
      const result = await outcome;
      expect(result.failed).toBe(true);
      if (result.failed) expect(result.cause).toBe(pair);
      expect(() => registry.assertSettled()).toThrow(UNSETTLED);
      await expect(registry.run(async () => 'must-not-enter')).rejects.toThrow(UNSETTLED);
    } finally { release.release(); await outcome; finish.mockRestore(); }
  });

  it.each([new Error('synthetic-primary-operation'), undefined, null, false, 0, ''])('preserves original-only rejection identity (%p) after successful cleanup', async primary => {
    const registry = new OwnedFixtureRegistry();
    const result = await captured(registry.run(async () => { throw primary; }));
    expect(result.failed).toBe(true);
    if (result.failed) expect(result.cause).toBe(primary);
    registry.assertSettled();
  });

  it.each([new Error(CLEANUP_MARKER), undefined, false])('preserves cleanup-only rejection identity (%p)', async secondary => {
    const registry = new OwnedFixtureRegistry();
    const finish = jest.spyOn(OwnedFixtureProcess.prototype, 'finish').mockImplementationOnce(async () => { throw secondary; });
    try {
      const result = await captured(registry.run(async () => 'operation-success'));
      expect(result.failed).toBe(true);
      if (result.failed) expect(result.cause).toBe(secondary);
      const refusal = await captured(registry.cancelUnfinished());
      expect(refusal.failed).toBe(true);
      if (refusal.failed) expect((refusal.cause as Error).cause).toBe(secondary);
    } finally { finish.mockRestore(); }
  });

  it('retains a non-Error cleanup payload without stringification and renders only a fixed category', async () => {
    const registry = new OwnedFixtureRegistry();
    const stringify = jest.fn(() => { throw new Error('Must not stringify payload'); });
    const secondary = { toString: stringify };
    const finish = jest.spyOn(OwnedFixtureProcess.prototype, 'finish').mockImplementationOnce(async () => { throw secondary; });
    try {
      const result = await captured(registry.run(async () => { throw undefined; }));
      expect(result.failed).toBe(true);
      if (!result.failed) throw new Error('Expected original rejection');
      const pair = result.cause as AggregateError;
      expect(pair.errors[0]).toBeUndefined(); expect(pair.errors[1]).toBe(secondary);
      expect((pair.cause as Error).message).toBe('Owned fixture cleanup rejected with a non-Error payload');
      expect(stringify).not.toHaveBeenCalled();
    } finally { finish.mockRestore(); }
  });

  it('preserves and renders a real cleanup Error from another VM realm', async () => {
    const registry = new OwnedFixtureRegistry();
    const secondary: unknown = runInNewContext("new Error('synthetic-cross-realm-cleanup-marker')");
    expect(secondary instanceof Error).toBe(false);
    const finish = jest.spyOn(OwnedFixtureProcess.prototype, 'finish').mockImplementationOnce(async () => { throw secondary; });
    try {
      const outcome = captured(registry.run(async () => { throw undefined; }));
      const refusal = await captured(registry.cancelUnfinished());
      expect(refusal.failed).toBe(true);
      if (!refusal.failed) throw new Error('Expected retained-owner refusal');
      const pair = (refusal.cause as Error).cause as AggregateError;
      expect(pair.errors[0]).toBeUndefined(); expect(pair.errors[1]).toBe(secondary);
      expect(renderedTestFailure(refusal.cause as Error)).toContain('synthetic-cross-realm-cleanup-marker');
      expect(pair.cause).toBe(secondary);
      const result = await outcome;
      expect(result.failed).toBe(true);
      if (result.failed) expect(result.cause).toBe(pair);
    } finally { finish.mockRestore(); }
  });

  it('propagates initial cancel refusal without awaiting an unfinished original callback', async () => {
    const registry = new OwnedFixtureRegistry(), release = deferred();
    const primary = new Error('synthetic-initial-cancel-refusal');
    const cancel = jest.spyOn(OwnedFixtureProcess.prototype, 'cancel').mockImplementationOnce(() => { throw primary; });
    let settled = false;
    const outcome = captured(registry.run(async () => { await release.promise; return 'done'; })).then(result => { settled = true; return result; });
    try {
      const refusal = await captured(registry.cancelUnfinished());
      expect(refusal).toEqual({ failed: true, cause: primary });
      expect(settled).toBe(false);
      expect(() => registry.assertSettled()).toThrow(UNSETTLED);
    } finally { release.release(); await outcome; cancel.mockRestore(); }
  });

  it('preserves the existing bounded-finished timeout without awaiting an unfinished original callback', async () => {
    jest.useFakeTimers();
    const registry = new OwnedFixtureRegistry(), release = deferred();
    let settled = false;
    const outcome = captured(registry.run(async () => { await release.promise; })).then(result => { settled = true; return result; });
    try {
      const cleanup = captured(registry.cancelUnfinished());
      await jest.advanceTimersByTimeAsync(2500);
      const refusal = await cleanup;
      expect(refusal.failed).toBe(true);
      if (refusal.failed) expect((refusal.cause as Error).message).toBe('Owned fixture cleanup did not settle within 2500ms');
      expect(settled).toBe(false);
      expect(() => registry.assertSettled()).toThrow(UNSETTLED);
    } finally { release.release(); await outcome; jest.useRealTimers(); }
  });
});
