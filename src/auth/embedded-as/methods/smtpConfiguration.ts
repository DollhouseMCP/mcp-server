import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import {
  MAX_INVITATION_EMAIL_DOMAIN_LABEL_OCTETS,
  MAX_INVITATION_EMAIL_LOCAL_PART_OCTETS,
  MAX_INVITATION_EMAIL_OCTETS,
  isSupportedInvitationEmail,
} from '../../../invitations/InvitationEmail.js';

const DEFAULT_SMTP_PORT = 587;
const DEFAULT_SMTP_TIMEOUT_MS = 30_000;
const MAX_SMTP_TIMEOUT_MS = 120_000;
const MAX_SMTP_HOST_LENGTH = 253;
const MAX_SMTP_AUTH_FIELD_BYTES = 4_096;
const SMTP_HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const FORBIDDEN_CONFIGURATION_CHARACTER = /[\p{Cc}\p{Cf}]/u;

export type SmtpTlsMode = 'starttls' | 'implicit';
export type SmtpConfigurationErrorCode =
  | 'incomplete'
  | 'invalid_host'
  | 'invalid_port'
  | 'invalid_tls_mode'
  | 'invalid_auth'
  | 'invalid_sender'
  | 'invalid_timeout';

export class SmtpConfigurationError extends Error {
  constructor(readonly code: SmtpConfigurationErrorCode, missingFields: readonly string[] = []) {
    super(configurationErrorMessage(code, missingFields));
    this.name = 'SmtpConfigurationError';
  }
}

export interface SmtpConfigurationInput {
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  readonly password?: string;
  readonly from?: string;
  readonly secure?: boolean;
  readonly connectionTimeoutMs?: number;
}

export interface NodemailerEmailSenderOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly from: string;
  /** Implicit TLS. It must be true on port 465 and false on port 587. */
  readonly secure?: boolean;
  /** Covers connect, SMTP greeting, and socket inactivity. */
  readonly connectionTimeoutMs?: number;
}

export interface ValidatedSmtpOptions {
  readonly host: string;
  readonly port: 465 | 587;
  readonly user: string;
  readonly password: string;
  readonly from: string;
  readonly secure: boolean;
  readonly tlsMode: SmtpTlsMode;
  readonly connectionTimeoutMs: number;
}

export type SmtpConfiguration =
  | { readonly state: 'disabled' }
  | { readonly state: 'enabled'; readonly options: ValidatedSmtpOptions };

/**
 * Resolve optional environment-style SMTP settings without enabling email by
 * accident. An entirely absent configuration is a supported manual-delivery
 * mode; a partial configuration is an operator error.
 */
export function resolveSmtpConfiguration(input: SmtpConfigurationInput): SmtpConfiguration {
  const required = [
    ['DOLLHOUSE_SMTP_HOST', input.host],
    ['DOLLHOUSE_SMTP_USER', input.user],
    ['DOLLHOUSE_SMTP_PASSWORD', input.password],
    ['DOLLHOUSE_SMTP_FROM', input.from],
  ] as const;
  const hasOptionalSetting = input.port !== undefined
    || input.secure !== undefined || input.connectionTimeoutMs !== undefined;
  if (!hasOptionalSetting && required.every(([, value]) => value === undefined || value === '')) {
    return { state: 'disabled' };
  }
  const missing = required
    .filter(([, value]) => value === undefined || value === '')
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new SmtpConfigurationError('incomplete', missing);
  }
  return {
    state: 'enabled',
    options: validateSmtpOptions({
      host: input.host as string,
      port: input.port ?? DEFAULT_SMTP_PORT,
      user: input.user as string,
      password: input.password as string,
      from: input.from as string,
      secure: input.secure,
      connectionTimeoutMs: input.connectionTimeoutMs,
    }),
  };
}

/** Validate direct sender construction as well as environment-derived values. */
export function validateSmtpOptions(input: NodemailerEmailSenderOptions): ValidatedSmtpOptions {
  const host = validateHost(input.host);
  const port = validatePort(input.port);
  const expectedSecure = port === 465;
  if (input.secure !== undefined && input.secure !== expectedSecure) {
    throw new SmtpConfigurationError('invalid_tls_mode');
  }
  const user = validateAuthField(input.user, true);
  const password = validateAuthField(input.password, false);
  const from = validateSender(input.from);
  const connectionTimeoutMs = input.connectionTimeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS;
  if (!Number.isSafeInteger(connectionTimeoutMs)
      || connectionTimeoutMs <= 0 || connectionTimeoutMs > MAX_SMTP_TIMEOUT_MS) {
    throw new SmtpConfigurationError('invalid_timeout');
  }
  return {
    host,
    port,
    user,
    password,
    from,
    secure: expectedSecure,
    tlsMode: expectedSecure ? 'implicit' : 'starttls',
    connectionTimeoutMs,
  };
}

