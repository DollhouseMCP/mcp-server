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

export class NodemailerEmailSender implements EmailSender {
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
}

function escapeHtmlAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
}
