/**
 * Unit tests for ConsoleTokenStore (#1780).
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Secret, TOTP } from 'otpauth';
import {
  ConsoleTokenStore,
  readTokenFileRaw,
  getPrimaryTokenFromFile,
  TotpError,
  type ConsoleTokenFile,
} from '../../../../src/web/console/consoleToken.js';
import { SecurityMonitor } from '../../../../src/security/securityMonitor.js';

/**
 * Generate a TOTP code from a base32 secret at a specific point in time,
 * using the same parameters the store uses (SHA1 / 6 digits / 30s period).
 * Timestamp defaults to `Date.now()` so this doubles as the "current code"
 * helper when no explicit time is needed. Kept at module scope so Sonar
 * (S7721) doesn't flag inner-function re-creation per test run.
 */
function totpCodeAt(base32Secret: string, timestampMs: number = Date.now()): string {
  const totp = new TOTP({
    issuer: 'DollhouseMCP',
    label: 'test',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(base32Secret),
  });
  return totp.generate({ timestamp: timestampMs });
}

/** Convenience alias: `totpCodeAt(secret)` with the default `Date.now()`. */
function currentTotpCode(base32Secret: string): string {
  return totpCodeAt(base32Secret);
}

describe('ConsoleTokenStore', () => {
  let testDir: string;
  let tokenFilePath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dollhouse-console-token-test-'));
    tokenFilePath = join(testDir, 'console-token.auth.json');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('ensureInitialized', () => {
    it('creates a new token file on first run', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');

      expect(entry).toBeDefined();
      expect(entry.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(entry.name).toContain('Kermit');
      expect(entry.kind).toBe('console');
      expect(entry.token).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.scopes).toEqual(['admin']);
      expect(entry.elementBoundaries).toBeNull();
      expect(entry.tenant).toBeNull();
      expect(entry.platform).toBe('local');
      expect(entry.labels).toEqual({});
      expect(entry.createdVia).toBe('initial-setup');
      expect(entry.lastUsedAt).toBeNull();
    });

    it('persists a valid JSON file with 0600 permissions', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      await store.ensureInitialized('Kermit');

      const raw = await readFile(tokenFilePath, 'utf8');
      const parsed = JSON.parse(raw) as ConsoleTokenFile;
      expect(parsed.version).toBe(1);
      expect(parsed.tokens).toHaveLength(1);
      expect(parsed.totp).toEqual({
        enrolled: false,
        secret: null,
        backupCodes: [],
        enrolledAt: null,
      });
    });

    it('loads existing token file on subsequent runs (persistence)', async () => {
      const store1 = new ConsoleTokenStore(tokenFilePath);
      const first = await store1.ensureInitialized('Kermit');

      const store2 = new ConsoleTokenStore(tokenFilePath);
      const second = await store2.ensureInitialized('Piggy');

      expect(second.id).toBe(first.id);
      expect(second.token).toBe(first.token);
      // Name stays the same — we don't overwrite on reload
      expect(second.name).toBe(first.name);
    });

    it('generates distinct tokens across fresh installs', async () => {
      const store1 = new ConsoleTokenStore(tokenFilePath);
      const entry1 = await store1.ensureInitialized('Kermit');

      // Delete and start fresh
      await rm(tokenFilePath, { force: true });

      const store2 = new ConsoleTokenStore(tokenFilePath);
      const entry2 = await store2.ensureInitialized('Kermit');

      expect(entry2.token).not.toBe(entry1.token);
      expect(entry2.id).not.toBe(entry1.id);
    });
  });

  describe('verify', () => {
    it('returns the matching entry for a valid token', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');

      const matched = store.verify(entry.token);
      expect(matched).not.toBeNull();
      expect(matched!.id).toBe(entry.id);
    });

    it('returns null for an invalid token', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      await store.ensureInitialized('Kermit');

      expect(store.verify('wrong-token')).toBeNull();
    });

    it('returns null for an empty token', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      await store.ensureInitialized('Kermit');

      expect(store.verify('')).toBeNull();
    });

    it('returns null before initialization', () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      expect(store.verify('anything')).toBeNull();
    });

    it('updates lastUsedAt when a token is verified', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');

      expect(entry.lastUsedAt).toBeNull();
      const matched = store.verify(entry.token);
      expect(matched!.lastUsedAt).not.toBeNull();
    });

    it('uses constant-time comparison (accepts only same-length inputs)', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');

      // Prefix match should fail — timingSafeEqual requires equal length
      const prefix = entry.token.slice(0, 32);
      expect(store.verify(prefix)).toBeNull();
    });
  });

  describe('getPrimaryTokenValue', () => {
    it('returns the token value for server/follower use', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');
      expect(store.getPrimaryTokenValue()).toBe(entry.token);
    });

    it('returns null before initialization', () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      expect(store.getPrimaryTokenValue()).toBeNull();
    });
  });

  describe('listMasked', () => {
    it('returns entries with the token secret replaced by a preview', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');

      const masked = store.listMasked();
      expect(masked).toHaveLength(1);
      expect(masked[0]).not.toHaveProperty('token');
      expect(masked[0].tokenPreview).toContain(entry.token.slice(0, 8));
      expect(masked[0].tokenPreview).not.toContain(entry.token);
    });
  });

  // ==================================================================
  // TOTP enrollment — Phase 2 (#1794)
  // ==================================================================
  describe('TOTP enrollment', () => {
    describe('getTotpStatus / isTotpEnrolled', () => {
      it('reports not-enrolled on a fresh store', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        expect(store.isTotpEnrolled()).toBe(false);
        expect(store.getTotpStatus()).toEqual({
          enrolled: false,
          enrolledAt: null,
          backupCodesRemaining: 0,
        });
      });
    });

    describe('beginTotpEnrollment', () => {
      it('returns a pendingId, base32 secret, and otpauth URI', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');

        const begin = store.beginTotpEnrollment();
        expect(begin.pendingId).toMatch(/^[0-9a-f-]{36}$/);
        expect(begin.secret).toMatch(/^[A-Z2-7]+=*$/); // base32 alphabet
        expect(begin.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
        expect(begin.otpauthUri).toContain(`secret=${begin.secret}`);
        expect(begin.otpauthUri).toContain('issuer=DollhouseMCP');
        expect(begin.expiresAt).toBeGreaterThan(Date.now());
      });

      it('produces distinct secrets across calls', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');

        const a = store.beginTotpEnrollment();
        const b = store.beginTotpEnrollment();
        expect(a.pendingId).not.toBe(b.pendingId);
        expect(a.secret).not.toBe(b.secret);
      });

      it('does not persist anything to disk', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        store.beginTotpEnrollment();

        const raw = await readFile(tokenFilePath, 'utf8');
        const parsed = JSON.parse(raw) as ConsoleTokenFile;
        expect(parsed.totp.enrolled).toBe(false);
        expect(parsed.totp.secret).toBeNull();
      });

      it('throws if TOTP is already enrolled', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();
        await store.confirmTotpEnrollment(begin.pendingId, currentTotpCode(begin.secret));

        expect(() => store.beginTotpEnrollment()).toThrow(/already enrolled/i);
      });
    });

    describe('confirmTotpEnrollment', () => {
      it('persists enrollment and returns plaintext backup codes on valid code', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();

        const result = await store.confirmTotpEnrollment(
          begin.pendingId,
          currentTotpCode(begin.secret),
        );

        expect(result.backupCodes).toHaveLength(10);
        result.backupCodes.forEach(code => expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/));
        expect(new Set(result.backupCodes).size).toBe(10); // all unique
        expect(result.enrolledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

        // Verify enrollment is persisted
        expect(store.isTotpEnrolled()).toBe(true);
        expect(store.getTotpStatus().enrolled).toBe(true);
        expect(store.getTotpStatus().backupCodesRemaining).toBe(10);

        // Verify file on disk — backup codes stored hashed, never plaintext
        const persisted = JSON.parse(await readFile(tokenFilePath, 'utf8')) as ConsoleTokenFile;
        expect(persisted.totp.enrolled).toBe(true);
        expect(persisted.totp.secret).toBe(begin.secret);
        expect(persisted.totp.backupCodes).toHaveLength(10);
        persisted.totp.backupCodes.forEach(hash => expect(hash).toMatch(/^[0-9a-f]{64}$/));
        result.backupCodes.forEach(plain => {
          expect(persisted.totp.backupCodes).not.toContain(plain);
        });
      });

      it('rejects a wrong code and keeps the pending enrollment intact', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();

        await expect(
          store.confirmTotpEnrollment(begin.pendingId, '000000'),
        ).rejects.toThrow(/invalid totp/i);

        // Pending enrollment is still usable with the correct code
        expect(store.isTotpEnrolled()).toBe(false);
        const result = await store.confirmTotpEnrollment(
          begin.pendingId,
          currentTotpCode(begin.secret),
        );
        expect(result.backupCodes).toHaveLength(10);
      });

      it('rejects an unknown pendingId', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');

        await expect(
          store.confirmTotpEnrollment('no-such-id', '123456'),
        ).rejects.toThrow(/not found|expired/i);
      });

      it('cleans up the pending entry after successful confirm', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();
        await store.confirmTotpEnrollment(begin.pendingId, currentTotpCode(begin.secret));

        // Second confirm with the same pendingId should now fail
        await expect(
          store.confirmTotpEnrollment(begin.pendingId, currentTotpCode(begin.secret)),
        ).rejects.toThrow();
      });
    });

    describe('verifyTotp', () => {
      it('accepts a valid TOTP code without modifying backup codes', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();
        await store.confirmTotpEnrollment(begin.pendingId, currentTotpCode(begin.secret));

        const result = await store.verifyTotp(currentTotpCode(begin.secret));
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.method).toBe('totp');
          expect(result.backupCodesRemaining).toBe(10);
        }
      });

      it('rejects a wrong code', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();
        await store.confirmTotpEnrollment(begin.pendingId, currentTotpCode(begin.secret));

        const result = await store.verifyTotp('000000');
        expect(result.ok).toBe(false);
      });

      it('returns false when not enrolled', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');

        const result = await store.verifyTotp('123456');
        expect(result.ok).toBe(false);
      });

      it('consumes a backup code on first use and rejects it on second use', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();
        const { backupCodes } = await store.confirmTotpEnrollment(
          begin.pendingId,
          currentTotpCode(begin.secret),
        );

        const first = await store.verifyTotp(backupCodes[0]);
        expect(first.ok).toBe(true);
        if (first.ok) {
          expect(first.method).toBe('backup');
          expect(first.backupCodesRemaining).toBe(9);
        }

        const replay = await store.verifyTotp(backupCodes[0]);
        expect(replay.ok).toBe(false);

        expect(store.getTotpStatus().backupCodesRemaining).toBe(9);
      });

      it('normalizes backup codes with whitespace or dashes', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();
        const { backupCodes } = await store.confirmTotpEnrollment(
          begin.pendingId,
          currentTotpCode(begin.secret),
        );

        // "AAAA BBBB" or "AAAA-BBBB" style entry is normalized to the stored form
        const code = backupCodes[0];
        const spaced = `${code.slice(0, 4)}-${code.slice(4)}`;
        const result = await store.verifyTotp(spaced);
        expect(result.ok).toBe(true);
      });

      it('persists backup code consumption across store reloads', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();
        const { backupCodes } = await store.confirmTotpEnrollment(
          begin.pendingId,
          currentTotpCode(begin.secret),
        );

        await store.verifyTotp(backupCodes[0]);

        const reloaded = new ConsoleTokenStore(tokenFilePath);
        await reloaded.ensureInitialized('Piggy');
        expect(reloaded.getTotpStatus().backupCodesRemaining).toBe(9);

        // The consumed code is rejected on the reloaded store too
        const replay = await reloaded.verifyTotp(backupCodes[0]);
        expect(replay.ok).toBe(false);
      });
    });

    describe('disableTotp', () => {
      it('clears enrollment when given a valid code', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();
        await store.confirmTotpEnrollment(begin.pendingId, currentTotpCode(begin.secret));

        await store.disableTotp(currentTotpCode(begin.secret));
        expect(store.isTotpEnrolled()).toBe(false);
        expect(store.getTotpStatus().enrolled).toBe(false);

        const persisted = JSON.parse(await readFile(tokenFilePath, 'utf8')) as ConsoleTokenFile;
        expect(persisted.totp.enrolled).toBe(false);
        expect(persisted.totp.secret).toBeNull();
        expect(persisted.totp.backupCodes).toEqual([]);
      });

      it('rejects a wrong code and leaves enrollment intact', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();
        await store.confirmTotpEnrollment(begin.pendingId, currentTotpCode(begin.secret));

        await expect(store.disableTotp('000000')).rejects.toThrow(/invalid/i);
        expect(store.isTotpEnrolled()).toBe(true);
      });

      it('throws when not currently enrolled', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');

        await expect(store.disableTotp('123456')).rejects.toThrow(/not.*enrolled/i);
      });

      it('accepts a backup code as confirmation for disable', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();
        const { backupCodes } = await store.confirmTotpEnrollment(
          begin.pendingId,
          currentTotpCode(begin.secret),
        );

        await store.disableTotp(backupCodes[0]);
        expect(store.isTotpEnrolled()).toBe(false);
      });
    });

    describe('backward compatibility with Phase 1 files', () => {
      it('reads a Phase 1 token file that lacks the enrolledAt field', async () => {
        // Hand-craft a Phase 1 shape file (no enrolledAt key)
        const phase1File = {
          version: 1,
          tokens: [{
            id: '00000000-0000-0000-0000-000000000000',
            name: 'Kermit on test-host',
            kind: 'console',
            token: 'a'.repeat(64),
            scopes: ['admin'],
            elementBoundaries: null,
            tenant: null,
            platform: 'local',
            labels: {},
            createdAt: '2026-01-01T00:00:00.000Z',
            lastUsedAt: null,
            createdVia: 'initial-setup',
          }],
          totp: { enrolled: false, secret: null, backupCodes: [] },
        };
        await writeFile(tokenFilePath, JSON.stringify(phase1File), 'utf8');

        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Piggy');

        // Reading does not throw; status reports not-enrolled
        expect(store.isTotpEnrolled()).toBe(false);
        expect(store.getTotpStatus().enrolled).toBe(false);

        // Enrollment still works against the legacy file
        const begin = store.beginTotpEnrollment();
        const result = await store.confirmTotpEnrollment(
          begin.pendingId,
          currentTotpCode(begin.secret),
        );
        expect(result.backupCodes).toHaveLength(10);
      });
    });

    // ================================================================
    // Pending enrollment map cap (memory bound)
    // ================================================================
    describe('pending enrollment cap', () => {
      it('allows up to 10 concurrent pending enrollments', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');

        // 10 begins in a row should all succeed
        const pendings = [];
        for (let i = 0; i < 10; i++) {
          pendings.push(store.beginTotpEnrollment());
        }
        expect(pendings).toHaveLength(10);
        // All distinct
        expect(new Set(pendings.map(p => p.pendingId)).size).toBe(10);
      });

      it('rejects the 11th pending with TOO_MANY_PENDING', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');

        for (let i = 0; i < 10; i++) {
          store.beginTotpEnrollment();
        }

        try {
          store.beginTotpEnrollment();
          throw new Error('expected TOO_MANY_PENDING to be thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(TotpError);
          expect((err as TotpError).code).toBe('TOO_MANY_PENDING');
        }
      });

      it('frees slots when pending entries expire via sweep', async () => {
        jest.useFakeTimers({ now: new Date('2026-04-05T12:00:00Z') });
        try {
          const store = new ConsoleTokenStore(tokenFilePath);
          await store.ensureInitialized('Kermit');

          for (let i = 0; i < 10; i++) {
            store.beginTotpEnrollment();
          }
          // Cap hit
          expect(() => store.beginTotpEnrollment()).toThrow(/too many pending/i);

          // Advance past TTL (10 minutes) — all 10 now expire on next sweep
          jest.advanceTimersByTime(11 * 60 * 1000);

          // Fresh begin succeeds because sweep runs first and clears expired
          const fresh = store.beginTotpEnrollment();
          expect(fresh.pendingId).toBeTruthy();
        } finally {
          jest.useRealTimers();
        }
      });
    });

    // ================================================================
    // Expired pending enrollment — TTL contract
    // ================================================================
    describe('pending enrollment TTL', () => {
      it('rejects confirm after the pending has expired', async () => {
        jest.useFakeTimers({ now: new Date('2026-04-05T12:00:00Z') });
        try {
          const store = new ConsoleTokenStore(tokenFilePath);
          await store.ensureInitialized('Kermit');
          const begin = store.beginTotpEnrollment();

          // Advance past the 10-minute TTL
          jest.advanceTimersByTime(11 * 60 * 1000);

          // Confirming the previously-valid pendingId now yields
          // PENDING_NOT_FOUND because sweep clears the entry first
          await expect(
            store.confirmTotpEnrollment(begin.pendingId, currentTotpCode(begin.secret)),
          ).rejects.toMatchObject({
            code: 'PENDING_NOT_FOUND',
          });
        } finally {
          jest.useRealTimers();
        }
      });
    });

    // ================================================================
    // Backup code case-insensitivity
    // ================================================================
    describe('backup code normalization', () => {
      it('accepts lowercase backup codes', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();
        const { backupCodes } = await store.confirmTotpEnrollment(
          begin.pendingId,
          currentTotpCode(begin.secret),
        );

        const result = await store.verifyTotp(backupCodes[0].toLowerCase());
        expect(result.ok).toBe(true);
      });
    });

    // ================================================================
    // TOTP validation window — ±60s tolerance (window=2) for
    // async/bridge latency. A user typing a code over a slow chat
    // transport (DollhouseBridge via Zulip) can see 30-60s elapse
    // between generation and server verification.
    // ================================================================
    describe('validation window tolerance', () => {
      // Uses the module-scope `totpCodeAt(secret, timestampMs)` helper so
      // we can simulate codes generated in the past or future relative to
      // the server's verification clock. Same helper `currentTotpCode`
      // delegates to, kept at file scope per S7721.

      it('accepts a code generated 60 seconds in the past (slow bridge)', async () => {
        jest.useFakeTimers({ now: new Date('2026-04-05T12:00:00Z') });
        try {
          const store = new ConsoleTokenStore(tokenFilePath);
          await store.ensureInitialized('Kermit');
          const begin = store.beginTotpEnrollment();

          // Simulate a code the user read from their authenticator 60
          // seconds before it reached the server (typical worst-case for
          // a chat-bridge transport under load).
          const lateCode = totpCodeAt(begin.secret, Date.now() - 60_000);

          const result = await store.confirmTotpEnrollment(begin.pendingId, lateCode);
          expect(result.backupCodes).toHaveLength(10);
        } finally {
          jest.useRealTimers();
        }
      });

      it('rejects a code generated 120 seconds in the past (beyond window)', async () => {
        jest.useFakeTimers({ now: new Date('2026-04-05T12:00:00Z') });
        try {
          const store = new ConsoleTokenStore(tokenFilePath);
          await store.ensureInitialized('Kermit');
          const begin = store.beginTotpEnrollment();

          // 120 seconds is 4 time-steps back — the code was generated
          // for step N-4, server accepts N-2..N+2. Out of window.
          const tooOldCode = totpCodeAt(begin.secret, Date.now() - 120_000);

          await expect(
            store.confirmTotpEnrollment(begin.pendingId, tooOldCode),
          ).rejects.toMatchObject({ code: 'INVALID_TOTP_CODE' });
        } finally {
          jest.useRealTimers();
        }
      });

      it('rejects a code generated 60 seconds in the future (anti-replay margin)', async () => {
        // Symmetric check — window=2 means ±60s, so a code generated at
        // now+90s is also out of window. Protects against a clock-skew
        // regression that silently widens the window on one side.
        jest.useFakeTimers({ now: new Date('2026-04-05T12:00:00Z') });
        try {
          const store = new ConsoleTokenStore(tokenFilePath);
          await store.ensureInitialized('Kermit');
          const begin = store.beginTotpEnrollment();

          const tooFutureCode = totpCodeAt(begin.secret, Date.now() + 120_000);

          await expect(
            store.confirmTotpEnrollment(begin.pendingId, tooFutureCode),
          ).rejects.toMatchObject({ code: 'INVALID_TOTP_CODE' });
        } finally {
          jest.useRealTimers();
        }
      });

      it('error message includes timing guidance for users on slow channels', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();

        try {
          await store.confirmTotpEnrollment(begin.pendingId, '000000');
          throw new Error('expected INVALID_TOTP_CODE to be thrown');
        } catch (err) {
          expect(err).toBeInstanceOf(TotpError);
          expect((err as TotpError).message).toMatch(/lifetime remaining/i);
          expect((err as TotpError).message).toMatch(/bridge|slow/i);
        }
      });
    });

    // ================================================================
    // SecurityMonitor audit trail — verifies the DMCP-SEC-006 fix
    // actually fires events for every TOTP lifecycle operation. Uses
    // jest.spyOn with a noop impl so the real SecurityMonitor dedup
    // window (60s) doesn't swallow rapid-fire test calls.
    // ================================================================
    describe('SecurityMonitor audit events', () => {
      let logSpy: ReturnType<typeof jest.spyOn>;

      beforeEach(() => {
        logSpy = jest.spyOn(SecurityMonitor, 'logSecurityEvent').mockImplementation(() => {});
      });

      afterEach(() => {
        logSpy.mockRestore();
      });

      /**
       * Assert that none of the calls captured by `logSpy` contain the
       * given secret material anywhere in their payload — JSON-stringify
       * each call's arg and substring-match. Catches accidental leakage
       * through additionalData or details fields.
       */
      const assertNoSecretLeaks = (forbidden: string[]) => {
        for (const call of logSpy.mock.calls) {
          const serialized = JSON.stringify(call[0]);
          for (const secret of forbidden) {
            if (!secret) continue;
            expect(serialized).not.toContain(secret);
          }
        }
      };

      it('emits TOTP_ENROLLED on successful confirm', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();
        const { backupCodes } = await store.confirmTotpEnrollment(
          begin.pendingId,
          currentTotpCode(begin.secret),
        );

        expect(logSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'TOTP_ENROLLED',
            severity: 'MEDIUM',
            source: 'ConsoleTokenStore.confirmTotpEnrollment',
          }),
        );
        // Neither the base32 secret nor any plaintext backup code may
        // appear anywhere in the serialized audit payload
        assertNoSecretLeaks([begin.secret, ...backupCodes]);
      });

      it('emits TOTP_VERIFICATION_FAILED on wrong confirm code', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();

        await expect(
          store.confirmTotpEnrollment(begin.pendingId, '000000'),
        ).rejects.toBeInstanceOf(TotpError);

        expect(logSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'TOTP_VERIFICATION_FAILED',
            severity: 'MEDIUM',
            source: 'ConsoleTokenStore.confirmTotpEnrollment',
          }),
        );
        assertNoSecretLeaks([begin.secret]);
      });

      it('emits TOTP_BACKUP_CODE_CONSUMED when a backup code verifies', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();
        const { backupCodes } = await store.confirmTotpEnrollment(
          begin.pendingId,
          currentTotpCode(begin.secret),
        );
        logSpy.mockClear(); // drop the TOTP_ENROLLED call

        const result = await store.verifyTotp(backupCodes[0]);
        expect(result.ok).toBe(true);

        expect(logSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'TOTP_BACKUP_CODE_CONSUMED',
            severity: 'MEDIUM',
            source: 'ConsoleTokenStore.verifyTotp',
            additionalData: { remaining: 9 },
          }),
        );
        assertNoSecretLeaks([begin.secret, ...backupCodes]);
      });

      it('emits TOTP_VERIFICATION_FAILED when verifyTotp rejects a wrong code', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();
        await store.confirmTotpEnrollment(
          begin.pendingId,
          currentTotpCode(begin.secret),
        );
        logSpy.mockClear();

        const result = await store.verifyTotp('000000');
        expect(result.ok).toBe(false);

        expect(logSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'TOTP_VERIFICATION_FAILED',
            severity: 'MEDIUM',
            source: 'ConsoleTokenStore.verifyTotp',
          }),
        );
      });

      it('emits TOTP_DISABLED on successful disable', async () => {
        const store = new ConsoleTokenStore(tokenFilePath);
        await store.ensureInitialized('Kermit');
        const begin = store.beginTotpEnrollment();
        await store.confirmTotpEnrollment(
          begin.pendingId,
          currentTotpCode(begin.secret),
        );
        logSpy.mockClear();

        await store.disableTotp(currentTotpCode(begin.secret));

        expect(logSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'TOTP_DISABLED',
            severity: 'HIGH',
            source: 'ConsoleTokenStore.disableTotp',
          }),
        );
        assertNoSecretLeaks([begin.secret]);
      });
    });
  });
});

