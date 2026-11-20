import { describe, expect, it } from '@jest/globals';

import {
  PRODUCTION_DATABASE_NOT_CONFIGURED_DETAIL,
  WebConsoleProductionActivationError,
  assertWebConsoleProductionActivation,
  productionDatabaseNotVerified,
  type WebConsoleProductionActivationInputs,
} from '../../../src/web-console/index.js';

function activationError(inputs: Partial<WebConsoleProductionActivationInputs>): WebConsoleProductionActivationError {
  try {
    assertWebConsoleProductionActivation({
      activationProfile: 'shared-hosted',
      storageBackend: 'postgres',
      enableAccountAllowlistRoutes: false,
      stores: {},
      services: {},
      ...inputs,
    });
  } catch (error) {
    if (error instanceof WebConsoleProductionActivationError) return error;
    throw error;
  }
  throw new Error('activation unexpectedly succeeded');
}

function detailFor(error: WebConsoleProductionActivationError, code: string): string | undefined {
  return error.failures.find(failure => failure.code === code)?.detail;
}

describe('web console production activation messages', () => {
  it('puts every failure reason in the message an operator sees at start-up', () => {
    const error = activationError({ storageBackend: 'memory' });

    expect(error.failures.length).toBeGreaterThan(1);
    for (const failure of error.failures) {
      expect(error.message).toContain(`${failure.code}: ${failure.detail}`);
    }
    expect(error.message.startsWith('Web console production activation failed: ')).toBe(true);
  });

  it('names the variable to set when no expected database is configured', async () => {
    const snapshot = await productionDatabaseNotVerified().getReadiness();
    expect(snapshot).toEqual({
      ready: false,
      failureCodes: ['production_database_not_verified'],
      detail: PRODUCTION_DATABASE_NOT_CONFIGURED_DETAIL,
    });
    expect(snapshot.detail).toContain('Set DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_NAME');
    expect(snapshot.detail).toContain('DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_USER');

    const error = activationError({
      readiness: { databaseVerificationReady: false, databaseVerificationDetail: snapshot.detail },
    });
    expect(detailFor(error, 'database_verification_not_ready')).toBe(
      'Hosted/shared web-console activation requires verification of the intended PostgreSQL database and current ' +
      `migration state. ${PRODUCTION_DATABASE_NOT_CONFIGURED_DETAIL}`,
    );
  });

  it('carries the verifier finding through, such as missing tables', () => {
    const error = activationError({
      readiness: {
        databaseVerificationReady: false,
        databaseVerificationDetail: 'missing required tables: console_sessions (run the database migrations for this release)',
      },
    });
    expect(error.message).toContain(
      'database_verification_not_ready: Hosted/shared web-console activation requires verification of the intended ' +
      'PostgreSQL database and current migration state. missing required tables: console_sessions ' +
      '(run the database migrations for this release)',
    );
  });

  it('keeps the plain reason when the verifier gave no detail', () => {
    const error = activationError({ readiness: { databaseVerificationReady: false } });
    expect(detailFor(error, 'database_verification_not_ready')).toBe(
      'Hosted/shared web-console activation requires verification of the intended PostgreSQL database and current migration state.',
    );
  });

  it('does not report the database once it is verified', () => {
    const error = activationError({
      readiness: { databaseVerificationReady: true, databaseVerificationDetail: 'stale detail' },
    });
    expect(detailFor(error, 'database_verification_not_ready')).toBeUndefined();
    expect(error.message).not.toContain('stale detail');
  });

  it('names the storage settings when the console has no database', () => {
    const error = activationError({ storageBackend: 'memory' });
    expect(detailFor(error, 'database_required')).toContain('Set DOLLHOUSE_STORAGE_BACKEND=database and DOLLHOUSE_DATABASE_URL');
  });

  it('names the auth settings behind the allowlist cutover, and the switch that turns the routes off', () => {
    const error = activationError({ enableAccountAllowlistRoutes: true });
    const detail = detailFor(error, 'account_allowlist_authority_not_cut_over');
    expect(detail).toContain('DOLLHOUSE_AUTH_PROVIDER=embedded with DOLLHOUSE_AUTH_STORAGE_BACKEND=postgres');
    expect(detail).toContain('DOLLHOUSE_WEB_CONSOLE_ALLOWLIST_ROUTES_ENABLED=false');
    expect(detailFor(activationError({ enableAccountAllowlistRoutes: false }), 'account_allowlist_authority_not_cut_over'))
      .toBeUndefined();
  });
});
