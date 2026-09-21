import { describe, expect, it } from '@jest/globals';
import { resolvePrivateBetaOnboardingConfiguration as resolve, type PrivateBetaOnboardingEnv } from '../../../../src/invitations/onboarding/PrivateBetaOnboardingConfiguration.js';

const enabled = (): PrivateBetaOnboardingEnv => ({
  DOLLHOUSE_BETA_ONBOARDING_ENABLED: true, DOLLHOUSE_ONBOARDING_SUPPORT_EMAIL: 'Beta.Support@example.test',
  DOLLHOUSE_TRANSPORT: 'streamable-http', DOLLHOUSE_AUTH_ENABLED: true, DOLLHOUSE_AUTH_PROVIDER: 'embedded',
  DOLLHOUSE_AUTH_METHODS: ['github'], DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED: true,
  DOLLHOUSE_STORAGE_BACKEND: 'database', DOLLHOUSE_AUTH_STORAGE_BACKEND: 'postgres', DOLLHOUSE_RATE_LIMIT_BACKEND: 'postgres',
  DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED: true, DOLLHOUSE_HTTP_WEB_CONSOLE: false,
  DOLLHOUSE_PUBLIC_BASE_URL: 'https://beta.example.test/',
  DOLLHOUSE_AUTH_GITHUB_CLIENT_ID: 'auth-client', DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET: 'auth-secret',
});

describe('private beta onboarding configuration', () => {
  it('does not validate or enable dormant configuration', () => {
    expect(resolve({ ...enabled(), DOLLHOUSE_BETA_ONBOARDING_ENABLED: false,
      DOLLHOUSE_SMTP_PASSWORD: 'partial-secret', DOLLHOUSE_PUBLIC_BASE_URL: 'invalid' })).toBeNull();
  });
  it('canonicalizes the trusted origin and preserves support mailbox spelling in manual mode', () => {
    expect(resolve(enabled())).toEqual({ publicBaseUrl: 'https://beta.example.test',
      supportEmail: 'Beta.Support@example.test', github: { clientId: 'auth-client', clientSecret: 'auth-secret' },
      smtp: { state: 'disabled' } });
  });
  it.each<Partial<PrivateBetaOnboardingEnv>>([
    { DOLLHOUSE_TRANSPORT: 'stdio' }, { DOLLHOUSE_AUTH_ENABLED: false }, { DOLLHOUSE_AUTH_PROVIDER: 'local' },
    { DOLLHOUSE_AUTH_METHODS: ['local-password'] }, { DOLLHOUSE_AUTH_METHODS: ['github', 'trivial-consent'] }, { DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED: false },
    { DOLLHOUSE_STORAGE_BACKEND: 'file' }, { DOLLHOUSE_AUTH_STORAGE_BACKEND: undefined },
    { DOLLHOUSE_AUTH_STORAGE_BACKEND: 'filesystem' }, { DOLLHOUSE_RATE_LIMIT_BACKEND: 'memory' },
    { DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED: false }, { DOLLHOUSE_HTTP_WEB_CONSOLE: true },
    { DOLLHOUSE_PUBLIC_BASE_URL: 'http://beta.example.test' }, { DOLLHOUSE_PUBLIC_BASE_URL: 'https://beta.example.test/path' },
    { DOLLHOUSE_ONBOARDING_SUPPORT_EMAIL: undefined }, { DOLLHOUSE_ONBOARDING_SUPPORT_EMAIL: 'bad-mailbox' },
    { DOLLHOUSE_AUTH_GITHUB_CLIENT_ID: undefined }, { DOLLHOUSE_AUTH_GITHUB_CLIENT_ID: 'x'.repeat(257) },
    { DOLLHOUSE_AUTH_GITHUB_CLIENT_ID: 'id.with.punctuation' }, { DOLLHOUSE_AUTH_GITHUB_CLIENT_ID: 'clienté' },
    { DOLLHOUSE_AUTH_METHODS: ['github', 'magic-link'] }, { DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET: undefined },
    { DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET: 'secret\nvalue' }, { DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET: 'x'.repeat(4097) },
  ])('fails closed for incompatible or incomplete settings (case %#)', overrides => {
    expect(() => resolve({ ...enabled(), ...overrides })).toThrow();
  });
  it('supports preexisting non-GitHub login methods without weakening the invitation cohort policy', () => {
    expect(resolve({ ...enabled(), DOLLHOUSE_AUTH_METHODS: ['github', 'local-password'] })).not.toBeNull();
  });
  it('reuses validated SMTP policy and rejects partial configuration without exposing secrets', () => {
    const source = { ...enabled(), DOLLHOUSE_SMTP_HOST: 'smtp.example.test', DOLLHOUSE_SMTP_USER: 'resend',
      DOLLHOUSE_SMTP_PASSWORD: 'smtp-sensitive-secret', DOLLHOUSE_SMTP_FROM: 'Beta@example.test' };
    expect(resolve(source)?.smtp).toMatchObject({ state: 'enabled', options: { port: 587, secure: false, tlsMode: 'starttls' } });
    let message = '';
    try { resolve({ ...source, DOLLHOUSE_SMTP_FROM: undefined }); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('DOLLHOUSE_SMTP_FROM');
    expect(message).not.toContain(source.DOLLHOUSE_SMTP_PASSWORD);
    expect(message).not.toContain(source.DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET);
  });
});
