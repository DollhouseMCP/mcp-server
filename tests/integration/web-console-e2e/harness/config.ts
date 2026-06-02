/**
 * Resolves the web-console e2e harness configuration from the environment.
 *
 * When the suite auto-boots the app (the default), `globalSetup` populates these
 * variables. When developing against an already-running instance, export them
 * yourself (see tests/integration/web-console-e2e/README.md).
 */

export interface ConsoleE2eConfig {
  /** Public base URL the app is reachable at, e.g. http://localhost:3001 */
  readonly baseUrl: string;
  /** Superuser/admin Postgres connection to the isolated e2e database. */
  readonly databaseAdminUrl: string;
  /** The web-console opaque HMAC key (base64) used to hash session + CSRF values. */
  readonly opaqueHmacKey: Buffer;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `[console-e2e] missing required env var ${name}. ` +
        'Run via `npm run test:console-e2e` (which boots + provisions everything), ' +
        'or export the E2E_* vars to target a running instance.',
    );
  }
  return value.trim();
}

let cached: ConsoleE2eConfig | undefined;

export function getConfig(): ConsoleE2eConfig {
  if (cached) return cached;
  const opaqueB64 = required('E2E_OPAQUE_HMAC_KEY');
  cached = {
    baseUrl: (process.env.E2E_BASE_URL ?? 'http://localhost:3001').replace(/\/+$/, ''),
    databaseAdminUrl: required('E2E_DATABASE_ADMIN_URL'),
    opaqueHmacKey: Buffer.from(opaqueB64, 'base64'),
  };
  return cached;
}
