import { createHash } from 'node:crypto';
import os from 'node:os';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

/** Session ID validation: must start with a letter, then alphanumeric/hyphens/underscores, 1-64 chars */
export const SESSION_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
const DERIVED_SESSION_PREFIX = 'local';
const DERIVED_SESSION_HASH_LENGTH = 10;

export interface SessionIdentity {
  sessionId: string;
  runtimeSessionId: string;
  source: 'env' | 'derived';
}

interface ResolveSessionIdentityOptions {
  envValue?: string;
  cwd?: string;
  homeDir?: string;
  pid?: number;
}

function normalizeIdentityPart(value: string): string {
  return UnicodeValidator.normalize(value).normalizedContent.trim();
}

function deriveSessionId(cwd: string, homeDir: string): string {
  const seed = `${normalizeIdentityPart(homeDir)}\u0000${normalizeIdentityPart(cwd)}`;
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, DERIVED_SESSION_HASH_LENGTH);
  return `${DERIVED_SESSION_PREFIX}-${hash}`;
}

/**
 * Resolve the stable Dollhouse session identity and the live runtime session
 * identifier for the current process. When a host provides
 * `DOLLHOUSE_SESSION_ID`, that explicit identity is used everywhere. When it
 * does not, we derive a restart-stable workspace identity and add a PID suffix
 * for the live runtime identity so concurrent unnamed sessions do not collide
 * in the console registry.
 */
export function resolveSessionIdentity(
  options: ResolveSessionIdentityOptions = {},
): SessionIdentity {
  const envValue = options.envValue ?? process.env.DOLLHOUSE_SESSION_ID;
  const normalizedEnvValue = typeof envValue === 'string' ? normalizeIdentityPart(envValue) : '';
  if (normalizedEnvValue && SESSION_ID_PATTERN.test(normalizedEnvValue)) {
    return {
      sessionId: normalizedEnvValue,
      runtimeSessionId: normalizedEnvValue,
      source: 'env',
    };
  }

  const derivedSessionId = deriveSessionId(
    options.cwd ?? process.cwd(),
    options.homeDir ?? os.homedir(),
  );
  const pidSuffix = (options.pid ?? process.pid).toString(36);
  return {
    sessionId: derivedSessionId,
    runtimeSessionId: `${derivedSessionId}-${pidSuffix}`,
    source: 'derived',
  };
}
