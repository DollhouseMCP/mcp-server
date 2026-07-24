import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { pollUntilTerminal } from '../../../../src/web-console/ui/polling';

describe('web-console polling utilities', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns immediately when the first status is terminal', async () => {
    const readStatus = jest.fn(() => Promise.resolve({ status: 'terminated' }));

    await expect(pollUntilTerminal(readStatus)).resolves.toEqual({
      timedOut: false,
      status: { status: 'terminated' },
    });
    expect(readStatus).toHaveBeenCalledTimes(1);
  });

  it('continues from pending to a terminal status', async () => {
    jest.useFakeTimers();
    const readStatus = jest.fn<() => Promise<{ status: string }>>()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'terminated' });

    const result = pollUntilTerminal(readStatus, { intervalMs: 100, timeoutMs: 1_000 });
    await jest.advanceTimersByTimeAsync(100);

    await expect(result).resolves.toEqual({
      timedOut: false,
      status: { status: 'terminated' },
    });
    expect(readStatus).toHaveBeenCalledTimes(2);
  });

  it('returns the latest status when the timeout expires', async () => {
    jest.useFakeTimers();
    const readStatus = jest.fn(() => Promise.resolve({ status: 'pending' }));

    const result = pollUntilTerminal(readStatus, { intervalMs: 100, timeoutMs: 250 });
    await jest.advanceTimersByTimeAsync(300);

    await expect(result).resolves.toEqual({
      timedOut: true,
      status: { status: 'pending' },
    });
    expect(readStatus).toHaveBeenCalledTimes(3);
  });

  it('rejects with AbortError when cancellation interrupts polling', async () => {
    const controller = new AbortController();
    const readStatus = jest.fn(() => {
      controller.abort();
      return Promise.resolve({ status: 'pending' });
    });

    await expect(pollUntilTerminal(readStatus, {
      signal: controller.signal,
      intervalMs: 100,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(readStatus).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed status response instead of silently timing out', async () => {
    const readStatus = jest.fn(() => Promise.resolve({}));

    await expect(pollUntilTerminal(readStatus)).rejects.toThrow(
      'Polling status response must include a non-empty status.',
    );
    expect(readStatus).toHaveBeenCalledTimes(1);
  });
});
