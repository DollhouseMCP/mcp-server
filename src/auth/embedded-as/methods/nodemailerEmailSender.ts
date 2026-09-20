/**
 * NodemailerEmailSender
 *
 * Production EmailSender that uses nodemailer over STARTTLS-mandatory SMTP.
 * Refuses to construct without TLS (must-fix #10): the operator must point
 * at an SMTP server that supports STARTTLS (or implicit TLS on port 465).
 *
 * Configuration via env (DOLLHOUSE_SMTP_*):
 *   - DOLLHOUSE_SMTP_HOST
 *   - DOLLHOUSE_SMTP_PORT (default 587 STARTTLS / 465 implicit)
 *   - DOLLHOUSE_SMTP_USER
 *   - DOLLHOUSE_SMTP_PASSWORD
 *   - DOLLHOUSE_SMTP_FROM (envelope-from address)
 *
 * @module auth/embedded-as/methods/nodemailerEmailSender
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { logger } from '../../../utils/logger.js';
import type { EmailSender, SendMagicLinkInput } from './MagicLinkMethod.js';
import { normalizeInvitationEmail } from '../../../invitations/InvitationEmail.js';
import {
  classifyEmailSubmissionFailure,
  type EmailSubmissionResult, type TransactionalEmail, type TransactionalEmailSender,
} from './TransactionalEmailSender.js';
import {
  validateSmtpOptions,
  type NodemailerEmailSenderOptions,
} from './smtpConfiguration.js';

export type { NodemailerEmailSenderOptions } from './smtpConfiguration.js';

export type SmtpReadinessFailureCategory =
  | 'authentication'
  | 'dns'
  | 'connection'
  | 'timeout'
  | 'tls'
  | 'protocol'
  | 'unknown';

/** Sanitized startup failure. It intentionally retains no upstream error or cause. */
export class SmtpReadinessError extends Error {
  constructor(readonly category: SmtpReadinessFailureCategory) {
    super(readinessErrorMessage(category));
    this.name = 'SmtpReadinessError';
  }
}

export class NodemailerEmailSender implements EmailSender, TransactionalEmailSender {
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly host: string;
  private readonly port: number;

  constructor(options: NodemailerEmailSenderOptions) {
    const validated = validateSmtpOptions(options);
    this.transporter = nodemailer.createTransport({
      host: validated.host,
      port: validated.port,
      secure: validated.secure,
      requireTLS: !validated.secure, // force STARTTLS upgrade on 587
      auth: { user: validated.user, pass: validated.password },
      // Cycle-16 fix: cover all three timeout phases. connectionTimeout
      // gates TCP connect; greetingTimeout gates the SMTP banner;
      // socketTimeout gates inactivity during DATA. Without socketTimeout
      // a relay that accepts connections but hangs during DATA would
      // wedge sendMail forever, holding Express response objects open.
      connectionTimeout: validated.connectionTimeoutMs,
      greetingTimeout: validated.connectionTimeoutMs,
      socketTimeout: validated.connectionTimeoutMs,
    });
    this.from = validated.from;
    this.host = validated.host;
    this.port = validated.port;
  }

  /**
   * Confirm the transporter can connect, negotiate TLS, and authenticate.
   * Called at startup by `AuthProviderFactory` so a misconfigured SMTP
   * server (refused STARTTLS, bad credentials, no DNS) fails fast with a
   * clear error rather than silently producing failed magic-link emails
   * later (must-fix #10).
   *
   * Wraps `nodemailer.Transporter.verify()`, which performs:
   *   - TCP connect + STARTTLS upgrade (or implicit TLS on 465)
   *   - AUTH probe with the configured credentials
   *
   * Failures bubble up as a single labelled `Error` the operator can act
   * on. Successful verify is logged at info so the operator sees the
   * SMTP connection working without enabling debug logs.
   */
  async verify(): Promise<void> {
    try {
      await this.transporter.verify();
      logger.info('[NodemailerEmailSender] SMTP connection verified', {
        host: this.host,
        port: this.port,
      });
    } catch (error) {
      throw new SmtpReadinessError(classifySmtpReadinessFailure(error));
    }
  }

  async sendMagicLink(input: SendMagicLinkInput): Promise<void> {
    // Cycle-16 fix: sanity-check URL length before drop-in to the email
    // body. An extremely long URL (interactionId injection, oversize
    // verifyUrl) would produce an email over typical MTA size limits
    // with no signal to the operator.
    if (input.url.length > 2048) {
      throw new Error(
        `magic-link URL exceeds 2048 chars (got ${input.url.length}); ` +
        `confirm DOLLHOUSE_PUBLIC_BASE_URL is reasonable.`,
      );
    }
    await this.transporter.sendMail({
      from: this.from,
      to: input.to,
      subject: 'Sign in to DollhouseMCP',
      text: `Click to sign in: ${input.url}\n\nThis link expires in 15 minutes.`,
      html: `<p>Click to sign in:</p><p><a href="${escapeHtmlAttr(input.url)}">${escapeHtmlAttr(input.url)}</a></p><p>This link expires in 15 minutes.</p>`,
    });
  }

