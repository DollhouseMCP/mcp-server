import type { Env } from '../../config/env.js';
import { resolveSmtpConfiguration, type SmtpConfiguration } from '../../auth/embedded-as/methods/smtpConfiguration.js';
import { invitationPublicOrigin } from '../InvitationClaimLink.js';
import { isSupportedInvitationEmail } from '../InvitationEmail.js';

export type PrivateBetaOnboardingEnv = Pick<Env,
  | 'DOLLHOUSE_BETA_ONBOARDING_ENABLED' | 'DOLLHOUSE_ONBOARDING_SUPPORT_EMAIL'
  | 'DOLLHOUSE_TRANSPORT' | 'DOLLHOUSE_AUTH_ENABLED' | 'DOLLHOUSE_AUTH_PROVIDER'
  | 'DOLLHOUSE_AUTH_METHODS' | 'DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED'
  | 'DOLLHOUSE_STORAGE_BACKEND' | 'DOLLHOUSE_AUTH_STORAGE_BACKEND' | 'DOLLHOUSE_RATE_LIMIT_BACKEND'
  | 'DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED' | 'DOLLHOUSE_HTTP_WEB_CONSOLE' | 'DOLLHOUSE_PUBLIC_BASE_URL'
  | 'DOLLHOUSE_AUTH_GITHUB_CLIENT_ID' | 'DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET'
  | 'DOLLHOUSE_SMTP_HOST' | 'DOLLHOUSE_SMTP_PORT' | 'DOLLHOUSE_SMTP_USER'
  | 'DOLLHOUSE_SMTP_PASSWORD' | 'DOLLHOUSE_SMTP_FROM'>;

export interface PrivateBetaOnboardingConfiguration {
  readonly publicBaseUrl: string;
  readonly supportEmail: string;
  readonly github: { readonly clientId: string; readonly clientSecret: string };
  readonly smtp: SmtpConfiguration;
}

/** Pure configuration validation. Does not register routes, connect, send, or log values. */
export function resolvePrivateBetaOnboardingConfiguration(
  source: PrivateBetaOnboardingEnv,
): PrivateBetaOnboardingConfiguration | null {
  if (!source.DOLLHOUSE_BETA_ONBOARDING_ENABLED) return null;
  requireConfiguration(source.DOLLHOUSE_TRANSPORT === 'streamable-http', 'streamable-http transport');
  requireConfiguration(source.DOLLHOUSE_AUTH_ENABLED && source.DOLLHOUSE_AUTH_PROVIDER === 'embedded' &&
    source.DOLLHOUSE_AUTH_METHODS?.includes('github') === true &&
    !source.DOLLHOUSE_AUTH_METHODS.includes('trivial-consent') && source.DOLLHOUSE_AUTH_ALLOWLIST_REQUIRED,
  'embedded GitHub authentication with the sign-in allowlist required');
  requireConfiguration(source.DOLLHOUSE_STORAGE_BACKEND === 'database' &&
    source.DOLLHOUSE_AUTH_STORAGE_BACKEND === 'postgres' && source.DOLLHOUSE_RATE_LIMIT_BACKEND === 'postgres',
  'PostgreSQL database, authentication storage, and rate limiting');
  requireConfiguration(source.DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED && !source.DOLLHOUSE_HTTP_WEB_CONSOLE,
    'the descriptor console API with the legacy HTTP console disabled');
  const publicBaseUrl = invitationPublicOrigin(source.DOLLHOUSE_PUBLIC_BASE_URL ?? '');
  const supportEmail = (source.DOLLHOUSE_ONBOARDING_SUPPORT_EMAIL ?? '').normalize('NFC').trim();
  requireConfiguration(isSupportedInvitationEmail(supportEmail), 'DOLLHOUSE_ONBOARDING_SUPPORT_EMAIL');
  requireConfiguration(typeof source.DOLLHOUSE_AUTH_GITHUB_CLIENT_ID === 'string' &&
    /^[A-Za-z0-9_-]{1,256}$/.test(source.DOLLHOUSE_AUTH_GITHUB_CLIENT_ID), 'DOLLHOUSE_AUTH_GITHUB_CLIENT_ID');
  const github = {
    clientId: requiredCredential(source.DOLLHOUSE_AUTH_GITHUB_CLIENT_ID, 'DOLLHOUSE_AUTH_GITHUB_CLIENT_ID'),
    clientSecret: requiredCredential(source.DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET, 'DOLLHOUSE_AUTH_GITHUB_CLIENT_SECRET'),
  };
  const smtp = resolveSmtpConfiguration({ host: source.DOLLHOUSE_SMTP_HOST, port: source.DOLLHOUSE_SMTP_PORT,
    user: source.DOLLHOUSE_SMTP_USER, password: source.DOLLHOUSE_SMTP_PASSWORD, from: source.DOLLHOUSE_SMTP_FROM });
  requireConfiguration(!source.DOLLHOUSE_AUTH_METHODS.includes('magic-link') || smtp.state === 'enabled',
    'complete SMTP configuration when magic-link authentication is enabled');
  return { publicBaseUrl, supportEmail, github, smtp };
}

function requireConfiguration(valid: boolean, requirement: string): asserts valid {
  if (!valid) throw new Error(`Private beta onboarding requires ${requirement}.`);
}
function requiredCredential(value: string | undefined, name: string): string {
  requireConfiguration(typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
    !/[\s\p{Cc}\p{Cf}]/u.test(value), name);
  return value as string;
}
