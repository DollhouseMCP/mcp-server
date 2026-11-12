import { describe, expect, it, jest } from '@jest/globals';

import {
  consoleAllowlistIsSignInAuthority,
  describeAllowlistCutoverRefusal,
} from '../../../src/auth/embedded-as/allowlistGate.js';
import type { IAuthStorageLayer } from '../../../src/auth/embedded-as/storage/IAuthStorageLayer.js';
import {
  AllowlistCliError,
  chooseActor,
  StorageAllowlistCliTarget,
} from '../../../src/cli/allowlistAuthority.js';

const ALICE = { userId: '11111111-1111-4111-8111-111111111111', username: 'github_1001' };
const BOB = { userId: '22222222-2222-4222-8222-222222222222', username: 'github_1002' };

describe('consoleAllowlistIsSignInAuthority', () => {
  it.each([
    [true, 'embedded', 'postgres', true],
    [false, 'embedded', 'postgres', false],
    [true, 'oidc', 'postgres', false],
    [true, undefined, 'postgres', false],
    [true, 'embedded', 'filesystem', false],
    [true, 'embedded', undefined, false],
  ])('database=%s provider=%s storage=%s gives %s', (hasDatabase, authProvider, authStorageBackend, expected) => {
    expect(consoleAllowlistIsSignInAuthority({ hasDatabase, authProvider, authStorageBackend })).toBe(expected);
  });
});

describe('chooseActor', () => {
  it('uses the only console admin without being told', () => {
    expect(chooseActor([ALICE], undefined)).toBe(ALICE);
  });

  it('uses the admin named with --as', () => {
    expect(chooseActor([ALICE, BOB], 'github_1002')).toBe(BOB);
  });

  it('never guesses between several admins, and lists them', () => {
    expect(() => chooseActor([ALICE, BOB], undefined)).toThrow(AllowlistCliError);
    expect(() => chooseActor([ALICE, BOB], undefined))
      .toThrow('Say which admin you are with --as <username>. Active admins: github_1001, github_1002.');
  });

  it('refuses a name that is not an active console admin, and lists who is', () => {
    expect(() => chooseActor([ALICE], 'github_9999'))
      .toThrow("--as 'github_9999' is not an active console admin. Active admins: github_1001.");
  });

  it('says to designate the admin first when there is none', () => {
    expect(() => chooseActor([], undefined)).toThrow('Designate the admin first with dollhouse-admin-bootstrap');
    expect(() => chooseActor([], 'github_1001')).toThrow('There are no active console admins.');
  });
});

describe('describeAllowlistCutoverRefusal', () => {
  it('names each entry that differs and the commands that clear it', () => {
    expect(describeAllowlistCutoverRefusal([
      { kind: 'email', value: 'alice@example.com' },
      { kind: 'github_username', value: 'octocat' },
    ])).toBe(
      'Sign-in allowlist authority cutover refused: 2 entries in the earlier allowlist (auth_allowlist) are not in the ' +
      'allowlist sign-in uses (account_allowlist_entries): email alice@example.com; github_username octocat. ' +
      'Sign-in does not honour them, and the server will not start while they are there. ' +
      'Run `dollhouse-allowlist reconcile` to list them, then `dollhouse-allowlist reconcile --carry` to add them to the ' +
      'allowlist sign-in uses, or `dollhouse-allowlist reconcile --discard` to drop them. Either clears the earlier allowlist.',
    );
  });

  it('words one entry in the singular', () => {
    expect(describeAllowlistCutoverRefusal([{ kind: 'github_id', value: '42' }]))
      .toContain('1 entry in the earlier allowlist (auth_allowlist) is not in the allowlist sign-in uses (account_allowlist_entries): github_id 42.');
  });

  it('names the first twenty and counts the rest', () => {
    const many = Array.from({ length: 23 }, (_, index) => ({ kind: 'email' as const, value: `user${index}@example.com` }));
    const message = describeAllowlistCutoverRefusal(many);
    expect(message).toContain('23 entries');
    expect(message).toContain('email user19@example.com; and 3 more.');
    expect(message).not.toContain('user20@example.com');
  });

  it('keeps the phrase existing checks and operators search for', () => {
    expect(describeAllowlistCutoverRefusal([{ kind: 'email', value: 'a@example.com' }])).toMatch(/cutover refused/);
  });
});

describe('StorageAllowlistCliTarget', () => {
  it('works on the storage layer allowlist, recording the command as the author', async () => {
    const entry = { id: 'entry-1', kind: 'email' as const, value: 'alice@example.com', note: null, createdBy: 'cli', createdAt: new Date(0) };
    const storage = {
      allowlistList: jest.fn(() => Promise.resolve([entry])),
      allowlistAdd: jest.fn(() => Promise.resolve(entry)),
      allowlistUpdate: jest.fn(() => Promise.resolve(entry)),
      allowlistRemove: jest.fn(() => Promise.resolve(true)),
    };
    const target = new StorageAllowlistCliTarget(storage as unknown as IAuthStorageLayer);

    expect(await target.list()).toEqual([entry]);
    expect(await target.findByValue('email', '  Alice@Example.com ')).toBe(entry);
    expect(await target.findByValue('github_username', 'alice@example.com')).toBeNull();
    expect(await target.findByValue('email', 'nobody@example.com')).toBeNull();
    expect(await target.add({ kind: 'email', value: 'alice@example.com', note: 'founder' })).toBe(entry);
    expect(storage.allowlistAdd).toHaveBeenCalledWith({ kind: 'email', value: 'alice@example.com', note: 'founder', createdBy: 'cli' });
    expect(await target.updateNote('entry-1', null)).toBe(entry);
    expect(storage.allowlistUpdate).toHaveBeenCalledWith('entry-1', { note: null });
    expect(await target.remove('entry-1')).toBe(true);
    expect(storage.allowlistRemove).toHaveBeenCalledWith('entry-1');
  });
});
