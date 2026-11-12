/**
 * First admin on a GitHub-only install: the account the installer designates
 * becomes the admin by signing in. No code is printed or entered.
 *
 * The installer's bootstrap-admin step runs `dollhouse-admin-bootstrap`, which
 * resolves the designated GitHub username to its numeric ID once and then does
 * the three things `designateFirstAdmin` does below. Everything after that is
 * the real authorization server and console login; only upstream GitHub is fake.
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomInt, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

import { recordBootstrapCompleted } from '../../../src/auth/embedded-as/bootstrapAdmin.js';
import type { DatabaseInstance } from '../../../src/database/connection.js';
import { users } from '../../../src/database/schema/users.js';
import { provisionConsoleAdmin } from '../../../src/web-console/identity/provisionConsoleAdmin.js';
import { ordinaryGithubConsole } from '../../helpers/web-console/ordinaryGithubLogin.js';
import { closeTestDb, getTestAdminDb } from './test-db-helpers.js';

const required = process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1' ? describe : describe.skip;
const DESIGNATED_LOGIN = 'installer-designated-admin';
const ALL_ADMIN_CAPABILITIES = [
  'console:admin:accounts', 'console:admin:audit', 'console:admin:operate', 'console:admin:security',
];

type Console = Awaited<ReturnType<typeof ordinaryGithubConsole>>;

/** What `dollhouse-admin-bootstrap --method github --github-id <id>` does. */
async function designateFirstAdmin(db: DatabaseInstance, storage: Console['storage'], githubId: number) {
  const sub = `github_${githubId}`;
  await storage.markBootstrapComplete(sub, 'github');
  await recordBootstrapCompleted(storage, sub, 'github', 'admin-bootstrap-cli');
  return provisionConsoleAdmin(db, sub);
}

