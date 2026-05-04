import { describe, it, expect } from '@jest/globals';
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
      expect(resolveAuthMethods(config)).toEqual(['trivial-consent']);
    });

    it('honors explicit methods config', () => {
      const config: AuthConfig = {
        enabled: true,
        provider: 'embedded',
        methods: ['trivial-consent', 'github'],
      };
      expect(resolveAuthMethods(config)).toEqual(['trivial-consent', 'github']);
    });

    it('returns empty methods list for oidc provider (bypasses embedded-AS methods)', () => {
      const config: AuthConfig = { enabled: true, provider: 'oidc' };
      expect(resolveAuthMethods(config)).toEqual([]);
    });

    it('ignores explicit methods when provider=oidc', () => {
      const config: AuthConfig = {
        enabled: true,
        provider: 'oidc',
        methods: ['trivial-consent'],
      };
      expect(resolveAuthMethods(config)).toEqual([]);
    });
  });

  describe('AuthMethodFactory validation', () => {
    it('rejects unregistered methods', async () => {
      const factory = new AuthMethodFactory();
      // Intentionally do NOT register 'github'
      factory.register('trivial-consent');

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
      // 'trivial-consent' is registered by default; this should not throw at validation.
      // We catch errors from later construction (key file IO etc.) and only assert
      // the validation step passes.
      const result = await createAuthProvider({
        enabled: true,
        provider: 'embedded',
        methods: ['trivial-consent'],
        methodFactory: factory,
        publicBaseUrl: 'http://127.0.0.1:65530',
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
      expect(factory.has('trivial-consent')).toBe(true);
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
});
