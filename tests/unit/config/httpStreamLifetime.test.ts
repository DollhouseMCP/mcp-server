import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// Keep workstation dotenv files from supplying the setting under test.
jest.unstable_mockModule('dotenv', () => ({ default: { config: jest.fn() } }));

const originalEnv = { ...process.env };
beforeEach(() => { jest.resetModules(); delete process.env.DOLLHOUSE_HTTP_STREAM_MAX_LIFETIME_MS; delete process.env.DOLLHOUSE_HTTP_STREAM_KEEPALIVE_MS; });
afterEach(() => { process.env = { ...originalEnv }; jest.resetModules(); });

describe('MCP stream lifetime environment configuration', () => {
  it('defaults to no wall-clock cap when the setting is absent', async () => {
    const { env } = await import('../../../src/config/env.js');
    expect(env.DOLLHOUSE_HTTP_STREAM_MAX_LIFETIME_MS).toBe(0);
  });

  it.each(['0', '150', '2147483647'])('accepts an explicit cap of %s', async value => {
    process.env.DOLLHOUSE_HTTP_STREAM_MAX_LIFETIME_MS = value;
    const { env } = await import('../../../src/config/env.js');
    expect(env.DOLLHOUSE_HTTP_STREAM_MAX_LIFETIME_MS).toBe(Number(value));
  });

  it.each(['-1', '1.5', '2147483648'])('rejects an invalid cap of %s', async value => {
    process.env.DOLLHOUSE_HTTP_STREAM_MAX_LIFETIME_MS = value;
    await expect(import('../../../src/config/env.js')).rejects.toThrow('DOLLHOUSE_HTTP_STREAM_MAX_LIFETIME_MS');
  });
});


describe('MCP stream keepalive environment configuration', () => {
  it('defaults to 15000 ms when absent', async () => {
    const { env } = await import('../../../src/config/env.js');
    expect(env.DOLLHOUSE_HTTP_STREAM_KEEPALIVE_MS).toBe(15000);
  });

  it.each(['0', '1000', '15000', '2147483647'])('accepts keepalive interval %s', async value => {
    process.env.DOLLHOUSE_HTTP_STREAM_KEEPALIVE_MS = value;
    const { env } = await import('../../../src/config/env.js');
    expect(env.DOLLHOUSE_HTTP_STREAM_KEEPALIVE_MS).toBe(Number(value));
  });

  it.each(['999', '15'])('rejects sub-second interval %s with actionable units', async value => {
    process.env.DOLLHOUSE_HTTP_STREAM_KEEPALIVE_MS = value;
    await expect(import('../../../src/config/env.js')).rejects.toThrow('DOLLHOUSE_HTTP_STREAM_KEEPALIVE_MS: 0 disables keepalive and stall detection; minimum nonzero interval is 1000 ms');
  });

  it.each(['-1', '1000.5', '2147483648'])('preserves rejection of invalid interval %s', async value => {
    process.env.DOLLHOUSE_HTTP_STREAM_KEEPALIVE_MS = value;
    await expect(import('../../../src/config/env.js')).rejects.toThrow('DOLLHOUSE_HTTP_STREAM_KEEPALIVE_MS');
  });
});
