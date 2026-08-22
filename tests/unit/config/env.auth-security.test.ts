import { describe, expect, it } from '@jest/globals';

import { envSchema } from '../../../src/config/env.js';

describe('authorization environment validation', () => {
  it('accepts valid invite-secret hex and a safe positive generation', () => {
    const parsed = envSchema.parse({
      ...process.env,
      DOLLHOUSE_INVITE_TOKEN_SECRET: 'ab'.repeat(16),
      DOLLHOUSE_AUTH_GENERATION: '42',
    });

    expect(parsed.DOLLHOUSE_INVITE_TOKEN_SECRET).toBe('ab'.repeat(16));
    expect(parsed.DOLLHOUSE_AUTH_GENERATION).toBe(42);
  });

  it('normalizes the empty generation emitted by default Compose to absent', () => {
    const parsed = envSchema.parse({
      ...process.env,
      DOLLHOUSE_AUTH_GENERATION: '',
    });

    expect(parsed.DOLLHOUSE_AUTH_GENERATION).toBeUndefined();
  });

  it.each([
    ['odd-length', `${'ab'.repeat(16)}a`],
    ['non-hexadecimal', `${'ab'.repeat(16)}zz`],
    ['too short', 'ab'.repeat(15)],
  ])('rejects %s invite-secret input', (_label, value) => {
    expect(envSchema.safeParse({
      ...process.env,
      DOLLHOUSE_INVITE_TOKEN_SECRET: value,
    }).success).toBe(false);
  });

  it.each(['0', '-1', '1.5', '01', '9007199254740992'])('rejects invalid authorization generation %s', value => {
    expect(envSchema.safeParse({
      ...process.env,
      DOLLHOUSE_AUTH_GENERATION: value,
    }).success).toBe(false);
  });

  it('accepts active and retained envelope-key IDs up to 255 UTF-8 bytes', () => {
    const activeKeyId = `${'a'.repeat(251)}._:-`;
    const retainedKeyId = 'r'.repeat(255);
    const parsed = envSchema.parse({
      ...process.env,
      DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID: activeKeyId,
      DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED:
        `${retainedKeyId}=${Buffer.alloc(32, 0x11).toString('base64')}`,
    });

    expect(parsed.DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID).toBe(activeKeyId);
    expect(parsed.DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED).toContain(retainedKeyId);
  });

  it.each([
    ['space', 'master key'],
    ['shell expansion', 'master-$(id)'],
    ['semicolon', 'master;id'],
    ['comma delimiter', 'master,key'],
    ['equals delimiter', 'master=key'],
    ['non-ASCII', 'master-é'],
  ])('rejects an active envelope-key ID containing %s', (_label, activeKeyId) => {
    expect(envSchema.safeParse({
      ...process.env,
      DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID: activeKeyId,
    }).success).toBe(false);
  });

  it.each([
    ['space', 'retired key'],
    ['shell expansion', 'retired-$(id)'],
    ['semicolon', 'retired;id'],
    ['comma delimiter', 'retired,key'],
    ['non-ASCII', 'retired-é'],
  ])('rejects a retained envelope-key ID containing %s', (_label, retainedKeyId) => {
    expect(envSchema.safeParse({
      ...process.env,
      DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID: 'master-v2',
      DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED:
        `${retainedKeyId}=${Buffer.alloc(32, 0x11).toString('base64')}`,
    }).success).toBe(false);
  });

  it.each([
    ['empty active ID', '', undefined],
    ['oversized active ID', 'a'.repeat(256), undefined],
    ['multibyte oversized active ID', 'é'.repeat(128), undefined],
    [
      'oversized retained ID',
      'master-v2',
      `${'r'.repeat(256)}=${Buffer.alloc(32, 0x11).toString('base64')}`,
    ],
  ])('rejects %s', (_label, activeKeyId, retiredKeys) => {
    expect(envSchema.safeParse({
      ...process.env,
      DOLLHOUSE_MASTER_ENCRYPTION_KEY_ID: activeKeyId,
      ...(retiredKeys === undefined
        ? { DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED: undefined }
        : { DOLLHOUSE_MASTER_ENCRYPTION_KEYS_RETIRED: retiredKeys }),
    }).success).toBe(false);
  });
});
