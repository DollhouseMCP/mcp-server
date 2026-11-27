import { expect, it } from '@jest/globals';
import { homedir } from 'node:os';
import { isolatedServerEnv } from '../helpers/isolated-server-env.cjs';

it('suppresses native verification dialogs in integration workers and subprocesses by default', () => {
  expect(process.env.DOLLHOUSE_SUPPRESS_VERIFICATION_DIALOG).toBe('true');
  expect(isolatedServerEnv(homedir(), { DOLLHOUSE_SUPPRESS_VERIFICATION_DIALOG: 'false' }))
    .toHaveProperty('DOLLHOUSE_SUPPRESS_VERIFICATION_DIALOG', 'true');
});
