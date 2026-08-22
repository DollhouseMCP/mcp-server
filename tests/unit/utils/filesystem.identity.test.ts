import { jest } from '@jest/globals';
import { ADJECTIVES, ANIMALS } from '../../../src/config/constants.js';
import { generateAnonymousId, generateUniqueId } from '../../../src/utils/filesystem.js';

describe('filesystem identity generation', () => {
  it('preserves the anonymous identity format and configured word lists', () => {
    const identity = generateAnonymousId();
    const match = /^anon-([a-z]+)-([a-z]+)-([a-z0-9]{4})$/.exec(identity);

    expect(match).not.toBeNull();
    expect(ADJECTIVES).toContain(match?.[1]);
    expect(ANIMALS).toContain(match?.[2]);
  });

  it('preserves the unique element identity format', () => {
    expect(generateUniqueId('My Persona', 'test-author')).toMatch(
      /^my-persona_\d{8}-\d{9}-[a-z0-9]{4}_test-author$/,
    );
  });

  it('does not rely on Math.random for production identity material', () => {
    const randomSpy = jest.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be used for identity material');
    });

    try {
      expect(generateAnonymousId()).toMatch(/^anon-[a-z]+-[a-z]+-[a-z0-9]{4}$/);
      expect(generateUniqueId('Secure Identity', 'test-author')).toMatch(
        /^secure-identity_\d{8}-\d{9}-[a-z0-9]{4}_test-author$/,
      );
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('retains useful entropy across repeated generation', () => {
    const suffixes = Array.from({ length: 100 }, () => generateAnonymousId().split('-').at(-1));

    expect(new Set(suffixes).size).toBeGreaterThanOrEqual(90);
  });
});
