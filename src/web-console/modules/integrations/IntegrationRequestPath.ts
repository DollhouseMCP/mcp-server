import { MAX_INTEGRATION_REQUEST_PATH_LENGTH } from '../../../config/integration-constants.js';

const CANONICALIZATION_ORIGIN = 'https://integration.invalid';

export interface CanonicalIntegrationRequestPath {
  readonly pathname: string;
  readonly search: string;
}

export class IntegrationRequestPathError extends Error {
  constructor(
    readonly code: 'invalid_integration_path' | 'integration_request_path_too_long',
    message: string,
    readonly status: 400 | 414,
  ) {
    super(message);
    this.name = 'IntegrationRequestPathError';
  }
}

export function canonicalizeIntegrationRequestPath(path: unknown): CanonicalIntegrationRequestPath {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') ||
      path.includes('\\') || path.includes('#') || hasUnsafeControlCharacter(path)) {
    throw invalidPath();
  }
  if (path.length > MAX_INTEGRATION_REQUEST_PATH_LENGTH) throw pathTooLong();

  let url: URL;
  try {
    url = new URL(path, CANONICALIZATION_ORIGIN);
  } catch {
    throw invalidPath();
  }
  if (url.origin !== CANONICALIZATION_ORIGIN || url.hash !== '') throw invalidPath();

  const canonicalLength = url.pathname.length + url.search.length;
  if (canonicalLength > MAX_INTEGRATION_REQUEST_PATH_LENGTH) throw pathTooLong();
  return { pathname: url.pathname, search: url.search };
}

function hasUnsafeControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))) {
      return true;
    }
  }
  return false;
}

function invalidPath(): IntegrationRequestPathError {
  return new IntegrationRequestPathError(
    'invalid_integration_path',
    'Integration request path must be an absolute path without a fragment.',
    400,
  );
}

function pathTooLong(): IntegrationRequestPathError {
  return new IntegrationRequestPathError(
    'integration_request_path_too_long',
    `Integration request path must be at most ${MAX_INTEGRATION_REQUEST_PATH_LENGTH} characters.`,
    414,
  );
}
