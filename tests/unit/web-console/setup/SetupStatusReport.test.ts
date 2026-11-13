import { describe, expect, it } from '@jest/globals';

import type { CanaryStatus } from '../../../../src/web-console/canary/CanaryMonitor.js';
import {
  buildSetupStatusReport,
  type SetupStatusSources,
} from '../../../../src/web-console/setup/SetupStatusReport.js';
import type { SetupUsageRecords } from '../../../../src/web-console/setup/SetupUsageRecords.js';
import { WEB_CONSOLE_SETUP_CHECK_IDS } from '../../../../src/web-console/setup/WebConsoleSetupChecks.js';

const NOW = new Date('2026-11-13T08:00:00.000Z');
const EARLIER = new Date('2026-11-12T17:30:00.000Z');
const NOT_YET = { happened: false, lastAt: null };

function usage(overrides: Partial<SetupUsageRecords> = {}): SetupUsageRecords {
  return {
    adminStepUp: () => Promise.resolve(NOT_YET),
    invitationAccepted: () => Promise.resolve(NOT_YET),
    credentialsRevoked: () => Promise.resolve(NOT_YET),
    githubConnected: () => Promise.resolve(NOT_YET),
    portfolioSyncSucceeded: () => Promise.resolve({ ...NOT_YET, repositoryName: null }),
    ...overrides,
  };
}

function sources(overrides: Partial<SetupStatusSources> = {}): SetupStatusSources {
  return {
    databaseMigrations: () => Promise.resolve({
      id: 'production_database_migrations', state: 'passed', code: 'migrations_applied', detail: 'All 61 migrations are applied.',
    }),
    securityInvalidation: () => Promise.resolve({ ready: true, failureCodes: [] }),
    allowlistParity: () => Promise.resolve({
      id: 'allowlist_authority_parity', state: 'passed', code: 'allowlists_agree', detail: 'Every earlier entry is carried.',
    } as Awaited<ReturnType<NonNullable<SetupStatusSources['allowlistParity']>>>),
    auditTelemetry: () => Promise.resolve({
      id: 'audit_telemetry_projection', state: 'passed', code: 'audit_telemetry_readable', detail: 'Audit and telemetry read.',
    } as Awaited<ReturnType<SetupStatusSources['auditTelemetry']>>),
    canary: () => ({ state: 'pending', code: 'canary_not_run', detail: 'The canary has not run.', lastRun: null }),
    usage: usage(),
    invitationsOffered: true,
    ...overrides,
  };
}

async function report(overrides: Partial<SetupStatusSources> = {}) {
  const built = await buildSetupStatusReport(sources(overrides), () => NOW);
  const byId = new Map(built.checks.map(check => [check.definition.id, check]));
  return { built, check: (id: string) => byId.get(id as never) };
}

