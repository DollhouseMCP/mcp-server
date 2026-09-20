import { describe, expect, it } from '@jest/globals';

import {
  deriveLocalUsername,
  normalizeLocalDisplayName,
  normalizeLocalUsername,
} from '../../../../src/web-console/ui/account-username';

describe('local account name contract', () => {
  it.each([
    ['Todd Lewis', 'todd-lewis'],
    ["Renée O'Connor", 'renée-o-connor'],
    ['李 小龙', '李-小龙'],
    ['  Café---Δοκιμή  ', 'café-δοκιμή'],
  ])('derives %s as %s', (displayName, expected) => {
    expect(deriveLocalUsername(displayName)).toBe(expected);
  });

  it('preserves the human-readable display name after trim and NFC normalization', () => {
    expect(normalizeLocalDisplayName('  Rene\u0301e O’Connor  ')).toBe('Renée O’Connor');
  });

  it.each(['bob_2', 'already-normalized', 'δοκιμή_2'])('preserves normalized username %s', username => {
    expect(normalizeLocalUsername(username)).toBe(username);
  });

  it('keeps legacy case-folding behavior for a supplied username', () => {
    expect(normalizeLocalUsername('Alice_2')).toBe('alice_2');
  });

  it.each([
    ['punctuation-only display name', () => deriveLocalUsername('!!!')],
    ['overlong derived username', () => deriveLocalUsername('a'.repeat(65))],
    ['leading-hyphen username', () => normalizeLocalUsername('-alice')],
    ['username punctuation', () => normalizeLocalUsername('alice.smith')],
    ['detached username combining mark', () => normalizeLocalUsername('alice-\u0301')],
    ['formatting control in display name', () => normalizeLocalDisplayName('Alice\u202E')],
  ])('rejects %s', (_description, action) => {
    expect(action).toThrow();
  });

  it('surfaces deterministic collisions for the store to reject explicitly', () => {
    expect(deriveLocalUsername('Todd Lewis')).toBe(deriveLocalUsername('Todd-Lewis'));
  });
});
