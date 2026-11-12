import { describe, expect, it, jest } from '@jest/globals';

import {
  compareAllowlistParity,
  probeAllowlistParity,
} from '../../../../src/web-console/setup/AllowlistParityProbe.js';

const email = (value: string) => ({ kind: 'email' as const, value });
const username = (value: string) => ({ kind: 'github_username' as const, value });
const githubId = (value: string) => ({ kind: 'github_id' as const, value });

describe('compareAllowlistParity', () => {
  it('passes when the earlier allowlist is empty, whatever the console holds', () => {
    expect(compareAllowlistParity([], [email('alice@example.com')])).toEqual({
      id: 'allowlist_authority_parity', state: 'passed', code: 'allowlists_agree',
      detail: 'The earlier sign-in allowlist is empty, so there is nothing to carry over.',
    });
  });

  it('passes when every earlier entry is in the allowlist sign-in uses', () => {
    const earlier = [email('alice@example.com'), username('octocat'), githubId('42')];
    const authority = [...earlier, email('added-in-console@example.com')];
    expect(compareAllowlistParity(earlier, authority)).toEqual({
      id: 'allowlist_authority_parity', state: 'passed', code: 'allowlists_agree',
      detail: 'All 3 entries in the earlier sign-in allowlist are in the allowlist sign-in uses.',
    });
  });

  it('treats emails and usernames as the same entry regardless of case, as start-up does', () => {
    expect(compareAllowlistParity(
      [email('Alice@Example.com'), username('OctoCat')],
      [email('alice@example.com'), username('octocat')],
    ).state).toBe('passed');
  });

  it('does not treat an entry of one kind as carried by the same value of another kind', () => {
    expect(compareAllowlistParity([username('42')], [githubId('42')]).state).toBe('failed');
  });

  it('fails with counts by kind, and says what it means for sign-in and for the next restart', () => {
    const result = compareAllowlistParity(
      [email('alice@example.com'), email('bob@example.com'), username('octocat'), githubId('42'), email('carried@example.com')],
      [email('carried@example.com')],
    );
    expect(result).toEqual({
      id: 'allowlist_authority_parity', state: 'failed', code: 'allowlist_entries_not_carried_over',
      detail: '4 of 5 entries in the earlier sign-in allowlist are not in the allowlist sign-in uses ' +
        '(2 by email, 1 by GitHub username, 1 by GitHub ID). Sign-in does not honour them, and this server will ' +
        'refuse to start at its next restart until the two lists agree. ' +
        'Add them in the console, or remove them from the earlier list with dollhouse-allowlist.',
    });
  });

  it('never names the identities, which are personal data', () => {
    const result = compareAllowlistParity([email('alice@example.com'), username('octocat')], []);
    expect(result.detail).not.toContain('alice');
    expect(result.detail).not.toContain('octocat');
  });
});

describe('probeAllowlistParity', () => {
  it('reads each list once and compares them', async () => {
    const listEarlier = jest.fn(() => Promise.resolve([email('alice@example.com')]));
    const listAuthority = jest.fn(() => Promise.resolve([email('alice@example.com')]));
    await expect(probeAllowlistParity({ listEarlier, listAuthority })).resolves.toMatchObject({ state: 'passed' });
    expect(listEarlier).toHaveBeenCalledTimes(1);
    expect(listAuthority).toHaveBeenCalledTimes(1);
  });

  it('reports a gap found on a running server', async () => {
    await expect(probeAllowlistParity({
      listEarlier: () => Promise.resolve([email('alice@example.com')]),
      listAuthority: () => Promise.resolve([]),
    })).resolves.toMatchObject({ state: 'failed', code: 'allowlist_entries_not_carried_over' });
  });

  it.each([
    ['the earlier list', true],
    ['the list sign-in uses', false],
  ])('reports pending, not failed, when %s cannot be read', async (_label, earlierFails) => {
    const failure = Object.assign(new Error('permission denied for table auth_allowlist'), { code: '42501' });
    const result = await probeAllowlistParity({
      listEarlier: () => earlierFails ? Promise.reject(failure) : Promise.resolve([]),
      listAuthority: () => earlierFails ? Promise.resolve([]) : Promise.reject(failure),
    });
    expect(result).toEqual({
      id: 'allowlist_authority_parity', state: 'pending', code: 'allowlists_unreadable',
      detail: 'The sign-in allowlists could not be read (error 42501), so whether they agree is not verified.',
    });
  });

  it('never puts the driver message in the result, since it can carry connection details', async () => {
    const result = await probeAllowlistParity({
      listEarlier: () => Promise.reject(new Error('connect ECONNREFUSED db.internal.example:5432 user=dollhouse_app')),
      listAuthority: () => Promise.resolve([]),
    });
    expect(result.detail).toBe('The sign-in allowlists could not be read (the store did not answer), so whether they agree is not verified.');
  });
});