describe('buildSetupStatusReport', () => {
  it('lists every check in catalog order, with the time it was read', async () => {
    const { built } = await report();

    expect(built.checkedAt).toEqual(NOW);
    expect(built.checks.map(check => check.definition.id)).toEqual([...WEB_CONSOLE_SETUP_CHECK_IDS]);
  });

  it('passes on what each server-run check found, in its own words', async () => {
    const { check } = await report();

    expect(check('production_database_migrations')).toMatchObject({ state: 'passed', detail: 'All 61 migrations are applied.' });
    expect(check('allowlist_authority_parity')).toMatchObject({ state: 'passed', detail: 'Every earlier entry is carried.' });
    expect(check('audit_telemetry_projection')).toMatchObject({ state: 'passed', detail: 'Audit and telemetry read.' });
    expect(check('security_invalidation_multi_replica')).toMatchObject({
      state: 'passed',
      detail: 'This replica holds its lease and has no security changes waiting. Other replicas report for themselves.',
    });
  });

  it('reports a failed probe as failed', async () => {
    const { check } = await report({
      databaseMigrations: () => Promise.resolve({
        id: 'production_database_migrations', state: 'failed', code: 'migrations_incomplete', detail: 'Migration 0061 is missing.',
      }),
    });

    expect(check('production_database_migrations')).toMatchObject({ state: 'failed', detail: 'Migration 0061 is missing.' });
  });

  it('says a check does not apply where its subject does not exist', async () => {
    const { check } = await report({ databaseMigrations: null, allowlistParity: null, canary: null, invitationsOffered: false });

    expect(check('production_database_migrations')).toMatchObject({
      state: 'not_applicable', detail: 'This deployment has no database, so there is nothing to read.',
    });
    expect(check('allowlist_authority_parity')).toMatchObject({
      state: 'not_applicable', detail: 'This deployment has one sign-in allowlist, so there is nothing to compare.',
    });
    expect(check('approval_execution_projection')).toMatchObject({
      state: 'not_applicable',
      detail: 'This deployment has no database, so there are no per-session stores for the canary to check.',
    });
    expect(check('account_invite_redemption')).toMatchObject({
      state: 'not_applicable', detail: 'This deployment does not offer invitations that are recorded when accepted.',
    });
  });

  it('never claims the cross-replica key check, which nothing verifies yet', async () => {
    const { check } = await report();

    expect(check('signing_key_auth_policy_multi_replica')).toMatchObject({
      state: 'pending', detail: 'The server does not compare replicas yet, so this is not verified.',
    });
  });

  describe('the replica\'s security changes', () => {
    it.each([
      [['security_invalidation_processor_not_ready'], 'failed', 'the processor that applies security changes is not running on this replica'],
      [['security_invalidation_replica_lease_not_live'], 'failed', 'this replica does not hold a live lease'],
      // Work in hand, not a fault.
      [['security_invalidation_events_pending'], 'pending', 'security changes are waiting to be applied on this replica'],
      [['security_invalidation_check_failed'], 'pending', 'the check itself could not run'],
    ] as const)('reads %j as %s', async (failureCodes, state, reason) => {
      const { check } = await report({ securityInvalidation: () => Promise.resolve({ ready: false, failureCodes: [...failureCodes] }) });

      expect(check('security_invalidation_multi_replica')).toMatchObject({ state, detail: `Not ready on this replica: ${reason}.` });
    });

    it('is failed when a fault and work in hand are both reported', async () => {
      const { check } = await report({
        securityInvalidation: () => Promise.resolve({
          ready: false,
          failureCodes: ['security_invalidation_events_pending', 'security_invalidation_replica_lease_not_live'],
        }),
      });

      expect(check('security_invalidation_multi_replica')).toMatchObject({
        state: 'failed',
        detail: 'Not ready on this replica: security changes are waiting to be applied on this replica; this replica does not hold a live lease.',
      });
    });
  });

  describe('the canary', () => {
    it('is pending, not failed, before it has run', async () => {
      const { check } = await report();

      const canary = check('approval_execution_projection');
      expect(canary).toMatchObject({ state: 'pending', detail: 'The canary has not run.' });
      expect(canary).not.toHaveProperty('observedAt');
    });

    it('carries the last run\'s finding and when it finished', async () => {
      const status: CanaryStatus = {
        state: 'failed',
        code: 'canary_approval_not_readable',
        detail: 'The console did not list the approval request.',
        lastRun: {
          result: { id: 'approval_execution_projection', state: 'failed', code: 'canary_approval_not_readable', detail: 'x' },
          trigger: 'admin', startedAt: EARLIER, finishedAt: EARLIER,
        },
      };
      const { check } = await report({ canary: () => status });

      expect(check('approval_execution_projection')).toEqual(expect.objectContaining({
        state: 'failed', detail: 'The console did not list the approval request.', observedAt: EARLIER,
      }));
    });
  });

  describe('checks that are true once somebody has done the thing', () => {
    it('are pending, never failed, until it has been done', async () => {
      const { check } = await report();

      expect(check('embedded_as_login_step_up')).toMatchObject({ state: 'pending', detail: 'No administrator has elevated with a one-time code yet.' });
      expect(check('account_invite_redemption')).toMatchObject({ state: 'pending', detail: 'No invitation has been accepted yet.' });
      expect(check('oauth_grant_revocation')).toMatchObject({ state: 'pending', detail: 'No account\'s credentials have been revoked yet.' });
      expect(check('github_integration_connect_callback')).toMatchObject({ state: 'pending', detail: 'No account has GitHub connected.' });
      expect(check('portfolio_sync_live_repository')).toMatchObject({ state: 'pending', detail: 'No portfolio sync has succeeded yet.' });
    });

    it('pass once the record exists, with when it last happened', async () => {
      const done = { happened: true, lastAt: EARLIER };
      const { check } = await report({
        usage: usage({
          adminStepUp: () => Promise.resolve(done),
          invitationAccepted: () => Promise.resolve(done),
          credentialsRevoked: () => Promise.resolve(done),
          githubConnected: () => Promise.resolve(done),
          portfolioSyncSucceeded: () => Promise.resolve({ ...done, repositoryName: 'dollhouse-portfolio' }),
        }),
      });

      for (const id of ['embedded_as_login_step_up', 'account_invite_redemption', 'oauth_grant_revocation', 'github_integration_connect_callback']) {
        expect(check(id)).toMatchObject({ state: 'passed', observedAt: EARLIER });
      }
      expect(check('portfolio_sync_live_repository')).toMatchObject({
        state: 'passed',
        detail: 'A portfolio sync with an account\'s dollhouse-portfolio repository has succeeded.',
        observedAt: EARLIER,
      });
    });

    it('says so when a sync succeeded before its repository name was recorded', async () => {
      const { check } = await report({
        usage: usage({ portfolioSyncSucceeded: () => Promise.resolve({ happened: true, lastAt: null, repositoryName: null }) }),
      });

      const sync = check('portfolio_sync_live_repository');
      expect(sync).toMatchObject({
        state: 'passed',
        detail: 'A portfolio sync has succeeded. Its repository name was not recorded, because the sync ran on a version from before that was added.',
      });
      expect(sync).not.toHaveProperty('observedAt');
    });

    it('are pending without a database, because there are no records to read', async () => {
      const { check } = await report({ usage: null });

      expect(check('embedded_as_login_step_up')).toMatchObject({
        state: 'pending', detail: 'This deployment has no database, so there is nothing to read.',
      });
    });
  });

  it('leaves one check pending when its source fails, without the driver\'s words, and still reports the rest', async () => {
    const { check, built } = await report({
      auditTelemetry: () => Promise.reject(new Error('connect ECONNREFUSED db.internal.example:5432 user=dollhouse_app')),
      usage: usage({
        githubConnected: () => Promise.reject(Object.assign(new Error('relation "user_integrations" does not exist'), { code: '42P01' })),
      }),
    });

    expect(check('audit_telemetry_projection')).toEqual(expect.objectContaining({
      state: 'pending', detail: 'This could not be checked just now (an unexpected error), so nothing is verified.',
    }));
    expect(check('github_integration_connect_callback')).toEqual(expect.objectContaining({
      state: 'pending', detail: 'This could not be checked just now (error 42P01), so nothing is verified.',
    }));
    expect(built.checks).toHaveLength(WEB_CONSOLE_SETUP_CHECK_IDS.length);
    expect(check('production_database_migrations')).toMatchObject({ state: 'passed' });
  });
});
