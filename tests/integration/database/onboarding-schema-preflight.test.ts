import { sql } from 'drizzle-orm';
import { assertOnboardingSchemaReady } from '../../../src/invitations/onboarding/OnboardingSchemaPreflight.js';
import { closeTestDb, getTestAdminDb, isDatabaseAvailable } from './test-db-helpers.js';

let available = false;
beforeAll(async () => {
  available = await isDatabaseAvailable();
  if (!available && process.env.DOLLHOUSE_REQUIRE_TEST_DATABASE === '1') throw new Error('Required PostgreSQL unavailable');
});
afterAll(closeTestDb);

it('accepts migrated schema without modifying invitation, owner-session, or audit data', async () => {
  if (!available) return;
  const db = getTestAdminDb();
  await db.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await expect(assertOnboardingSchemaReady(tx)).resolves.toBeUndefined();
  });
});

it.each(['account_invitations', 'account_invitation_generations', 'account_invitation_intended_roles',
  'account_invitation_claim_assertions', 'account_invitation_delivery_attempts', 'auth_kv', 'security_audit_events'])('rejects an unavailable %s relation with a fixed diagnostic', async table => {
  if (!available) return;
  const db = getTestAdminDb();
  const rollback = new Error('rollback schema test');
  await expect(db.transaction(async tx => {
    await tx.execute(sql`ALTER TABLE ${sql.identifier(table)} RENAME TO ${sql.identifier(`${table}_preflight_hidden`)}`);
    await expect(assertOnboardingSchemaReady(tx)).rejects.toThrow('Private beta onboarding database schema is unavailable.');
    throw rollback;
  })).rejects.toBe(rollback);
  await expect(assertOnboardingSchemaReady(db)).resolves.toBeUndefined();
});

it.each([
  ['users', 'activation_state'], ['account_invitations', 'current_generation'],
  ['account_invitation_generations', 'credential_hash'], ['account_invitation_intended_roles', 'role'],
  ['account_invitation_claim_assertions', 'claim_owner_hash'], ['account_invitation_delivery_attempts', 'state'],
  ['auth_kv', 'payload'], ['security_audit_events', 'metadata'],
])('rejects missing required column %s.%s and accepts it after rollback', async (table, column) => {
  if (!available) return;
  const db = getTestAdminDb();
  const rollback = new Error('rollback column test');
  await expect(db.transaction(async tx => {
    await tx.execute(sql`ALTER TABLE ${sql.identifier(table)} RENAME COLUMN ${sql.identifier(column)} TO preflight_hidden_column`);
    await expect(assertOnboardingSchemaReady(tx)).rejects.toThrow('Private beta onboarding database schema is unavailable.');
    throw rollback;
  })).rejects.toBe(rollback);
  await expect(assertOnboardingSchemaReady(db)).resolves.toBeUndefined();
});