describe('readTokenFileRaw / getPrimaryTokenFromFile (follower helpers)', () => {
  let testDir: string;
  let tokenFilePath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dollhouse-console-token-test-'));
    tokenFilePath = join(testDir, 'console-token.auth.json');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns null when the file does not exist', async () => {
    expect(await readTokenFileRaw(tokenFilePath)).toBeNull();
    expect(await getPrimaryTokenFromFile(tokenFilePath)).toBeNull();
  });

  it('reads a valid file written by ConsoleTokenStore', async () => {
    const store = new ConsoleTokenStore(tokenFilePath);
    const entry = await store.ensureInitialized('Kermit');

    const raw = await readTokenFileRaw(tokenFilePath);
    expect(raw).not.toBeNull();
    expect(raw!.tokens[0].id).toBe(entry.id);

    const primary = await getPrimaryTokenFromFile(tokenFilePath);
    expect(primary).toBe(entry.token);
  });

  it('returns null for a corrupt file', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(tokenFilePath, 'this is not json', 'utf8');
    expect(await readTokenFileRaw(tokenFilePath)).toBeNull();
  });

  it('returns null for a file with wrong schema version', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(
      tokenFilePath,
      JSON.stringify({ version: 999, tokens: [], totp: {} }),
      'utf8',
    );
    expect(await readTokenFileRaw(tokenFilePath)).toBeNull();
  });
});
