import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { withRetry } from '../../../src/state/persistence-utils.js';

afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
describe('persisted-state retries', () => {
  it('runs sequential attempts with the configured delays', async () => {
    jest.useFakeTimers();
    const operation = jest.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockResolvedValue();
    const pending = withRetry(operation, 2, 100);
    expect(operation).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(99);
    expect(operation).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(100);
    await pending;
    expect(operation).toHaveBeenCalledTimes(3);
  });
  it('returns the final failure after the configured attempts', async () => {
    jest.useFakeTimers();
    const failure = new Error('write failed');
    const operation = jest.fn<() => Promise<void>>().mockRejectedValue(failure);
    const result = expect(withRetry(operation, 1, 20)).rejects.toBe(failure);
    await jest.advanceTimersByTimeAsync(20);
    await result;
    expect(operation).toHaveBeenCalledTimes(2);
  });
});
