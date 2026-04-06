/**
 * Unit tests for the console token CLI commands (#1790).
 *
 * These tests exercise the CLI logic by constructing a real
 * ConsoleTokenStore backed by a temp file, then calling the store
 * methods that the CLI commands invoke. We test the store interaction
 * layer, not the Commander.js argument parsing (which is covered by
 * Commander's own tests).
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Secret, TOTP } from 'otpauth';
import {
  ConsoleTokenStore,
  readTokenFileRaw,
  TotpError,
} from '../../../src/web/console/consoleToken.js';

function currentTotpCode(base32Secret: string): string {
  const totp = new TOTP({
    issuer: 'DollhouseMCP',
    label: 'test',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(base32Secret),
  });
  return totp.generate();
}

async function enrollTotp(store: ConsoleTokenStore): Promise<string> {
  const begin = store.beginTotpEnrollment();
  await store.confirmTotpEnrollment(begin.pendingId, currentTotpCode(begin.secret));
  return begin.secret;
}

describe('console token CLI operations', () => {
  let testDir: string;
  let tokenFilePath: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'dollhouse-cli-token-test-'));
    tokenFilePath = join(testDir, 'console-token.auth.json');
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('show', () => {
    it('reads the primary token from the file', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');

      const data = await readTokenFileRaw(tokenFilePath);
      expect(data).not.toBeNull();
      expect(data!.tokens[0].token).toBe(entry.token);
      expect(data!.tokens[0].token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns null for a missing file', async () => {
      const data = await readTokenFileRaw(join(testDir, 'nonexistent.json'));
      expect(data).toBeNull();
    });

    it('provides masked view via listMasked', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      await store.ensureInitialized('Kermit');

      const masked = store.listMasked();
      expect(masked).toHaveLength(1);
      expect(masked[0].tokenPreview).toMatch(/^[0-9a-f]{8}•+$/);
      expect(masked[0]).not.toHaveProperty('token');
    });

    it('includes TOTP status in file data', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      await store.ensureInitialized('Kermit');

      const data = await readTokenFileRaw(tokenFilePath);
      expect(data!.totp.enrolled).toBe(false);
    });
  });

  describe('rotate', () => {
    it('rotates with a valid TOTP code', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');
      const originalToken = entry.token;
      const secret = await enrollTotp(store);

      const result = await store.rotatePrimary(currentTotpCode(secret));
      expect(result.token).toMatch(/^[0-9a-f]{64}$/);
      expect(result.token).not.toBe(originalToken);
      expect(result.rotatedAt).toBeTruthy();
    });

    it('rejects when TOTP is not enrolled', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      await store.ensureInitialized('Kermit');

      await expect(store.rotatePrimary('123456')).rejects.toThrow(TotpError);
      try {
        await store.rotatePrimary('123456');
      } catch (err) {
        expect((err as TotpError).code).toBe('TOTP_REQUIRED');
      }
    });

    it('rejects with a wrong code', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      await store.ensureInitialized('Kermit');
      await enrollTotp(store);

      await expect(store.rotatePrimary('000000')).rejects.toThrow(TotpError);
      try {
        await store.rotatePrimary('000000');
      } catch (err) {
        expect((err as TotpError).code).toBe('INVALID_TOTP_CODE');
      }
    });

    it('persists new token to disk after rotation', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      await store.ensureInitialized('Kermit');
      const secret = await enrollTotp(store);

      const result = await store.rotatePrimary(currentTotpCode(secret));
      const data = await readTokenFileRaw(tokenFilePath);
      expect(data!.tokens[0].token).toBe(result.token);
      expect(data!.tokens[0].createdVia).toBe('rotation');
    });
  });

  describe('revoke (delegates to rotate)', () => {
    it('revokes by rotating the primary token', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');
      const originalToken = entry.token;
      const secret = await enrollTotp(store);

      // Revoke == rotate for the single-token case
      const result = await store.rotatePrimary(currentTotpCode(secret));
      expect(result.token).not.toBe(originalToken);

      // Old token should not verify after grace expires
      // (verified in store tests; here we just confirm the operation succeeded)
      expect(store.verify(result.token)).not.toBeNull();
    });
  });

  describe('JSON output structure', () => {
    it('show JSON includes expected fields', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      const entry = await store.ensureInitialized('Kermit');

      const data = await readTokenFileRaw(tokenFilePath);
      const primary = data!.tokens[0];
      // Simulate the JSON output structure from the CLI
      const output = {
        id: primary.id,
        name: primary.name,
        kind: primary.kind,
        token: primary.token,
        scopes: primary.scopes,
        createdAt: primary.createdAt,
        lastUsedAt: primary.lastUsedAt,
        createdVia: primary.createdVia,
        filePath: tokenFilePath,
        totpEnrolled: data!.totp.enrolled,
      };
      expect(output.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(output.token).toMatch(/^[0-9a-f]{64}$/);
      expect(output.kind).toBe('console');
      expect(output.totpEnrolled).toBe(false);
    });

    it('rotate JSON includes token and timing', async () => {
      const store = new ConsoleTokenStore(tokenFilePath);
      await store.ensureInitialized('Kermit');
      const secret = await enrollTotp(store);

      const result = await store.rotatePrimary(currentTotpCode(secret));
      const output = {
        token: result.token,
        rotatedAt: result.rotatedAt,
        graceUntil: result.graceUntil,
      };
      expect(output.token).toMatch(/^[0-9a-f]{64}$/);
      expect(output.rotatedAt).toBeTruthy();
      expect(output.graceUntil).toBeGreaterThan(Date.now());
    });
  });
});
