import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { LocalDevAuthProvider } from '../../../src/auth/LocalDevAuthProvider.js';

describe('LocalDevAuthProvider', () => {
  let tmpDir: string;
  let keyFilePath: string;
  let provider: LocalDevAuthProvider;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-test-'));
    keyFilePath = path.join(tmpDir, 'auth-keypair.json');
    provider = new LocalDevAuthProvider({ keyFilePath });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('key pair generation', () => {
    it('should auto-generate a key pair on first use', async () => {
      await provider.issue('test-user');
      const stat = await fs.stat(keyFilePath);
      expect(stat.isFile()).toBe(true);
    });

    it('should reuse existing key pair on subsequent calls', async () => {
      const token1 = await provider.issue('user-a');
      const stat1 = await fs.stat(keyFilePath);

      const provider2 = new LocalDevAuthProvider({ keyFilePath });
      const token2 = await provider2.issue('user-b');
      const stat2 = await fs.stat(keyFilePath);

      // Same file, not regenerated
      expect(stat1.mtimeMs).toBe(stat2.mtimeMs);
      // Different tokens for different subjects
      expect(token1).not.toBe(token2);
    });
  });

  describe('issue and validate round-trip', () => {
    it('should issue a valid JWT that validates successfully', async () => {
      const token = await provider.issue('alice');
      const result = await provider.validate(token);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.claims.sub).toBe('alice');
      }
    });

    it('should include display name and email in claims', async () => {
      const token = await provider.issue('bob', {
        displayName: 'Bob Smith',
        email: 'bob@example.com',
      });
      const result = await provider.validate(token);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.claims.sub).toBe('bob');
        expect(result.claims.displayName).toBe('Bob Smith');
        expect(result.claims.email).toBe('bob@example.com');
      }
    });

    it('should include scopes in claims', async () => {
      const token = await provider.issue('admin', {
        scopes: ['read', 'write', 'admin'],
      });
      const result = await provider.validate(token);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.claims.scopes).toEqual(['read', 'write', 'admin']);
      }
    });

    it('should set expiration from ttlSeconds', async () => {
      const token = await provider.issue('user', { ttlSeconds: 3600 });
      const result = await provider.validate(token);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.claims.exp).toBeDefined();
        const nowSecs = Math.floor(Date.now() / 1000);
        expect(result.claims.exp!).toBeGreaterThan(nowSecs);
        expect(result.claims.exp!).toBeLessThanOrEqual(nowSecs + 3601);
      }
    });
  });

  describe('validation failures', () => {
    it('should reject a malformed token', async () => {
      const result = await provider.validate('not-a-jwt');
      expect(result.ok).toBe(false);
    });

    it('should reject a token with wrong signature', async () => {
      const token = await provider.issue('user');
      // Tamper with the signature (last segment)
      const parts = token.split('.');
      parts[2] = parts[2].split('').reverse().join('');
      const tampered = parts.join('.');

      const result = await provider.validate(tampered);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('signature');
      }
    });

    it('should reject an expired token', async () => {
      const token = await provider.issue('user', { ttlSeconds: 0 });
      // Wait a moment for the token to expire
      await new Promise(r => setTimeout(r, 1100));

      const result = await provider.validate(token);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('expired');
      }
    });

    it('should reject a token signed by a different key pair', async () => {
      const otherKeyFile = path.join(tmpDir, 'other-keypair.json');
      const otherProvider = new LocalDevAuthProvider({ keyFilePath: otherKeyFile });
      const token = await otherProvider.issue('user');

      const result = await provider.validate(token);
      expect(result.ok).toBe(false);
    });
  });

  describe('provider metadata', () => {
    it('should have name "local-dev"', () => {
      expect(provider.name).toBe('local-dev');
    });
  });
});
