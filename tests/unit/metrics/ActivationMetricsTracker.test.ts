import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ActivationMetricsTracker, MAX_RETAINED_ACTIVATION_WARNINGS } from '../../../src/metrics/ActivationMetricsTracker.js';
import { ActivationMetricsCollector } from '../../../src/metrics/collectors/ActivationMetricsCollector.js';
import { DollhouseContainer } from '../../../src/di/Container.js';
import { SessionContainer } from '../../../src/di/SessionContainer.js';
import { logger } from '../../../src/utils/logger.js';
import type { ContextTracker } from '../../../src/security/encryption/ContextTracker.js';
import { createUserIdResolver } from '../../../src/database/UserContext.js';
import { createStdioSession } from '../../../src/context/StdioSession.js';

describe('Activation retention metrics', () => {
  afterEach(() => jest.restoreAllMocks());

  it('deduplicates by user, type and exact reference and escapes the warning', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    let userId = 'user-a';
    const tracker = new ActivationMetricsTracker(() => userId);
    const reference = 'name\nforged log';
    const notice = tracker.retain('persona', reference);
    expect(tracker.retain('persona', reference)).toBe(notice);
    expect(notice).toContain('name\\nforged log');
    expect(notice).not.toContain('\n');
    userId = 'user-b';
    tracker.retain('persona', reference);
    tracker.retain('persona', reference);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).not.toMatch(/user-a|forged log/);
    expect(warn.mock.calls[0][1]).toMatchObject({ userId: 'user-a', reference, elementType: 'persona' });
    expect(warn).toHaveBeenLastCalledWith(expect.not.stringContaining('user-b'),
      { userId: 'user-b', reference, elementType: 'persona' });
    tracker.retain('skill', reference);
    const collector = new ActivationMetricsCollector(tracker);
    expect(collector.collect()).toEqual([
      expect.objectContaining({ name: 'activation.stale_reference_retained', type: 'counter', value: 3 }),
    ]);
    expect(JSON.stringify(collector.collect())).not.toMatch(/user-a|user-b|userId/);
    expect(new ActivationMetricsCollector(new ActivationMetricsTracker(() => 'empty')).collect()).toEqual([expect.objectContaining({ value: 0 })]);
  });

  it('bounds remembered keys and permits evicted or explicitly cleared keys to warn again', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const tracker = new ActivationMetricsTracker(() => 'user');
    for (let index = 0; index <= MAX_RETAINED_ACTIVATION_WARNINGS; index++) {
      tracker.retain('persona', `ref-${index}`);
    }
    tracker.retain('persona', `ref-${MAX_RETAINED_ACTIVATION_WARNINGS}`);
    expect(warn).toHaveBeenCalledTimes(MAX_RETAINED_ACTIVATION_WARNINGS + 1);
    tracker.retain('persona', 'ref-0');
    tracker.forget('persona', 'ref-0');
    tracker.retain('persona', 'ref-0');
    expect(warn).toHaveBeenCalledTimes(MAX_RETAINED_ACTIVATION_WARNINGS + 3);
    expect(tracker.getMetrics()).toBe(MAX_RETAINED_ACTIVATION_WARNINGS + 3);
  });

  it('shares warnings across sessions but resolves each authenticated user independently', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const root = new DollhouseContainer();
    const context = root.resolve<ContextTracker>('ContextTracker');
    root.register('UserIdResolver', () => createUserIdResolver(context));
    const first = new SessionContainer(root, 'one');
    const second = new SessionContainer(root, 'two');
    expect(first.resolve('ActivationMetricsTracker')).toBe(second.resolve('ActivationMetricsTracker'));
    const users = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    try {
      for (const userId of users) {
        for (const child of [first, second]) {
          context.run({ type: 'test', session: { ...createStdioSession(), transport: 'http', userId, sessionId: child.sessionId } }, () => {
            child.resolve<ActivationMetricsTracker>('ActivationMetricsTracker').retain('persona', 'same.md');
          });
        }
      }
      expect(warn).toHaveBeenCalledTimes(2);
      const metrics = root.resolve<ActivationMetricsTracker>('ActivationMetricsTracker').getMetrics();
      expect(metrics).toBe(2);
    } finally {
      await root.dispose();
    }
  });
});
