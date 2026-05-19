/**
 * isBootstrapAdminFor — unit tests for the predicate that gates
 * `setAccountRoles(['admin'])` in all three IAuthMethod implementations.
 *
 * Round 6 review fixup: prior cycles only exercised the predicate
 * end-to-end via OAuth flow integration tests. If the AND of (completed,
 * sub match, methodId match) ever regressed silently — e.g., the
 * methodId comparison flipped, or `bootstrap.adminMethod` got dropped
 * from the read — only one of the three methods would happen to fail
 * its E2E test. The predicate is the single source of truth; it gets
 * its own coverage.
 *
 * Branches enumerated:
 *   1. completed = false → false (regardless of sub/method)
 *   2. completed = true, sub matches, method matches → true
 *   3. completed = true, sub mismatches → false
 *   4. completed = true, sub matches, method mismatches → false
 *   5. completed = true with `adminMethod` undefined (legacy state) → false
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  isBootstrapAdminFor,
  recordBootstrapCompleted,
} from '../../../../src/auth/embedded-as/bootstrapAdmin.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';

describe('isBootstrapAdminFor', () => {
  let storage: InMemoryAuthStorageLayer;

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
  });

  it('returns false when bootstrap is not yet completed', async () => {
    // Default bootstrap state is { completed: false }.
    expect(await isBootstrapAdminFor(storage, 'local_admin', 'local-password')).toBe(false);
    expect(await isBootstrapAdminFor(storage, 'github_42', 'github')).toBe(false);
    expect(await isBootstrapAdminFor(storage, 'magic-link_xyz', 'magic-link')).toBe(false);
  });

  it('returns true when sub AND method both match the recorded bootstrap', async () => {
    await storage.markBootstrapComplete('local_admin', 'local-password');
    expect(await isBootstrapAdminFor(storage, 'local_admin', 'local-password')).toBe(true);
  });

  it('returns false when sub mismatches (different identity claiming admin)', async () => {
    await storage.markBootstrapComplete('local_admin', 'local-password');
    // Same method, wrong sub.
    expect(await isBootstrapAdminFor(storage, 'local_attacker', 'local-password')).toBe(false);
  });

  it('returns false when method mismatches (cross-method identity collision)', async () => {
    // Operator pre-claimed via magic-link. A GitHub login that happens
    // to land on a sub of the same shape (synthetic example: numeric
    // string) must NOT be promoted.
    await storage.markBootstrapComplete('local_admin', 'magic-link');
    expect(await isBootstrapAdminFor(storage, 'local_admin', 'local-password')).toBe(false);
    expect(await isBootstrapAdminFor(storage, 'local_admin', 'github')).toBe(false);
  });

  it('returns true ONLY when both sub and method match — exhaustive triple-axis check', async () => {
    await storage.markBootstrapComplete('github_99', 'github');
    // Match on both axes.
    expect(await isBootstrapAdminFor(storage, 'github_99', 'github')).toBe(true);
    // Match on sub, mismatch on method.
    expect(await isBootstrapAdminFor(storage, 'github_99', 'local-password')).toBe(false);
    expect(await isBootstrapAdminFor(storage, 'github_99', 'magic-link')).toBe(false);
    // Mismatch on sub, match on method.
    expect(await isBootstrapAdminFor(storage, 'github_42', 'github')).toBe(false);
    // Mismatch on both.
    expect(await isBootstrapAdminFor(storage, 'local_other', 'local-password')).toBe(false);
  });

  it('treats a bootstrap state with completed=true but adminMethod=undefined as not-admin', async () => {
    // Defensive — if storage somehow returns a partial state (legacy
    // record, manual SQL hack, malformed JSON in K/V), the predicate
    // must NOT silently grant admin.
    const partialStorage = new InMemoryAuthStorageLayer();
    // Bypass markBootstrapComplete and inject a partial state directly
    // through the K/V API. (InMemory has bootstrapState as a field, so
    // mutate via the public surface markBootstrapComplete then drop
    // adminMethod via a cast — equivalent to a corrupt read.)
    await partialStorage.markBootstrapComplete('local_admin', 'local-password');
    // Mutate the cached state to drop adminMethod (simulating a
    // hand-edited filesystem JSON or a malformed Postgres payload).
    const stateField = (partialStorage as unknown as {
      bootstrapState: { completed: boolean; adminSub?: string; adminMethod?: string };
    }).bootstrapState;
    delete stateField.adminMethod;
    // Now the predicate must refuse promotion.
    expect(await isBootstrapAdminFor(partialStorage, 'local_admin', 'local-password')).toBe(false);
  });
});

describe('cycle 19 / test-M1 + cycle 22: recordBootstrapCompleted helper', () => {
  let storage: InMemoryAuthStorageLayer;

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
  });

  // Cycle 22: both CLIs (admin-bootstrap.ts and create-user.ts) now
  // route through `recordBootstrapCompleted`. Testing the helper
  // directly pins the contract that BOTH CLI invocations share.
  // Cycle-21 test-coverage MEDIUM caught that the prior tests
  // verified storage shape only — they wouldn't catch a regression
  // deleting the call from a CLI. Routing through one helper means
  // a regression in one place is detectable.

  it('records auth.bootstrap.completed with method + via + sub + timestamp', async () => {
    const sub = 'github_42';
    await recordBootstrapCompleted(storage, sub, 'github', 'admin-bootstrap-cli');

    const events = await storage.listIdentityEvents({ type: 'auth.bootstrap.completed' });
    expect(events.length).toBe(1);
    expect(events[0].sub).toBe(sub);
    const details = events[0].details as Record<string, unknown>;
    expect(details.method).toBe('github');
    expect(details.via).toBe('admin-bootstrap-cli');
    expect(typeof events[0].timestamp).toBe('number');
  });

  it('admin-bootstrap-cli vs implicit-create-user via marker is queryable', async () => {
    // Operators querying `auth_identity_events WHERE type='auth.bootstrap.completed'
    // AND details->>'via' = 'admin-bootstrap-cli'` must see only the
    // explicit-CLI rows, not the implicit ones. Cycle-21 security-LOW-2
    // flagged the missing `via` on admin-bootstrap; cycle 22 added it.
    await recordBootstrapCompleted(storage, 'github_admin', 'github', 'admin-bootstrap-cli');
    await recordBootstrapCompleted(storage, 'local_alice', 'local-password', 'implicit-create-user');

    const allEvents = await storage.listIdentityEvents({ type: 'auth.bootstrap.completed' });
    expect(allEvents.length).toBe(2);

    const explicit = allEvents.filter(e => (e.details as Record<string, unknown>).via === 'admin-bootstrap-cli');
    const implicit = allEvents.filter(e => (e.details as Record<string, unknown>).via === 'implicit-create-user');
    expect(explicit.length).toBe(1);
    expect(implicit.length).toBe(1);
    expect(explicit[0].sub).toBe('github_admin');
    expect(implicit[0].sub).toBe('local_alice');
  });

  it('cycle 22 / cycle-21 MEDIUM: CLI invocation pins the call shape', async () => {
    // The CLIs (admin-bootstrap.ts, create-user.ts) call
    // recordBootstrapCompleted directly. A regression that deletes
    // that call would be caught by NO existing test — the dashboard
    // shape tests above only assert what the helper does when
    // invoked, not that the CLIs invoke it.
    //
    // We can't easily run the full CLI binary in unit tests (commander
    // arg parsing, openCliAuthStorage env wiring, process.exit). The
    // pragmatic mitigation: import the CLI module (which exercises
    // top-level imports + statics) and grep its source for the helper
    // invocation. If a refactor extracts the CLI's bootstrap path into
    // a helper that the unit-test can call directly, replace this
    // test with a real invocation. As-is this is a narrow regression
    // guard for the "delete the call" mistake.
    // Cycle 24: resolve paths relative to this test file via import.meta.url
    // instead of hard-coding absolute filesystem locations. The earlier shape
    // baked the developer machine's checkout path into the assertion, breaking
    // any CI runner or contributor whose repo lived elsewhere.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    // tests/unit/auth/embedded-as/ → src/cli/ : up 4, into src/cli
    const cliDir = resolve(here, '../../../../src/cli');
    const adminBootstrapSrc = readFileSync(resolve(cliDir, 'admin-bootstrap.ts'), 'utf8');
    const createUserSrc = readFileSync(resolve(cliDir, 'create-user.ts'), 'utf8');
    expect(adminBootstrapSrc).toContain('recordBootstrapCompleted(');
    expect(adminBootstrapSrc).toContain("'admin-bootstrap-cli'");
    expect(createUserSrc).toContain('recordBootstrapCompleted(');
    expect(createUserSrc).toContain("'implicit-create-user'");
  });
});