function validateHost(value: unknown): string {
  if (typeof value !== 'string') throw new SmtpConfigurationError('invalid_host');
  const host = value.trim();
  if (host !== value || host.length === 0 || host.length > MAX_SMTP_HOST_LENGTH
      || FORBIDDEN_CONFIGURATION_CHARACTER.test(host)) {
    throw new SmtpConfigurationError('invalid_host');
  }
  if (isIP(host) !== 0 || host === 'localhost') return host;
  const labels = host.split('.');
  if (labels.some(label => label.length === 0 || label.length > 63 || !SMTP_HOST_LABEL.test(label))) {
    throw new SmtpConfigurationError('invalid_host');
  }
  return host;
}

function validatePort(value: unknown): 465 | 587 {
  if (value !== 465 && value !== 587) throw new SmtpConfigurationError('invalid_port');
  return value;
}

function validateAuthField(value: unknown, trim: boolean): string {
  if (typeof value !== 'string' || FORBIDDEN_CONFIGURATION_CHARACTER.test(value)) {
    throw new SmtpConfigurationError('invalid_auth');
  }
  const validated = trim ? value.trim() : value;
  if (validated.trim().length === 0 || Buffer.byteLength(validated, 'utf8') > MAX_SMTP_AUTH_FIELD_BYTES) {
    throw new SmtpConfigurationError('invalid_auth');
  }
  return validated;
}

function validateSender(value: unknown): string {
  if (typeof value !== 'string' || FORBIDDEN_CONFIGURATION_CHARACTER.test(value)) {
    throw new SmtpConfigurationError('invalid_sender');
  }
  // Validate the exact NFC spelling used on the SMTP envelope. Identity
  // normalization is deliberately separate because it lowercases local parts.
  const sender = value.normalize('NFC').trim();
  if (!isSupportedInvitationEmail(sender)) {
    throw new SmtpConfigurationError('invalid_sender');
  }
  const at = sender.indexOf('@');
  const localPart = sender.slice(0, at);
  const domain = sender.slice(at + 1);
  const wireDomain = domainToASCII(domain);
  if (Buffer.byteLength(sender, 'utf8') > MAX_INVITATION_EMAIL_OCTETS
      || Buffer.byteLength(localPart, 'utf8') > MAX_INVITATION_EMAIL_LOCAL_PART_OCTETS
      || wireDomain === ''
      || Buffer.byteLength(localPart, 'utf8') + 1 + Buffer.byteLength(wireDomain, 'ascii')
        > MAX_INVITATION_EMAIL_OCTETS
      || wireDomain.split('.').some(label =>
        Buffer.byteLength(label, 'utf8') > MAX_INVITATION_EMAIL_DOMAIN_LABEL_OCTETS)) {
    throw new SmtpConfigurationError('invalid_sender');
  }
  return sender;
}

function configurationErrorMessage(
  code: SmtpConfigurationErrorCode,
  missingFields: readonly string[],
): string {
  switch (code) {
    case 'incomplete':
      return `SMTP configuration is incomplete. Set all SMTP settings or unset all of them. Missing: ${missingFields.join(', ')}.`;
    case 'invalid_host':
      return 'DOLLHOUSE_SMTP_HOST must be a hostname or IP address without a URL scheme, path, or credentials.';
    case 'invalid_port':
      return 'DOLLHOUSE_SMTP_PORT must be 587 for STARTTLS or 465 for implicit TLS.';
    case 'invalid_tls_mode':
      return 'SMTP TLS mode must use STARTTLS on port 587 or implicit TLS on port 465.';
    case 'invalid_auth':
      return 'DOLLHOUSE_SMTP_USER and DOLLHOUSE_SMTP_PASSWORD must be non-empty bounded values without control characters.';
    case 'invalid_sender':
      return 'DOLLHOUSE_SMTP_FROM must be one valid email address without a display name or header fields.';
    case 'invalid_timeout':
      return `SMTP timeout must be a positive integer no greater than ${MAX_SMTP_TIMEOUT_MS} milliseconds.`;
  }
}
