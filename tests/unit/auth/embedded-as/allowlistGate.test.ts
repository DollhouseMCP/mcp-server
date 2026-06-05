/**
 * Unit tests for the shared allowlist gate decision function.
 *
 * The full decision matrix (5 rules from `allowlistGate.ts`):
 *
 *   1. Bootstrap admin → PASS (always, regardless of REQUIRED or list state)
 *   2. Identity matches allowlist → PASS
 *   3. REQUIRED=true + no match → DENY
 *   4. REQUIRED=false + empty list → PASS (back-compat)
 *   5. REQUIRED=false + populated list + no match → DENY
 *
 * Plus: denial emits an `auth.allowlist_denied` audit event with the
 * identity values for operator diagnostics.
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  checkAllowlistGate,
  renderAllowlistDeniedPage,
  withSignInAllowlistAuthority,
  type SignInAllowlistAuthority,
} from '../../../../src/auth/embedded-as/allowlistGate.js';
import { InMemoryAuthStorageLayer } from '../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';

const ALICE_EMAIL = 'alice@example.com';

describe('checkAllowlistGate — decision matrix', () => {
  let storage: InMemoryAuthStorageLayer;

  beforeEach(() => {
    storage = new InMemoryAuthStorageLayer();
  });

  // ── Rule 1: bootstrap admin always passes ────────────────────────────

  describe('bootstrap admin always passes', () => {
    it('passes with REQUIRED=true + empty list', async () => {
      await storage.markBootstrapComplete('github_42', 'github');
      const result = await checkAllowlistGate(
        { sub: 'github_42', method: 'github', email: 'todd@example.com', githubUsername: 'insomnolence', githubId: '42' },
        { storage, required: true },
      );
      expect(result.allowed).toBe(true);
    });

    it('passes with REQUIRED=false + populated list that does NOT include them', async () => {
      await storage.markBootstrapComplete('github_42', 'github');
      await storage.allowlistAdd({ kind: 'email', value: 'someone-else@example.com' });
      const result = await checkAllowlistGate(
        { sub: 'github_42', method: 'github', email: 'todd@example.com', githubId: '42' },
        { storage, required: false },
      );
      expect(result.allowed).toBe(true);
    });

    it('only matches when method also matches — bootstrap admin pre-claimed under github is NOT auto-passed under magic-link', async () => {
      await storage.markBootstrapComplete('github_42', 'github');
      const result = await checkAllowlistGate(
        // Same sub but method=magic-link this time; bootstrap pre-claim
        // was for github, so this is NOT the bootstrap admin for this path.
        { sub: 'github_42', method: 'magic-link', email: 'todd@example.com' },
        { storage, required: true },
      );
      expect(result.allowed).toBe(false);
    });
  });

  // ── Rule 2: allowlist match wins ─────────────────────────────────────

  describe('allowlist match wins', () => {
    it('passes when email is on the list (REQUIRED=true)', async () => {
      await storage.allowlistAdd({ kind: 'email', value: ALICE_EMAIL });
      const result = await checkAllowlistGate(
        { sub: 'github_99', method: 'github', email: ALICE_EMAIL, githubId: '99' },
        { storage, required: true },
      );
      expect(result.allowed).toBe(true);
    });

    it('passes when github_username is on the list', async () => {
      await storage.allowlistAdd({ kind: 'github_username', value: 'mick' });
      const result = await checkAllowlistGate(
        { sub: 'github_77', method: 'github', email: 'mick@example.com', githubUsername: 'mick', githubId: '77' },
        { storage, required: true },
      );
      expect(result.allowed).toBe(true);
    });

    it('passes when github_id matches even if username + email do not', async () => {
      await storage.allowlistAdd({ kind: 'github_id', value: '1125822' });
      const result = await checkAllowlistGate(
        // Username was renamed at GitHub, email private — only the numeric ID is stable.
        { sub: 'github_1125822', method: 'github', email: 'renamed@example.com', githubUsername: 'new-handle', githubId: '1125822' },
        { storage, required: true },
      );
      expect(result.allowed).toBe(true);
    });

    it('email match is case-insensitive on the caller side', async () => {
      await storage.allowlistAdd({ kind: 'email', value: ALICE_EMAIL });
      const result = await checkAllowlistGate(
        { sub: 'github_99', method: 'github', email: 'ALICE@example.com' },
        { storage, required: true },
      );
      expect(result.allowed).toBe(true);
    });

    it('uses an injected sign-in authority instead of the legacy storage allowlist', async () => {
      const authority = fixedAuthority({
        entries: 1,
        matches: true,
      });
      const result = await checkAllowlistGate(
        { sub: 'github_99', method: 'github', email: ALICE_EMAIL, githubId: '99' },
        { storage, authority, required: true },
      );
      expect(result.allowed).toBe(true);
      expect(await storage.allowlistList()).toHaveLength(0);
    });
  });

  // ── Rule 3: REQUIRED=true + no match → DENY ──────────────────────────

  describe('REQUIRED=true rejects unmatched identities', () => {
    it('denies when empty list and not bootstrap admin', async () => {
      const result = await checkAllowlistGate(
        { sub: 'github_99', method: 'github', email: ALICE_EMAIL, githubId: '99' },
        { storage, required: true },
      );
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toMatch(/required/i);
      }
    });

    it('denies when list populated but identity not on it', async () => {
      await storage.allowlistAdd({ kind: 'email', value: 'someone-else@example.com' });
      const result = await checkAllowlistGate(
        { sub: 'github_99', method: 'github', email: ALICE_EMAIL, githubId: '99' },
        { storage, required: true },
      );
      expect(result.allowed).toBe(false);
    });
  });

  // ── Rule 4: REQUIRED=false + empty list → PASS (back-compat) ─────────

  describe('REQUIRED=false back-compat: empty list = no gate', () => {
    it('passes when allowlist is empty (no entries configured)', async () => {
      const result = await checkAllowlistGate(
        { sub: 'github_99', method: 'github', email: 'anyone@example.com', githubId: '99' },
        { storage, required: false },
      );
      expect(result.allowed).toBe(true);
    });

    it('uses the injected authority entry state for back-compat empty-list behavior', async () => {
      await storage.allowlistAdd({ kind: 'email', value: 'someone-else@example.com' });
      const authority = fixedAuthority({
        entries: 0,
        matches: false,
      });
      const result = await checkAllowlistGate(
        { sub: 'github_99', method: 'github', email: ALICE_EMAIL, githubId: '99' },
        { storage, authority, required: false },
      );
      expect(result.allowed).toBe(true);
    });

    it('can adapt legacy storage to a replacement sign-in authority', async () => {
      const wrapped = withSignInAllowlistAuthority(storage, fixedAuthority({
        entries: 1,
        matches: true,
      }));
      const result = await checkAllowlistGate(
        { sub: 'github_99', method: 'github', email: ALICE_EMAIL, githubId: '99' },
        { storage: wrapped, required: true },
      );
      expect(result.allowed).toBe(true);
      expect(await storage.allowlistList()).toHaveLength(0);
    });
  });

  // ── Rule 5: REQUIRED=false + populated + no match → DENY ─────────────

  describe('REQUIRED=false + populated list rejects unmatched', () => {
    it('denies when list has entries and identity is not on it', async () => {
      await storage.allowlistAdd({ kind: 'email', value: 'someone-else@example.com' });
      const result = await checkAllowlistGate(
        { sub: 'github_99', method: 'github', email: ALICE_EMAIL, githubId: '99' },
        { storage, required: false },
      );
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toMatch(/allowlist/i);
      }
    });
  });

  // ── Audit emission ───────────────────────────────────────────────────

  describe('audit log on denial', () => {
    it('writes auth.allowlist_denied with identity values on denial', async () => {
      const result = await checkAllowlistGate(
        {
          sub: 'github_99',
          method: 'github',
          email: ALICE_EMAIL,
          githubUsername: 'alice',
          githubId: '99',
          provider: 'github',
          externalSub: '99',
        },
        { storage, required: true },
      );
      expect(result.allowed).toBe(false);

      const events = await storage.listIdentityEvents({ type: 'auth.allowlist_denied' });
      expect(events.length).toBe(1);
      expect(events[0]?.sub).toBe('github_99');
      expect(events[0]?.provider).toBe('github');
      expect(events[0]?.externalSub).toBe('99');
      const details = events[0]?.details as Record<string, unknown>;
      expect(details.method).toBe('github');
      expect(details.email).toBe(ALICE_EMAIL);
      expect(details.githubUsername).toBe('alice');
    });

    it('does NOT write an audit event when the identity passes', async () => {
      await storage.allowlistAdd({ kind: 'email', value: ALICE_EMAIL });
      await checkAllowlistGate(
        { sub: 'github_99', method: 'github', email: ALICE_EMAIL },
        { storage, required: true },
      );

      const events = await storage.listIdentityEvents({ type: 'auth.allowlist_denied' });
      expect(events.length).toBe(0);
    });
  });

  // ── Per-method coverage — all 3 methods can hit the gate ─────────────

  describe('all 3 sign-in methods exercise the gate uniformly', () => {
    it('github method denial', async () => {
      const result = await checkAllowlistGate(
        { sub: 'github_99', method: 'github', email: ALICE_EMAIL },
        { storage, required: true },
      );
      expect(result.allowed).toBe(false);
    });

    it('magic-link method denial', async () => {
      const result = await checkAllowlistGate(
        { sub: 'magic-link_abc', method: 'magic-link', email: ALICE_EMAIL },
        { storage, required: true },
      );
      expect(result.allowed).toBe(false);
    });

    it('local-password method denial', async () => {
      const result = await checkAllowlistGate(
        { sub: 'local_alice', method: 'local-password', email: ALICE_EMAIL },
        { storage, required: true },
      );
      expect(result.allowed).toBe(false);
    });
  });
});

function fixedAuthority(options: {
  readonly entries: number;
  readonly matches: boolean;
}): SignInAllowlistAuthority {
  return {
    hasAnyEntries: () => Promise.resolve(options.entries > 0),
    listEntries: () => Promise.resolve(Array.from({ length: options.entries }, (_, index) => ({
      id: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
      kind: 'email',
      value: `placeholder-${index}@example.test`,
      note: null,
      createdBy: null,
      createdAt: new Date('2026-05-30T00:00:00.000Z'),
    }))),
    matchesIdentity: () => Promise.resolve(options.matches),
  };
}

describe('renderAllowlistDeniedPage', () => {
  it('returns valid HTML with the standard denial copy', () => {
    const html = renderAllowlistDeniedPage();
    expect(html).toMatch(/<!doctype html>/i);
    expect(html).toMatch(/Access denied/);
    expect(html).toMatch(/access policy/i);
  });

  it('does NOT echo back any identity values (PII leak resistance)', () => {
    const html = renderAllowlistDeniedPage();
    // The page is identity-agnostic by contract — never reflects email,
    // username, or sub. If a future change adds those, this test breaks
    // and the rationale is reconsidered explicitly.
    expect(html).not.toMatch(/@example\.com/);
    expect(html).not.toMatch(/github_/);
  });

  it('escapes operator-supplied contact note', () => {
    const html = renderAllowlistDeniedPage('<script>alert("xss")</script>');
    expect(html).not.toMatch(/<script>/);
    expect(html).toMatch(/&lt;script&gt;/);
    expect(html).toMatch(/&quot;|alert\(/);
  });

  it('omits the contact-note block when no note is supplied', () => {
    const html = renderAllowlistDeniedPage();
    // The note paragraph is conditional — verify no empty <p></p> dangler.
    expect(html).not.toMatch(/<p>\s*<\/p>/);
  });
});
