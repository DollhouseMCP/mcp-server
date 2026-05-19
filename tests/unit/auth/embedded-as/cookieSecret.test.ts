/**
 * Cycle-8 fix (H5): cookieSecret.ts had zero direct tests despite
 * being foundational — cookie keys gate the H12 interaction-cookie
 * binding verification AND (post-Round-5) double as the HMAC salt
 * for IP/UA hashes when refreshRotationCheckIpUa is enabled.
 *
 * Coverage:
 *   - Env var path with valid hex secret
 *   - Env var path with too-short hex secret (rejection)
 *   - File path with existing valid file
 *   - File path with too-short existing file (regenerates + warns)
 *   - File path with missing file (generates + persists at 0o600)
 *   - rotateCookieSecret with env var set (no-op)
 *   - rotateCookieSecret with existing file (unlinks)
 *   - rotateCookieSecret with missing file (idempotent no-op)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  loadOrGenerateCookieSigningKeys,
  rotateCookieSecret,
} from '../../../../src/auth/embedded-as/cookieSecret.js';

describe('cookieSecret — H5 coverage', () => {
  let tmpDir: string;
  let savedEnv: string | undefined;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cookie-secret-'));
    savedEnv = process.env.DOLLHOUSE_COOKIE_SIGNING_SECRET;
    delete process.env.DOLLHOUSE_COOKIE_SIGNING_SECRET;
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.DOLLHOUSE_COOKIE_SIGNING_SECRET;
    else process.env.DOLLHOUSE_COOKIE_SIGNING_SECRET = savedEnv;
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  describe('loadOrGenerateCookieSigningKeys — env var path', () => {
    // Cycle 22: env var resolution now happens at module load through
    // Zod (env.DOLLHOUSE_COOKIE_SIGNING_SECRET). Runtime process.env
    // mutation no longer reaches the call. Tests use the explicit
    // `options.envSecret` override (the test injection point —
    // mirrors createAuthStorage's `backend` option pattern).

    it('returns the env-var key when valid (32+ byte hex)', () => {
      const hex = randomBytes(32).toString('hex');
      const filePath = path.join(tmpDir, 'unused.bin');
      const keys = loadOrGenerateCookieSigningKeys(filePath, { envSecret: hex });
      expect(keys).toHaveLength(1);
      expect(keys[0]).toBe(Buffer.from(hex, 'hex').toString('base64'));
      // File MUST NOT be created when env var path is taken.
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('rejects env-var values that decode to less than 32 bytes', () => {
      // 31 bytes hex = 62 hex chars
      const filePath = path.join(tmpDir, 'unused.bin');
      expect(() => loadOrGenerateCookieSigningKeys(filePath, { envSecret: 'a'.repeat(62) })).toThrow(
        /at least 32 bytes/,
      );
    });

    it('env var precedence: a valid file is ignored when env var is set', () => {
      // Pre-populate a file with valid contents.
      const filePath = path.join(tmpDir, 'cookie.bin');
      fs.writeFileSync(filePath, randomBytes(32));
      // Set env var to a different valid value.
      const envHex = randomBytes(32).toString('hex');
      const keys = loadOrGenerateCookieSigningKeys(filePath, { envSecret: envHex });
      expect(keys[0]).toBe(Buffer.from(envHex, 'hex').toString('base64'));
    });
  });

  describe('loadOrGenerateCookieSigningKeys — file path', () => {
    it('reads an existing valid file (32+ bytes)', () => {
      const filePath = path.join(tmpDir, 'cookie.bin');
      const contents = randomBytes(32);
      fs.writeFileSync(filePath, contents);
      const keys = loadOrGenerateCookieSigningKeys(filePath);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toBe(contents.toString('base64'));
    });

    it('regenerates when file is too short (< 32 bytes)', () => {
      const filePath = path.join(tmpDir, 'cookie.bin');
      const shortContents = randomBytes(16); // half the required length
      fs.writeFileSync(filePath, shortContents);
      const keys = loadOrGenerateCookieSigningKeys(filePath);
      // Got a fresh key (not the short one).
      expect(keys[0]).not.toBe(shortContents.toString('base64'));
      // File now has the new key (32 bytes raw).
      const written = fs.readFileSync(filePath);
      expect(written.length).toBe(32);
    });

    it('generates a new file with mode 0o600 when missing', () => {
      const filePath = path.join(tmpDir, 'fresh', 'cookie.bin');
      const keys = loadOrGenerateCookieSigningKeys(filePath);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^[A-Za-z0-9+/]+=*$/); // base64 shape
      expect(fs.existsSync(filePath)).toBe(true);
      const stat = fs.statSync(filePath);
      // 0o600 = owner read+write, no group/other access. On non-Windows.
      if (os.platform() !== 'win32') {
        expect(stat.mode & 0o777).toBe(0o600);
      }
    });

    it('two consecutive calls without env var return the same key (file is persistent)', () => {
      const filePath = path.join(tmpDir, 'cookie.bin');
      const keys1 = loadOrGenerateCookieSigningKeys(filePath);
      const keys2 = loadOrGenerateCookieSigningKeys(filePath);
      expect(keys1[0]).toBe(keys2[0]);
    });
  });

  describe('rotateCookieSecret', () => {
    it('unlinks the file so the next load mints a fresh key', () => {
      const filePath = path.join(tmpDir, 'cookie.bin');
      const keys1 = loadOrGenerateCookieSigningKeys(filePath);
      rotateCookieSecret(filePath);
      expect(fs.existsSync(filePath)).toBe(false);
      const keys2 = loadOrGenerateCookieSigningKeys(filePath);
      // Fresh key minted, different from prior key.
      expect(keys2[0]).not.toBe(keys1[0]);
    });

    it('is idempotent when file is already missing (no-op)', () => {
      const filePath = path.join(tmpDir, 'never-existed.bin');
      // Should not throw.
      expect(() => rotateCookieSecret(filePath)).not.toThrow();
    });

    it('NO-OPs when DOLLHOUSE_COOKIE_SIGNING_SECRET is set (env-supplied secret rotation is operator responsibility)', () => {
      const filePath = path.join(tmpDir, 'cookie.bin');
      // Pre-populate file.
      fs.writeFileSync(filePath, randomBytes(32));
      // Cycle 22: env-supplied secret injected via the test override
      // (mirrors the env routing pattern). Rotation should leave the
      // file alone.
      rotateCookieSecret(filePath, { envSecret: randomBytes(32).toString('hex') });
      expect(fs.existsSync(filePath)).toBe(true);
    });
  });
});
