import { describe, expect, it } from '@jest/globals';
import {
  compareSemver,
  isBetaSemver,
  isStableSemver,
  isValidSemver,
} from '../../../scripts/compare-semver.mjs';

describe('compare-semver', () => {
  it.each([
    ['2.1.1', '2.1.0', 1],
    ['2.1.0', '2.1.1', -1],
    ['2.1.0', '2.1.0-beta.9', 1],
    ['2.1.0-beta.10', '2.1.0-beta.9', 1],
    ['2.1.0-beta.9007199254740993', '2.1.0-beta.9007199254740992', 1],
    ['9007199254740993.0.0', '9007199254740992.0.0', 1],
    ['2.1.0-beta.1', '2.1.0-beta.alpha', -1],
    ['2.1.0-beta', '2.1.0-beta.1', -1],
    ['2.1.0+build.2', '2.1.0+build.1', 0],
  ])('compares %s with %s', (left, right, expected) => {
    expect(compareSemver(left, right)).toBe(expected);
  });

  it.each([
    'latest',
    '02.1.0-beta.1',
    '2.1.0-beta..1',
    '2.1.0-beta.01',
    '2.1.0+build..1',
  ])('fails closed for invalid version %s', value => {
    expect(() => compareSemver(value, '2.1.0')).toThrow(/invalid SemVer/);
  });

  it.each([
    '2.1.0-beta',
    '2.1.0-beta.1',
    '2.1.0-beta.preview-2+build.7',
  ])('recognizes strict beta version %s', value => {
    expect(isValidSemver(value)).toBe(true);
    expect(isBetaSemver(value)).toBe(true);
    expect(isStableSemver(value)).toBe(false);
  });

  it.each([
    '2.1.0-alpha.1',
    '2.1.0-rc.1',
    '2.1.0-beta.01',
    '2.1.0-beta..1',
    '02.1.0-beta.1',
  ])('does not recognize non-beta or invalid version %s as beta', value => {
    expect(isBetaSemver(value)).toBe(false);
  });

  it('recognizes stable versions without accepting prereleases', () => {
    expect(isStableSemver('2.1.0')).toBe(true);
    expect(isStableSemver('2.1.0+build.7')).toBe(true);
    expect(isStableSemver('2.1.0-beta.1')).toBe(false);
  });
});