  /**
   * Sends already-rendered multipart content without imposing magic-link copy
   * or lifetime. Callers must reserve a durable delivery attempt before calling
   * once, then record this sanitized result. No messages are persisted here.
   */
  async sendTransactionalEmail(input: TransactionalEmail): Promise<EmailSubmissionResult> {
    const message = { to: input.to, subject: input.subject, text: input.text, html: input.html };
    validateTransactionalMessage(message);
    message.to = message.to.normalize('NFC').trim();
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        // Structured single-recipient address prevents display-name/list parsing.
        to: { name: '', address: message.to },
        subject: message.subject,
        text: message.text,
        html: message.html,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (!Array.isArray(info.accepted) || info.accepted.length !== 1
          || !Array.isArray(info.rejected) || info.rejected.length !== 0) {
        return { state: 'unknown', failureClass: 'indeterminate' };
      }
      // Nodemailer's info.messageId is an RFC Message-ID generated locally,
      // not a provider-assigned ID. Never label or persist it as one, and do not
      // parse arbitrary SMTP response text for an undocumented provider ID.
      return { state: 'submitted', providerMessageId: null };
    } catch (error) {
      return classifyEmailSubmissionFailure(error);
    }
  }
}

export function classifySmtpReadinessFailure(error: unknown): SmtpReadinessFailureCategory {
  const candidate = error as { code?: unknown; responseCode?: unknown } | null;
  switch (candidate?.code) {
    case 'EAUTH': return 'authentication';
    case 'EDNS':
    case 'ENOTFOUND':
    case 'EAI_AGAIN': return 'dns';
    case 'ETIMEDOUT':
    case 'ETIMEOUT': return 'timeout';
    case 'ETLS':
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID': return 'tls';
    case 'ESOCKET':
    case 'ECONNECTION':
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH': return 'connection';
    case 'EPROTOCOL': return 'protocol';
  }
  if (candidate?.responseCode === 530 || candidate?.responseCode === 534
      || candidate?.responseCode === 535) return 'authentication';
  if (typeof candidate?.responseCode === 'number'
      && Number.isInteger(candidate.responseCode)
      && candidate.responseCode >= 400 && candidate.responseCode <= 599) return 'protocol';
  return 'unknown';
}

function readinessErrorMessage(category: SmtpReadinessFailureCategory): string {
  switch (category) {
    case 'authentication':
      return 'SMTP readiness failed: authentication was rejected. Check DOLLHOUSE_SMTP_USER and DOLLHOUSE_SMTP_PASSWORD.';
    case 'dns':
      return 'SMTP readiness failed: the server name could not be resolved. Check DOLLHOUSE_SMTP_HOST.';
    case 'connection':
      return 'SMTP readiness failed: the server could not be reached. Check the SMTP host, port, and network policy.';
    case 'timeout':
      return 'SMTP readiness failed: the connection timed out. Check server reachability and the configured timeout.';
    case 'tls':
      return 'SMTP readiness failed: TLS negotiation failed. Use STARTTLS on port 587 or implicit TLS on port 465.';
    case 'protocol':
      return 'SMTP readiness failed: the server rejected the verification exchange. Check the SMTP service configuration.';
    case 'unknown':
      return 'SMTP readiness failed for an unknown reason. Check the SMTP service configuration.';
  }
}

function validateTransactionalMessage(message: TransactionalEmail): void {
  if (typeof message.to !== 'string' || /[\p{Cc}\p{Cf}]/u.test(message.to)) {
    throw new Error('Invalid transactional email recipient');
  }
  try { normalizeInvitationEmail(message.to); } catch {
    throw new Error('Invalid transactional email recipient');
  }
  // Identity comparison lowercases email; SMTP preserves the local-part case.
  // Unicode case folding can change byte lengths, so bound the actual address.
  const recipient = message.to.normalize('NFC').trim();
  const [localPart, domain] = recipient.split('@');
  if (Buffer.byteLength(recipient, 'utf8') > 254 || Buffer.byteLength(localPart, 'utf8') > 64
      || domain.split('.').some(label => Buffer.byteLength(label, 'utf8') > 63)) {
    throw new Error('Invalid transactional email recipient');
  }
  if (typeof message.subject !== 'string' || message.subject.trim() === ''
      || Buffer.byteLength(message.subject, 'utf8') > 200 || /[\p{Cc}\p{Cf}]/u.test(message.subject)) {
    throw new Error('Invalid transactional email subject');
  }
  for (const body of [message.text, message.html]) {
    if (typeof body !== 'string' || body.trim() === '' || Buffer.byteLength(body, 'utf8') > 65_536) {
      throw new Error('Invalid transactional email body');
    }
  }
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
