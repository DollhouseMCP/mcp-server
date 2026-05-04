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
import type { EmailSender, SendMagicLinkInput } from './MagicLinkMethod.js';

export interface NodemailerEmailSenderOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
  /** Implicit TLS (true for port 465). Defaults based on port. */
  secure?: boolean;
}

export class NodemailerEmailSender implements EmailSender {
  private readonly transporter: Transporter;
  private readonly from: string;

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
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure,
      requireTLS: !secure, // force STARTTLS upgrade on 587
      auth: { user: options.user, pass: options.password },
    });
    this.from = options.from;
  }

  async sendMagicLink(input: SendMagicLinkInput): Promise<void> {
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
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
