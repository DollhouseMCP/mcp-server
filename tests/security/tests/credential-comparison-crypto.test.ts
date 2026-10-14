/**
 * Verify use of the native full-digest comparison primitive (Issue #3075).
 * This is a deterministic delegation contract, not an end-to-end timing proof.
 * The recorder delegates to real crypto; unmocked behavior is tested separately.
 */
import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as realCrypto from 'node:crypto';

const nativeTimingSafeEqual = realCrypto.timingSafeEqual;
const compare = jest.fn(nativeTimingSafeEqual);
let invitationCredentialMatches: typeof import('../../../src/invitations/InvitationToken.js').invitationCredentialMatches;
let HmacConsoleOpaqueValueService: typeof import('../../../src/web-console/security/ConsoleOpaqueValues.js').HmacConsoleOpaqueValueService;

beforeAll(async () => {
  const recordedCrypto = { ...realCrypto, timingSafeEqual: compare };
  // Mock only this test file's module registry before importing the consumers.
  jest.unstable_mockModule('node:crypto', () => recordedCrypto);
  ({ invitationCredentialMatches } = await import('../../../src/invitations/InvitationToken.js'));
  ({ HmacConsoleOpaqueValueService } = await import('../../../src/web-console/security/ConsoleOpaqueValues.js'));
});

beforeEach(() => {
  compare.mockClear();
});

function expectFullDigestCall(left: Buffer, right: Buffer): void {
  expect(compare).toHaveBeenCalledTimes(1);
  const [actualLeft, actualRight] = compare.mock.calls[0];
  expect(actualLeft).toEqual(left);
  expect(actualRight).toEqual(right);
  expect(actualLeft.byteLength).toBe(32);
  expect(actualRight.byteLength).toBe(32);
}

describe('Native credential comparison delegation', () => {
  test.each([-1, 0, 15, 31])('compares the full invitation digest for mismatch index %i', index => {
    const expected = Buffer.from(Array.from({ length: 32 }, (_, byte) => byte));
    const actual = Buffer.from(expected);
    if (index >= 0) actual[index] ^= 0xff;

    expect(invitationCredentialMatches(expected, actual)).toBe(index === -1);
    expectFullDigestCall(expected, actual);
  });

  test.each([-1, 0, 15, 31])('compares the full console hash for mismatch index %i', index => {
    const service = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 0x7b));
    const value = 'synthetic-console-credential';
    const actualHash = service.hashOpaqueValue(value);
    const expectedHash = Buffer.from(actualHash);
    if (index >= 0) expectedHash[index] ^= 0xff;

    expect(service.matchesHash(value, expectedHash)).toBe(index === -1);
    expectFullDigestCall(actualHash, expectedHash);
  });

  test.each([0, 1, 31, 33, 64])('refuses malformed length %i before invoking native crypto', length => {
    const digest = Buffer.alloc(32);
    const malformed = Buffer.alloc(length);
    const service = new HmacConsoleOpaqueValueService(Buffer.alloc(32, 0x7b));

    expect(invitationCredentialMatches(digest, malformed)).toBe(false);
    expect(invitationCredentialMatches(malformed, digest)).toBe(false);
    expect(service.matchesHash('synthetic-console-credential', malformed)).toBe(false);
    expect(compare).not.toHaveBeenCalled();
  });
});