required('first admin by designated GitHub account', () => {
  const db = () => getTestAdminDb();
  const designatedId = randomInt(1, 2 ** 48 - 1);
  const impostorId = randomInt(1, 2 ** 48 - 1);
  const consoles: Console[] = [];
  let savedBootstrapState: unknown;

  async function open(githubId: number): Promise<Console> {
    const opened = await ordinaryGithubConsole(db(), githubId, `${randomUUID()}@provider.test`,
      { githubLogin: DESIGNATED_LOGIN, skipAutoBootstrap: true });
    consoles.push(opened);
    return opened;
  }

  beforeAll(async () => {
    // The bootstrap state is one row for the whole database. Start unclaimed,
    // and put back whatever another suite left once this one is done.
    const rows = await db().execute(sql`SELECT payload FROM auth_kv WHERE model = 'AuthBootstrap' AND id = 'state'`) as
      unknown as Array<{ payload: unknown }>;
    savedBootstrapState = rows.at(0)?.payload;
    await db().execute(sql`DELETE FROM auth_kv WHERE model = 'AuthBootstrap' AND id = 'state'`);
  });

  afterAll(async () => {
    for (const opened of consoles) await opened.close();
    await db().execute(sql`DELETE FROM auth_kv WHERE model = 'AuthBootstrap' AND id = 'state'`);
    if (savedBootstrapState !== undefined) {
      await db().execute(sql`
        INSERT INTO auth_kv (model, id, payload) VALUES ('AuthBootstrap', 'state', ${JSON.stringify(savedBootstrapState)}::jsonb)
      `);
    }
    await db().delete(users).where(eq(users.username, `github_${designatedId}`));
    await closeTestDb();
  });

  it('refuses every sign-in while no admin has been designated', async () => {
    const fresh = await open(designatedId);
    expect(await fresh.storage.getBootstrapState()).toEqual({ completed: false });
    await expect(fresh.login(true)).rejects.toThrow('Authorize status 503');
    expect(fresh.providerCalls).toEqual([]);
  });

  it('makes the designated account the admin on its first sign-in, with nothing elevated', async () => {
    const designated = await open(designatedId);
    const provisioned = await designateFirstAdmin(db(), designated.storage, designatedId);
    expect(await designated.storage.getBootstrapState()).toMatchObject({
      completed: true, adminSub: `github_${designatedId}`, adminMethod: 'github',
    });

    // The sign-in allowlist is required and this account is on no list: the
    // designated admin is admitted because it is the designated admin.
    const login = await designated.login(true);
    expect(login.me.status).toBe(200);
    expect(login.session).toBeTruthy();
    const me = await login.me.json() as {
      user_id: string; auth_sub: string; granted_capabilities: string[];
      available_admin_capabilities: string[]; elevation: { active: boolean };
    };
    expect(me).toMatchObject({
      user_id: provisioned.userId,
      auth_sub: `github_${designatedId}`,
      granted_capabilities: ['console:self'],
      elevation: { active: false },
    });
    expect([...me.available_admin_capabilities].sort()).toEqual(ALL_ADMIN_CAPABILITIES);
  });

  it('matches on the GitHub account ID: another account using the same login name is refused', async () => {
    const impostor = await open(impostorId);
    // The fake GitHub reports the designated login name for a different account ID.
    await expect(impostor.login(true)).rejects.toThrow(/GitHub callback status 40[13]/);
    expect(impostor.providerCalls).toContain('https://api.github.com/user');

    const rows = await db().select({ id: users.id }).from(users).where(eq(users.username, `github_${impostorId}`));
    expect(rows).toEqual([]);
  });

  it('cannot be claimed a second time for a different account, and the first admin is unchanged', async () => {
    const [first, second] = [consoles[0], consoles.at(-1)!];
    await expect(second.storage.markBootstrapComplete(`github_${impostorId}`, 'github'))
      .rejects.toThrow('admin transfer is a separate operation');
    expect(await first.storage.getBootstrapState()).toMatchObject({ completed: true, adminSub: `github_${designatedId}` });
  });

  it('accepts a repeated claim for the same account and keeps the same admin and role', async () => {
    const storage = consoles[0].storage;
    await expect(storage.markBootstrapComplete(`github_${designatedId}`, 'github')).resolves.toBeUndefined();
    expect(await storage.getBootstrapState()).toMatchObject({
      completed: true, adminSub: `github_${designatedId}`, adminMethod: 'github',
    });
    expect(await provisionConsoleAdmin(db(), `github_${designatedId}`)).toMatchObject({ created: false, roleGranted: false });
  });

  it('settles on one admin when two replicas claim at the same moment', async () => {
    // Clears the claim made earlier so the two can race for an unclaimed
    // server. From here on the admin is whichever won, so the cases above must
    // stay above; the audit case below looks only at the earlier claim's entry.
    await db().execute(sql`DELETE FROM auth_kv WHERE model = 'AuthBootstrap' AND id = 'state'`);
    const [a, b] = [consoles[0].storage, consoles.at(-1)!.storage];
    const outcomes = await Promise.allSettled([
      a.markBootstrapComplete(`github_${designatedId}`, 'github'),
      b.markBootstrapComplete(`github_${impostorId}`, 'github'),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const state = await a.getBootstrapState();
    expect(state.completed).toBe(true);
    expect([`github_${designatedId}`, `github_${impostorId}`]).toContain(state.adminSub);
    const winner = outcomes[0].status === 'fulfilled' ? `github_${designatedId}` : `github_${impostorId}`;
    expect(state.adminSub).toBe(winner);
  });

  it('leaves an audit entry naming the account and how it was designated', async () => {
    const events = await consoles[0].storage.listIdentityEvents({ type: 'auth.bootstrap.completed' });
    expect(events.filter(event => event.sub === `github_${designatedId}`)).toEqual([
      expect.objectContaining({
        type: 'auth.bootstrap.completed',
        sub: `github_${designatedId}`,
        details: { method: 'github', via: 'admin-bootstrap-cli' },
      }),
    ]);
  });
});
