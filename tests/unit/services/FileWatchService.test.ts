import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { FileWatchService } from '../../../src/services/FileWatchService.js';

describe('FileWatchService', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-watch-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('invokes handlers on file changes and cleans up watchers', async () => {
    // Create a new instance (no longer using singleton pattern)
    const service = new FileWatchService();
    const handler = jest.fn();

    const unsubscribe = service.watchDirectory(tempDir, handler);

    // CRITICAL: Give FSEvents time to fully initialize AND let any directory-creation events settle.
    // On macOS, FSEvents may report the temp directory creation itself as an event.
    // We wait, then clear the mock to ignore any initialization noise.
    await new Promise(resolve => setTimeout(resolve, 200));
    handler.mockClear();

    const targetFile = path.join(tempDir, 'example.md');
    await fs.writeFile(targetFile, 'hello');

    // macOS FSEvents has inherent latency (can be 100ms-2s+ depending on system load).
    // Use generous timeout following project philosophy: "Use generous timeouts up to 30x base delay"
    // Base delay ~100ms, so we allow up to 3000ms (30x) for reliable cross-platform behavior.
    const waitForCall = async (mock: jest.Mock, expectedFile: string, maxWait = 3000, interval = 50) => {
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        // Check if any call contains our expected file
        const hasExpectedCall = mock.mock.calls.some(
          (call: unknown[]) => call[0] === expectedFile
        );
        if (hasExpectedCall) return true;
        await new Promise(r => setTimeout(r, interval));
      }
      return false;
    };

    const called = await waitForCall(handler, 'example.md');
    expect(called).toBe(true);
    expect(handler).toHaveBeenCalledWith('example.md');

    unsubscribe();

    // After unsubscribe, further writes should not trigger handler
    handler.mockClear();
    await fs.writeFile(targetFile, 'hello again');

    await new Promise(resolve => setTimeout(resolve, 500));
    expect(handler).not.toHaveBeenCalled();
  });
});
