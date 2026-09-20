/**
 * Shared browser/API contract for local-account names.
 *
 * Display names preserve human spelling after NFC normalization and trimming.
 * Usernames are lowercase NFC identifiers. Derivation maps each run of
 * whitespace or punctuation to one hyphen, retains Unicode letters/numbers
 * and their combining marks, and never truncates an overlong result.
 */

export const MAX_LOCAL_DISPLAY_NAME_CODE_POINTS = 255;
export const MAX_LOCAL_USERNAME_CODE_POINTS = 64;

const USERNAME_PATTERN = /^[\p{L}\p{N}_][\p{L}\p{M}\p{N}_-]*$/u;
const USERNAME_BASE_CHARACTER = /^[\p{L}\p{N}]$/u;
const USERNAME_MARK = /^\p{M}$/u;
const UNSAFE_DISPLAY_CHARACTER = /\p{C}/u;

export class LocalAccountNameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LocalAccountNameError';
  }
}

/** @param {unknown} value */
export function normalizeLocalDisplayName(value) {
  if (typeof value !== 'string') throw new LocalAccountNameError('display_name must be a string.');
  const normalized = value.normalize('NFC').trim();
  if (normalized === '') throw new LocalAccountNameError('display_name must be non-empty.');
  if ([...normalized].length > MAX_LOCAL_DISPLAY_NAME_CODE_POINTS) {
    throw new LocalAccountNameError(
      `display_name must be at most ${MAX_LOCAL_DISPLAY_NAME_CODE_POINTS} characters.`,
    );
  }
  if (UNSAFE_DISPLAY_CHARACTER.test(normalized)) {
    throw new LocalAccountNameError('display_name must not contain control or formatting characters.');
  }
  return normalized;
}

/** @param {unknown} value */
export function normalizeLocalUsername(value) {
  if (typeof value !== 'string') throw new LocalAccountNameError('username must be a string.');
  const normalized = value.normalize('NFC').trim().toLowerCase().normalize('NFC');
  if (normalized === '') throw new LocalAccountNameError('username must be non-empty.');
  if ([...normalized].length > MAX_LOCAL_USERNAME_CODE_POINTS) {
    throw new LocalAccountNameError(
      `username must be at most ${MAX_LOCAL_USERNAME_CODE_POINTS} characters.`,
    );
  }
  if (!USERNAME_PATTERN.test(normalized)) {
    throw new LocalAccountNameError(
      'username must use Unicode letters, marks, numbers, hyphens, or underscores and cannot start with a hyphen.',
    );
  }
  let markHasBase = false;
  for (const character of normalized) {
    if (USERNAME_MARK.test(character) && !markHasBase) {
      throw new LocalAccountNameError('username combining marks must follow a Unicode letter or number.');
    }
    markHasBase = USERNAME_BASE_CHARACTER.test(character) ||
      (markHasBase && USERNAME_MARK.test(character));
  }
  return normalized;
}

/** @param {unknown} value */
export function deriveLocalUsername(value) {
  const displayName = normalizeLocalDisplayName(value).toLowerCase().normalize('NFC');
  let derived = '';
  let needsSeparator = false;
  for (const character of displayName) {
    if (USERNAME_BASE_CHARACTER.test(character)) {
      if (needsSeparator && derived !== '') derived += '-';
      derived += character;
      needsSeparator = false;
    } else if (!needsSeparator && derived !== '' && USERNAME_MARK.test(character)) {
      derived += character;
    } else if (derived !== '') {
      needsSeparator = true;
    }
  }
  if (derived === '') {
    throw new LocalAccountNameError('display_name must contain at least one Unicode letter or number.');
  }
  return normalizeLocalUsername(derived);
}
