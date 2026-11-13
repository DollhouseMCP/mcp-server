import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

// Keep workstation dotenv files from supplying the setting under test.
jest.unstable_mockModule('dotenv', () => ({ default: { config: jest.fn() } }));

const SETTING = 'DOLLHOUSE_WEB_CONSOLE_CANARY_INTERVAL_MINUTES';
const originalEnv = { ...process.env };
beforeEach(() => { jest.resetModules(); delete process.env[SETTING]; });
afterEach(() => { process.env = { ...originalEnv }; jest.resetModules(); });

describe('web console canary schedule environment configuration', () => {
  it('is off when the setting is absent', async () => {
    const { env } = await import('../../../src/config/env.js');
    expect(env.DOLLHOUSE_WEB_CONSOLE_CANARY_INTERVAL_MINUTES).toBe(0);
  });

  it.each(['0', '5', '60', '720'])('accepts an interval of %s minutes', async value => {
    process.env[SETTING] = value;
    const { env } = await import('../../../src/config/env.js');
    expect(env.DOLLHOUSE_WEB_CONSOLE_CANARY_INTERVAL_MINUTES).toBe(Number(value));
  });

  it.each(['1', '4'])('rejects an interval of %s minutes and says what the shortest is', async value => {
    process.env[SETTING] = value;
    await expect(import('../../../src/config/env.js')).rejects.toThrow(
      'DOLLHOUSE_WEB_CONSOLE_CANARY_INTERVAL_MINUTES: 0 switches the schedule off; the shortest interval is 5 minutes',
    );
  });

  it.each(['-1', '7.5', '721', 'often'])('rejects an invalid interval of %s', async value => {
    process.env[SETTING] = value;
    await expect(import('../../../src/config/env.js')).rejects.toThrow(SETTING);
  });
});
