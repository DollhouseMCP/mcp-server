import { describe, expect, it } from '@jest/globals';

import {
  WEB_CONSOLE_SETUP_CHECKS,
  WEB_CONSOLE_SETUP_CHECK_IDS,
  isWebConsoleSetupCheckId,
  listWebConsoleSetupCheckStatuses,
  listWebConsoleSetupChecks,
  type WebConsoleSetupCheckResult,
} from '../../../../src/web-console/index.js';

const MIGRATIONS = 'production_database_migrations';
const SYNC = 'portfolio_sync_live_repository';

describe('web console setup check catalog', () => {
  it('lists the eleven checks in their established order', () => {
    expect(WEB_CONSOLE_SETUP_CHECK_IDS).toEqual([
      'production_database_migrations',
      'security_invalidation_multi_replica',
      'allowlist_authority_parity',
      'embedded_as_login_step_up',
      'account_invite_redemption',
      'oauth_grant_revocation',
      'github_integration_connect_callback',
      'portfolio_sync_live_repository',
      'signing_key_auth_policy_multi_replica',
      'approval_execution_projection',
      'audit_telemetry_projection',
    ]);
  });

  it('defines every check exactly once, keyed by its own ID', () => {
    expect(Object.keys(WEB_CONSOLE_SETUP_CHECKS).sort()).toEqual([...WEB_CONSOLE_SETUP_CHECK_IDS].sort());
    expect(new Set(WEB_CONSOLE_SETUP_CHECK_IDS).size).toBe(WEB_CONSOLE_SETUP_CHECK_IDS.length);
    expect(listWebConsoleSetupChecks().map(check => check.id)).toEqual([...WEB_CONSOLE_SETUP_CHECK_IDS]);
    for (const id of WEB_CONSOLE_SETUP_CHECK_IDS) {
      expect(WEB_CONSOLE_SETUP_CHECKS[id].id).toBe(id);
    }
  });

  it('gives every check a title, a meaning, a verification method and a remedy', () => {
    for (const check of listWebConsoleSetupChecks()) {
      for (const text of [check.title, check.proves, check.verifiedBy, check.remediation]) {
        expect(text.trim().length).toBeGreaterThan(10);
      }
    }
  });

  it('says how each check is verified', () => {
    const idsVerifiedBy = (verification: string) => listWebConsoleSetupChecks()
      .filter(check => check.verification === verification).map(check => check.id);
    expect(idsVerifiedBy('server-probe')).toEqual([
      'production_database_migrations',
      'security_invalidation_multi_replica',
      'allowlist_authority_parity',
      'audit_telemetry_projection',
    ]);
    expect(idsVerifiedBy('server-canary')).toEqual(['approval_execution_projection']);
    expect(idsVerifiedBy('usage-record')).toEqual([
      'embedded_as_login_step_up',
      'account_invite_redemption',
      'oauth_grant_revocation',
      'github_integration_connect_callback',
      'portfolio_sync_live_repository',
    ]);
    expect(idsVerifiedBy('not-verified')).toEqual(['signing_key_auth_policy_multi_replica']);
  });

  it('recognises only catalog IDs', () => {
    expect(isWebConsoleSetupCheckId(MIGRATIONS)).toBe(true);
    expect(isWebConsoleSetupCheckId('not_a_check')).toBe(false);
    for (const notAnId of [undefined, null, 42, {}, [MIGRATIONS], '']) {
      expect(isWebConsoleSetupCheckId(notAnId)).toBe(false);
    }
  });

  it('lists a check as pending until something reports on it, whatever its definition says', () => {
    const probed = listWebConsoleSetupChecks().filter(check => check.verification === 'server-probe');
    expect(probed.length).toBeGreaterThan(0);
    const statuses = listWebConsoleSetupCheckStatuses([]);
    for (const check of probed) {
      expect(statuses.find(status => status.definition.id === check.id)?.state).toBe('pending');
    }
  });
});

describe('listWebConsoleSetupCheckStatuses', () => {
  it('reports every check as pending when nothing has reported yet', () => {
    const statuses = listWebConsoleSetupCheckStatuses([]);
    expect(statuses.map(status => status.definition.id)).toEqual([...WEB_CONSOLE_SETUP_CHECK_IDS]);
    expect(statuses.every(status => status.state === 'pending')).toBe(true);
    expect(statuses.every(status => !('detail' in status))).toBe(true);
  });

  it('keeps catalog order whatever order the results arrive in', () => {
    const statuses = listWebConsoleSetupCheckStatuses([
      { id: SYNC, state: 'not_applicable' },
      { id: MIGRATIONS, state: 'passed' },
    ]);
    expect(statuses.map(status => status.definition.id)).toEqual([...WEB_CONSOLE_SETUP_CHECK_IDS]);
    expect(statuses.filter(status => status.state !== 'pending').map(status => [status.definition.id, status.state]))
      .toEqual([[MIGRATIONS, 'passed'], [SYNC, 'not_applicable']]);
  });

  it.each(['passed', 'pending', 'failed', 'not_applicable'] as const)('carries a %s result through with its definition', state => {
    const [first] = listWebConsoleSetupCheckStatuses([{ id: MIGRATIONS, state }]);
    expect(first).toEqual({ definition: WEB_CONSOLE_SETUP_CHECKS[MIGRATIONS], state });
  });

  it('carries the detail of a result and adds none of its own', () => {
    const statuses = listWebConsoleSetupCheckStatuses([
      { id: MIGRATIONS, state: 'failed', detail: 'two migrations are not applied' },
    ]);
    expect(statuses[0]).toEqual({
      definition: WEB_CONSOLE_SETUP_CHECKS[MIGRATIONS], state: 'failed', detail: 'two migrations are not applied',
    });
    expect(statuses[1]).not.toHaveProperty('detail');
  });

  it('rejects a result for an unknown check', () => {
    const unknown = { id: 'not_a_check', state: 'passed' } as unknown as WebConsoleSetupCheckResult;
    expect(() => listWebConsoleSetupCheckStatuses([unknown])).toThrow('Unknown web console setup check: not_a_check');
  });

  it('rejects two results for the same check', () => {
    expect(() => listWebConsoleSetupCheckStatuses([
      { id: MIGRATIONS, state: 'passed' },
      { id: MIGRATIONS, state: 'failed' },
    ])).toThrow(`Duplicate result for web console setup check: ${MIGRATIONS}`);
  });
});
