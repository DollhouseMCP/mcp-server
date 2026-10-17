import { logger } from '../../../../src/utils/logger.js';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { InMemoryRuntimeSessionControlStore } from '../../../../src/web-console/services/runtime/InMemoryRuntimeSessionControlStore.js';
import { RuntimeMcpSessionControlService } from '../../../../src/web-console/services/runtime/RuntimeMcpSessionControlService.js';
const registration = { sessionId: 'retry-session', userId: '018f3d47-73ae-7f10-a0de-0742618d4fb1', accountCorrelationId: '7e5355c1-bc0d-4bb8-a806-53bd05e44727' };
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(0); jest.spyOn(Math, 'random').mockReturnValue(0.5); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });
describe('initial presence registration recovery', () => {
  it('retries inside the queue, then lets queued activity run', async () => {
    const store = new InMemoryRuntimeSessionControlStore();
    const writes = jest.spyOn(store, 'registerPresence').mockRejectedValueOnce(new Error('temporary'));
    const service = new RuntimeMcpSessionControlService({ store, replicaId: 'retry', leaseDurationMs: 300 });
    const ready = service.registerSession(registration); const activity = service.recordActivity(registration.sessionId);
    await jest.advanceTimersByTimeAsync(100); await ready;
    await expect(activity).resolves.toMatchObject({ kind: 'updated' });
    expect(writes).toHaveBeenCalledTimes(2); expect(jest.getTimerCount()).toBe(0);
    expect(service.getConfirmedLeaseUntil(registration.sessionId)?.getTime()).toBe(400);
  });
  it('logs one bounded, redacted cause across repeated failures and still recovers', async () => {
    const store = new InMemoryRuntimeSessionControlStore();
    const cause = { code: 'ECONNRESET', message: 'Authorization: Bearer secret', config: { headers: { Authorization: 'Bearer secret' } } };
    const writes = jest.spyOn(store, 'registerPresence')
      .mockRejectedValueOnce(cause).mockRejectedValueOnce(cause).mockRejectedValueOnce(cause);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const service = new RuntimeMcpSessionControlService({ store, replicaId: 'retry', leaseDurationMs: 3000 });
    const ready = service.registerSession(registration);
    await jest.advanceTimersByTimeAsync(700); await ready;
    expect(writes).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('registration failed'), expect.objectContaining({
      sessionId: registration.sessionId, failures: 1, error: expect.stringContaining('ECONNRESET'),
    }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
    expect(await store.findPresence(registration.sessionId)).not.toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('disposal cancels retry sleep and never registers another row', async () => {
    const store = new InMemoryRuntimeSessionControlStore();
    const writes = jest.spyOn(store, 'registerPresence').mockRejectedValue(new Error('offline'));
    const service = new RuntimeMcpSessionControlService({ store, replicaId: 'retry', leaseDurationMs: 300 });
    const ready = service.registerSession(registration); await jest.advanceTimersByTimeAsync(0);
    await service.markSessionDisposed(registration.sessionId); await ready;
    await jest.advanceTimersByTimeAsync(500);
    expect(writes).toHaveBeenCalledTimes(1); expect(await store.findPresence(registration.sessionId)).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });
  it('bounds persistent rejected registration at its deadline', async () => {
    const store = new InMemoryRuntimeSessionControlStore();
    jest.spyOn(store, 'registerPresence').mockRejectedValue(new Error('offline'));
    const service = new RuntimeMcpSessionControlService({ store, replicaId: 'retry', leaseDurationMs: 300 });
    const rejected = expect(service.registerSession(registration)).rejects.toThrow('deadline exceeded');
    await jest.advanceTimersByTimeAsync(300); await rejected;
    expect(jest.getTimerCount()).toBe(0);
  });
});
