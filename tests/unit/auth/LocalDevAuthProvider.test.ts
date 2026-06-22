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
    // mcp scope is mandatory at validate (M3/Q6); positive-control tests
    // pass it explicitly. The negative-path test below pins the rejection
    // when it's missing.
    it('should issue a valid JWT that validates successfully', async () => {
      const token = await provider.issue('alice', { scopes: ['mcp'] });
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
        scopes: ['mcp'],
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
        scopes: ['mcp', 'read', 'write', 'admin'],
      });
      const result = await provider.validate(token);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.claims.scopes).toEqual(['mcp', 'read', 'write', 'admin']);
      }
    });

    it('should set expiration from ttlSeconds', async () => {
      const token = await provider.issue('user', { ttlSeconds: 3600, scopes: ['mcp'] });
      const result = await provider.validate(token);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.claims.exp).toBeDefined();
        const nowSecs = Math.floor(Date.now() / 1000);
        expect(result.claims.exp!).toBeGreaterThan(nowSecs);
        expect(result.claims.exp!).toBeLessThanOrEqual(nowSecs + 3601);
      }
    });

    it('rejects a token that lacks the mcp scope (M3/Q6)', async () => {
      const token = await provider.issue('user', { scopes: ['read', 'write'] });
      const result = await provider.validate(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/mcp scope/);

      const noScopes = await provider.issue('user');
      const noScopesResult = await provider.validate(noScopes);
      expect(noScopesResult.ok).toBe(false);
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

    // Cycle-13 fix: JOSEAlgNotAllowed branch added for cross-provider
    // parity with EmbeddedAS and OIDC. validate() pins ES256; an HS256
    // token (alg-confusion shape) hits the new branch.
    it('rejects an HS256 token with reason "algorithm not allowed"', async () => {
      const { createHmac } = await import('node:crypto');
      const now = Math.floor(Date.now() / 1000);
      const header = { alg: 'HS256', typ: 'JWT' };
      const payload = {
        iss: 'dollhousemcp-local',
        aud: 'dollhousemcp',
        sub: 'attacker',
        iat: now,
        exp: now + 3600,
        scopes: ['mcp'],
      };
      const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = createHmac('sha256', 'guess-the-secret')
        .update(`${headerB64}.${payloadB64}`)
        .digest('base64url');
      const result = await provider.validate(`${headerB64}.${payloadB64}.${sig}`);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('algorithm not allowed');
      }
    });
  });

  describe('provider metadata', () => {
    it('should have name "local-dev"', () => {
      expect(provider.name).toBe('local-dev');
    });
  });
});
