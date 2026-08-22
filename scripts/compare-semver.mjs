#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;
const SEMVER_IDENTIFIER_PATTERN = /^[0-9A-Za-z-]+$/;

export function parseSemver(value) {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) throw new Error(`invalid SemVer: ${value}`);
  const prerelease = parseIdentifiers(match[4], true, value);
  parseIdentifiers(match[5], false, value);
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}

function parseIdentifiers(value, rejectNumericLeadingZero, fullVersion) {
  if (value === undefined) return null;
  const identifiers = value.split('.');
  if (identifiers.some(identifier =>
    !SEMVER_IDENTIFIER_PATTERN.test(identifier)
    || (rejectNumericLeadingZero && /^0\d+$/.test(identifier)))) {
    throw new Error(`invalid SemVer: ${fullVersion}`);
  }
  return identifiers;
}

function comparePrerelease(left, right) {
  if (left === null || right === null) {
    if (left === right) return 0;
    return left === null ? 1 : -1;
  }

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === undefined ? -1 : 1;
    }
    if (leftIdentifier === rightIdentifier) continue;

    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      const leftValue = BigInt(leftIdentifier);
      const rightValue = BigInt(rightIdentifier);
      return leftValue === rightValue ? 0 : leftValue > rightValue ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue);
  const right = parseSemver(rightValue);

  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] > right.core[index] ? 1 : -1;
    }
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function isValidSemver(value) {
  try {
    parseSemver(value);
    return true;
  } catch {
    return false;
  }
}

export function isBetaSemver(value) {
  try {
    const parsed = parseSemver(value);
    return parsed.prerelease?.[0] === 'beta';
  } catch {
    return false;
  }
}

export function isStableSemver(value) {
  try {
    return parseSemver(value).prerelease === null;
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, firstValue] = process.argv.slice(2);
    if (command === '--validate-beta') {
      if (!isBetaSemver(firstValue ?? '')) throw new Error(`invalid beta SemVer: ${firstValue ?? ''}`);
    } else if (command === '--validate-stable') {
      if (!isStableSemver(firstValue ?? '')) throw new Error(`invalid stable SemVer: ${firstValue ?? ''}`);
    } else {
      console.log(compareSemver(command ?? '', firstValue ?? ''));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
