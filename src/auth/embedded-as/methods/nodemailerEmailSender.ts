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
import { domainToASCII } from 'node:url';
import { logger } from '../../../utils/logger.js';
import type { EmailSender, SendMagicLinkInput } from './MagicLinkMethod.js';
import { isSupportedInvitationEmail } from '../../../invitations/InvitationEmail.js';
import {
  classifyEmailSubmissionFailure,
  type EmailSubmissionResult, type TransactionalEmail, type TransactionalEmailSender,
} from './TransactionalEmailSender.js';

export interface NodemailerEmailSenderOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  /** Implicit TLS (true for port 465). Defaults based on port. */
  secure?: boolean;
  /** Connect timeout in ms (default 30s). Tests dial it down for fast failure. */
  connectionTimeoutMs?: number;
}

export class NodemailerEmailSender implements EmailSender, TransactionalEmailSender {
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly host: string;
  private readonly port: number;

  constructor(options: NodemailerEmailSenderOptions) {
    const secure = options.secure ?? options.port === 465;
    if (!secure && options.port !== 587) {
      // STARTTLS-mandatory: only port 587 (STARTTLS) or 465 (implicit TLS)
      // are accepted. Plaintext SMTP on 25 / 2525 is refused.
      throw new Error(
        `SMTP misconfigured: port ${options.port} is not a TLS-supporting port. ` +
        `Use 465 (implicit TLS) or 587 (STARTTLS).`,
      );
    }
    const timeoutMs = options.connectionTimeoutMs ?? 30_000;
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure,
      requireTLS: !secure, // force STARTTLS upgrade on 587
      auth: { user: options.user, pass: options.password },
      // Cycle-16 fix: cover all three timeout phases. connectionTimeout
      // gates TCP connect; greetingTimeout gates the SMTP banner;
      // socketTimeout gates inactivity during DATA. Without socketTimeout
      // a relay that accepts connections but hangs during DATA would
      // wedge sendMail forever, holding Express response objects open.
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
    });
    this.from = options.from;
    this.host = options.host;
    this.port = options.port;
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
    } catch (err) {
      throw new Error(
        `SMTP verify failed for ${this.host}:${this.port}. ` +
        `Confirm the server supports STARTTLS (port 587) or implicit TLS (port 465), ` +
        `and that DOLLHOUSE_SMTP_USER/PASSWORD authenticate successfully. ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
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
    message.to = validateTransactionalMessage(message);
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

function validateTransactionalMessage(message: TransactionalEmail): string {
  if (typeof message.to !== 'string' || /[\p{Cc}\p{Cf}]/u.test(message.to)) {
    throw new Error('Invalid transactional email recipient');
  }
  const recipient = message.to.normalize('NFC').trim();
  if (!isSupportedInvitationEmail(recipient)) {
    throw new Error('Invalid transactional email recipient');
  }
  // Identity comparison lowercases email; SMTP preserves the local-part case.
  // Unicode case folding can change byte lengths, so bound the actual address.
  const [localPart, domain] = recipient.split('@');
  const wireDomain = domainToASCII(domain);
  const wireRecipient = `${localPart}@${wireDomain}`;
  if (Buffer.byteLength(recipient, 'utf8') > 254 || Buffer.byteLength(localPart, 'utf8') > 64
      || !wireDomain || Buffer.byteLength(wireRecipient, 'utf8') > 254
      || wireDomain.split('.').some(label => label.length > 63)) {
    throw new Error('Invalid transactional email recipient');
  }
  // Supply the validated ASCII domain explicitly so SMTP serialization cannot
  // expand a Unicode domain beyond its label/mailbox limits after validation.
  if (typeof message.subject !== 'string' || message.subject.trim() === ''
      || Buffer.byteLength(message.subject, 'utf8') > 200 || /[\p{Cc}\p{Cf}]/u.test(message.subject)) {
    throw new Error('Invalid transactional email subject');
  }
  for (const body of [message.text, message.html]) {
    if (typeof body !== 'string' || body.trim() === '' || Buffer.byteLength(body, 'utf8') > 65_536) {
      throw new Error('Invalid transactional email body');
    }
  }
  return wireRecipient;
}

function escapeHtmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
