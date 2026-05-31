import { describe, it, expect, afterEach } from '@jest/globals';
import {
  selectAuthMode,
  resolveAuthMethods,
  createAuthProvider,
  type AuthConfig,
} from '../../../src/auth/AuthProviderFactory.js';
import {
  AuthMethodFactory,
  createDefaultAuthMethodFactory,
} from '../../../src/auth/embedded-as/AuthMethodFactory.js';
import { InMemoryAuthStorageLayer } from '../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { InMemoryRateLimitStore } from '../../../src/auth/embedded-as/storage/InMemoryRateLimitStore.js';
import { InMemorySigningKeyStore } from '../../../src/storage/signingKeys/InMemorySigningKeyStore.js';
import type { SignInAllowlistAuthority } from '../../../src/auth/embedded-as/allowlistGate.js';

const TRIVIAL_CONSENT_ID = 'trivial-consent';
const LOOPBACK_BASE_URL = 'http://127.0.0.1:65530';
const ALICE_EMAIL = 'alice@example.com';

describe('AuthProviderFactory two-level structure', () => {
  describe('selectAuthMode', () => {
    it('routes local to embedded mode', () => {
      expect(selectAuthMode('local')).toBe('embedded');
    });

    it('routes embedded to embedded mode', () => {
      expect(selectAuthMode('embedded')).toBe('embedded');
    });

    it('routes oidc to oidc-bridge mode', () => {
      expect(selectAuthMode('oidc')).toBe('oidc-bridge');
    });
  });

  describe('resolveAuthMethods', () => {
    it('defaults to trivial-consent for embedded mode', () => {
      const config: AuthConfig = { enabled: true, provider: 'embedded' };
      expect(resolveAuthMethods(config)).toEqual([TRIVIAL_CONSENT_ID]);
    });

    it('honors explicit methods config', () => {
      const config: AuthConfig = {
        enabled: true,
        provider: 'embedded',
        methods: [TRIVIAL_CONSENT_ID, 'github'],
      };
      expect(resolveAuthMethods(config)).toEqual([TRIVIAL_CONSENT_ID, 'github']);
    });

    it('returns empty methods list for oidc provider (bypasses embedded-AS methods)', () => {
      const config: AuthConfig = { enabled: true, provider: 'oidc' };
      expect(resolveAuthMethods(config)).toEqual([]);
    });

    it('ignores explicit methods when provider=oidc', () => {
      const config: AuthConfig = {
        enabled: true,
        provider: 'oidc',
        methods: [TRIVIAL_CONSENT_ID],
      };
      expect(resolveAuthMethods(config)).toEqual([]);
    });
  });

  describe('AuthMethodFactory validation', () => {
    it('rejects unregistered methods', async () => {
      const factory = new AuthMethodFactory();
      // Intentionally do NOT register 'github'
      factory.register(TRIVIAL_CONSENT_ID);

      await expect(
        createAuthProvider({
          enabled: true,
          provider: 'embedded',
          methods: ['github'],
          methodFactory: factory,
        }),
      ).rejects.toThrow(/methods are not registered: github/);
    });

    it('accepts methods registered in the default factory', async () => {
      const factory = createDefaultAuthMethodFactory();
      // TRIVIAL_CONSENT_ID is registered by default; this should not throw at validation.
      // We catch errors from later construction (key file IO etc.) and only assert
      // the validation step passes.
      const result = await createAuthProvider({
        enabled: true,
        provider: 'embedded',
        methods: [TRIVIAL_CONSENT_ID],
        methodFactory: factory,
        publicBaseUrl: LOOPBACK_BASE_URL,
      }).catch(err => err);
      // Either we got a provider back, or the failure is NOT about method registration.
      if (result instanceof Error) {
        expect(result.message).not.toMatch(/methods are not registered/);
      } else {
        expect(result).toBeDefined();
      }
    });

    it('returns null when auth is disabled (no validation)', async () => {
      const factory = new AuthMethodFactory(); // empty registry
      const provider = await createAuthProvider({
        enabled: false,
        provider: 'embedded',
        methods: ['github'], // would fail validation if checked
        methodFactory: factory,
      });
      expect(provider).toBeNull();
    });
  });

  describe('createDefaultAuthMethodFactory', () => {
    it('registers trivial-consent', () => {
      const factory = createDefaultAuthMethodFactory();
      expect(factory.has(TRIVIAL_CONSENT_ID)).toBe(true);
    });

    it('registers github (C7)', () => {
      const factory = createDefaultAuthMethodFactory();
      expect(factory.has('github')).toBe(true);
    });

    it('registers Stage C methods (C8): local-password, magic-link', () => {
      const factory = createDefaultAuthMethodFactory();
      expect(factory.has('local-password')).toBe(true);
      expect(factory.has('magic-link')).toBe(true);
    });

    it('does NOT include oidc-bridge in the method ID type union (use DOLLHOUSE_AUTH_PROVIDER=oidc instead)', () => {
      // The scaffold method was removed from AuthMethodId in C9. The legacy
      // `provider: oidc` branch in AuthProviderFactory constructs OidcAuthProvider
      // directly, bypassing the embedded-AS method system entirely.
      const factory = createDefaultAuthMethodFactory();
      // Cast through unknown to assert runtime behavior on a string the type
      // system would otherwise reject.
      expect(factory.has('oidc-bridge' as unknown as Parameters<typeof factory.has>[0])).toBe(false);
    });
  });

  describe('invite secret store wiring', () => {
    it('uses the injected signing-key store for local-password invites', async () => {
      const storage = new InMemoryAuthStorageLayer();
      const signingKeyStore = new InMemorySigningKeyStore();

      const provider = await createAuthProvider({
        enabled: true,
        provider: 'embedded',
        methods: ['local-password'],
        storage,
        signingKeyStore,
        rateLimitStore: new InMemoryRateLimitStore(),
        publicBaseUrl: LOOPBACK_BASE_URL,
      });

      expect(provider).toBeDefined();
      const active = await signingKeyStore.getActive('invite');
      expect(active).not.toBeNull();
      expect(active?.payload.secret).toEqual(expect.any(String));
    });
  });

  describe('sign-in allowlist authority cutover', () => {
    it('accepts cutover when legacy auth_allowlist entries are represented by the injected authority', async () => {
      const storage = new InMemoryAuthStorageLayer();
      await storage.allowlistAdd({ kind: 'email', value: ALICE_EMAIL });

      const provider = await createAuthProvider({
        enabled: true,
        provider: 'embedded',
        methods: ['local-password'],
        storage,
        signingKeyStore: new InMemorySigningKeyStore(),
        rateLimitStore: new InMemoryRateLimitStore(),
        publicBaseUrl: LOOPBACK_BASE_URL,
        signInAllowlistAuthority: fixedAuthority([{ kind: 'email', value: 'ALICE@example.com' }]),
      });

      expect(provider).toBeDefined();
    });

    it('refuses cutover when legacy auth_allowlist entries are missing from the injected authority', async () => {
      const storage = new InMemoryAuthStorageLayer();
      await storage.allowlistAdd({ kind: 'email', value: ALICE_EMAIL });

      await expect(createAuthProvider({
        enabled: true,
        provider: 'embedded',
        methods: ['local-password'],
        storage,
        signingKeyStore: new InMemorySigningKeyStore(),
        rateLimitStore: new InMemoryRateLimitStore(),
        publicBaseUrl: LOOPBACK_BASE_URL,
        signInAllowlistAuthority: fixedAuthority([]),
      })).rejects.toThrow(/cutover refused/);
    });
  });

  describe('trivial-consent reachability guard (must-fix #8)', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('refuses bind to 0.0.0.0 with trivial-consent (the canonical misconfig)', async () => {
      process.env.DOLLHOUSE_HTTP_HOST = '0.0.0.0';
      await expect(createAuthProvider({
        enabled: true,
        provider: 'embedded',
        methods: [TRIVIAL_CONSENT_ID],
      })).rejects.toThrow(/non-loopback bind '0\.0\.0\.0'/);
    });

    it('refuses bind to a public IP with trivial-consent', async () => {
      process.env.DOLLHOUSE_HTTP_HOST = '203.0.113.5';
      await expect(createAuthProvider({
        enabled: true,
        provider: 'embedded',
        methods: [TRIVIAL_CONSENT_ID],
      })).rejects.toThrow(/non-loopback bind/);
    });

    it('refuses publicBaseUrl=https://public.example.com with trivial-consent (proxy-fronted loopback bind is still externally reachable)', async () => {
      process.env.DOLLHOUSE_HTTP_HOST = '127.0.0.1';
      await expect(createAuthProvider({
        enabled: true,
        provider: 'embedded',
        methods: [TRIVIAL_CONSENT_ID],
        publicBaseUrl: 'https://public.example.com',
      })).rejects.toThrow(/non-loopback public URL/);
    });

    it('accepts bind to 127.0.0.1 with trivial-consent', async () => {
      process.env.DOLLHOUSE_HTTP_HOST = '127.0.0.1';
      const provider = await createAuthProvider({
        enabled: true,
        provider: 'embedded',
        methods: [TRIVIAL_CONSENT_ID],
        publicBaseUrl: LOOPBACK_BASE_URL,
      });
      expect(provider).toBeDefined();
    });

    it('accepts bind to 127.0.0.2 with trivial-consent (covers 127.0.0.0/8)', async () => {
      process.env.DOLLHOUSE_HTTP_HOST = '127.0.0.2';
      const provider = await createAuthProvider({
        enabled: true,
        provider: 'embedded',
        methods: [TRIVIAL_CONSENT_ID],
        publicBaseUrl: 'http://127.0.0.2:65530',
      });
      expect(provider).toBeDefined();
    });

    it('accepts bind to ::1 with trivial-consent', async () => {
      process.env.DOLLHOUSE_HTTP_HOST = '::1';
      const provider = await createAuthProvider({
        enabled: true,
        provider: 'embedded',
        methods: [TRIVIAL_CONSENT_ID],
        publicBaseUrl: 'http://[::1]:65530', // NOSONAR — test asserts http:// IS accepted on loopback per assertSafePublicBaseUrl spec
      });
      expect(provider).toBeDefined();
    });

    it('does NOT trip the guard for non-trivial-consent methods on any bind', async () => {
      // github method on 0.0.0.0 — method-specific config is missing so
      // the GH constructor will throw, but it must throw with the GitHub
      // env-var message, not the trivial-consent guard.
      process.env.DOLLHOUSE_HTTP_HOST = '0.0.0.0';
      delete process.env.DOLLHOUSE_GITHUB_CLIENT_ID;
      await expect(createAuthProvider({
        enabled: true,
        provider: 'embedded',
        methods: ['github'],
      })).rejects.toThrow(/DOLLHOUSE_AUTH_GITHUB_CLIENT_ID/);
    });
  });

  describe('GitHub method env-var coverage (cycle-16 gap)', () => {
    const ORIGINAL_HOST = process.env.DOLLHOUSE_HTTP_HOST;
    const ORIGINAL_ID = process.env.DOLLHOUSE_GITHUB_CLIENT_ID;
    const ORIGINAL_SECRET = process.env.DOLLHOUSE_GITHUB_CLIENT_SECRET;
    const ORIGINAL_AUTH_ID = process.env.DOLLHOUSE_AUTH_GITHUB_CLIENT_ID;
    const ORIGINAL_AUTH_SECRET = process.env.DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET;

    afterEach(() => {
      if (ORIGINAL_HOST === undefined) delete process.env.DOLLHOUSE_HTTP_HOST;
      else process.env.DOLLHOUSE_HTTP_HOST = ORIGINAL_HOST;
      if (ORIGINAL_ID === undefined) delete process.env.DOLLHOUSE_GITHUB_CLIENT_ID;
      else process.env.DOLLHOUSE_GITHUB_CLIENT_ID = ORIGINAL_ID;
      if (ORIGINAL_SECRET === undefined) delete process.env.DOLLHOUSE_GITHUB_CLIENT_SECRET;
      else process.env.DOLLHOUSE_GITHUB_CLIENT_SECRET = ORIGINAL_SECRET;
      if (ORIGINAL_AUTH_ID === undefined) delete process.env.DOLLHOUSE_AUTH_GITHUB_CLIENT_ID;
      else process.env.DOLLHOUSE_AUTH_GITHUB_CLIENT_ID = ORIGINAL_AUTH_ID;
      if (ORIGINAL_AUTH_SECRET === undefined) delete process.env.DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET;
      else process.env.DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET = ORIGINAL_AUTH_SECRET;
    });

    it('rejects when DOLLHOUSE_GITHUB_CLIENT_SECRET is missing but ID is set', async () => {
      process.env.DOLLHOUSE_HTTP_HOST = '127.0.0.1';
      process.env.DOLLHOUSE_GITHUB_CLIENT_ID = 'gh-app-id';
      delete process.env.DOLLHOUSE_GITHUB_CLIENT_SECRET;
      await expect(createAuthProvider({
        enabled: true,
        provider: 'embedded',
        methods: ['github'],
      })).rejects.toThrow(/DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET/);
    });

    it('cycle-17: error message names BOTH new and legacy env-var pairs', async () => {
      // Operators landing on the throw should know which set of env
      // vars to set; either pair works. The message must mention both.
      process.env.DOLLHOUSE_HTTP_HOST = '127.0.0.1';
      delete process.env.DOLLHOUSE_AUTH_GITHUB_CLIENT_ID;
      delete process.env.DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET;
      delete process.env.DOLLHOUSE_GITHUB_CLIENT_ID;
      delete process.env.DOLLHOUSE_GITHUB_CLIENT_SECRET;
      try {
        await createAuthProvider({
          enabled: true,
          provider: 'embedded',
          methods: ['github'],
        });
        throw new Error('expected throw');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        expect(message).toMatch(/DOLLHOUSE_AUTH_GITHUB_CLIENT_ID/);
        expect(message).toMatch(/DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET/);
        expect(message).toMatch(/DOLLHOUSE_GITHUB_CLIENT_ID/);
        expect(message).toMatch(/DOLLHOUSE_GITHUB_CLIENT_SECRET/);
      }
    });
  });
});

function fixedAuthority(entries: readonly { readonly kind: 'email' | 'github_username' | 'github_id'; readonly value: string }[]): SignInAllowlistAuthority {
  return {
    hasAnyEntries: () => Promise.resolve(entries.length > 0),
    listEntries: () => Promise.resolve(entries.map((entry, index) => ({
      id: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
      kind: entry.kind,
      value: entry.value,
      note: null,
      createdBy: null,
      createdAt: new Date('2026-05-31T00:00:00.000Z'),
    }))),
    matchesIdentity: values => Promise.resolve(entries.some(entry => {
      if (entry.kind === 'email') return values.email?.toLowerCase() === entry.value.toLowerCase();
      if (entry.kind === 'github_username') return values.githubUsername?.toLowerCase() === entry.value.toLowerCase();
      return values.githubId === entry.value;
    })),
  };
}
