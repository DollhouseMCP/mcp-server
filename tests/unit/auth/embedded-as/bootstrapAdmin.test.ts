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
import { isBootstrapAdminFor } from '../../../../src/auth/embedded-as/bootstrapAdmin.js';
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
