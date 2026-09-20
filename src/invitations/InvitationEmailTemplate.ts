import { MIN_INVITATION_TTL_HOURS, MAX_INVITATION_TTL_HOURS } from './InvitationConfig.js';
import { normalizeInvitationEmail } from './InvitationEmail.js';
import { buildInvitationClaimLink } from './InvitationClaimLink.js';

export interface InvitationEmailAccess {
  /** Human-facing role name and description from the caller's role catalog. */
  readonly name: string;
  readonly description: string;
}

export interface InvitationEmailTemplateInput {
  readonly publicBaseUrl: string;
  /** One-time issue/regenerate response only. Never recover from persistent data. */
  readonly credential: string;
  readonly recipientName?: string | null;
  readonly intendedAccess: readonly InvitationEmailAccess[];
  /** Persisted server timestamps; never substitute the generic magic-link TTL. */
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly supportEmail: string;
}

/** Credential-bearing body parts: transient only; do not log/cache/persist. */
export interface InvitationEmailTemplate {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export const INVITATION_EMAIL_SUBJECT = 'Your DollhouseMCP private-beta invitation';

/** Pure rendering only: no SMTP calls, provider metadata, analytics or headers. */
export function renderInvitationEmail(input: InvitationEmailTemplateInput): InvitationEmailTemplate {
  const link = buildInvitationClaimLink(input.publicBaseUrl, input.credential);
  const name = input.recipientName == null ? null : safeText(input.recipientName, 255);
  if (!Array.isArray(input.intendedAccess) || input.intendedAccess.length > 16) invalidTemplate();
  const access = input.intendedAccess.map(role => ({
    name: safeText(role.name, 120), description: safeText(role.description, 500),
  }));
  let support: string;
  try {
    const normalized = normalizeInvitationEmail(input.supportEmail);
    // Operator contact addresses are not recipient identity keys: local-part
    // casing may identify a different mailbox and must survive validation.
    const original = input.supportEmail.normalize('NFC').trim();
    support = original.slice(0, original.indexOf('@')) + normalized.slice(normalized.indexOf('@'));
  } catch { return invalidTemplate(); }
  // Preserve addr-spec's single @ delimiter while encoding local-part URI
  // metacharacters: ?/#/& must never become mailto query or fragment syntax.
  const separator = support.indexOf('@');
  const supportHref = `mailto:${encodeURIComponent(support.slice(0, separator))}@${encodeURIComponent(support.slice(separator + 1))}`;
  const hours = lifetimeHours(input.issuedAt, input.expiresAt);
  const duration = `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const expiry = input.expiresAt.toISOString().replace('T', ' ').replace('.000Z', ' UTC').replace('Z', ' UTC');
  const greeting = name ? `Hello ${name},` : 'Hello,';
  const accessText = access.length
    ? access.map(role => `- ${role.name}: ${role.description}`).join('\n')
    : 'Your account access will be shown during onboarding.';
  const expiration = `This invitation is valid for ${duration} from issue and expires at ${expiry}.`;
  const github = 'A GitHub account is required to activate your account. No Dollhouse password will be created.';
  const singleUse = 'This link is single-use. Newer invitations invalidate older links. Do not forward this email.';
  const unexpected = 'If you did not expect this invitation, you can ignore it. No account is activated until onboarding is complete.';
  const text = [
    'DollhouseMCP private beta', greeting,
    'You are invited to join the DollhouseMCP private beta.',
    'Accept invitation:', link, github, 'Intended access:', accessText,
    expiration, singleUse, unexpected, `Questions or need a new invitation? Contact ${support}.`,
  ].join('\n\n');
  const accessHtml = access.length
    ? `<ul>${access.map(role => `<li><strong>${escapeHtml(role.name)}</strong>: ${escapeHtml(role.description)}</li>`).join('')}</ul>`
    : `<p>${escapeHtml(accessText)}</p>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>DollhouseMCP private beta</title></head>
<body style="font-family:Arial,sans-serif;color:#202124;line-height:1.6">
<main style="max-width:600px;margin:auto;padding:24px">
<h1>DollhouseMCP private beta</h1>
<p>${escapeHtml(greeting)}</p>
<p>You are invited to join the DollhouseMCP private beta.</p>
<p><a href="${escapeHtml(link)}" style="display:inline-block;background:#5b35b1;color:#ffffff;padding:12px 20px;text-decoration:none;border-radius:6px">Accept invitation</a></p>
<p>If the button does not work, copy and paste this link into your browser:<br>${escapeHtml(link)}</p>
<p>${escapeHtml(github)}</p>
<h2>Intended access</h2>${accessHtml}
<p>${escapeHtml(expiration)}</p>
<p>${escapeHtml(singleUse)}</p>
<p>${escapeHtml(unexpected)}</p>
<p>Questions or need a new invitation? Contact <a href="${escapeHtml(supportHref)}">${escapeHtml(support)}</a>.</p>
</main></body></html>`;
  return { subject: INVITATION_EMAIL_SUBJECT, text, html };
}

function safeText(value: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum || /\p{Cc}/u.test(value)) invalidTemplate();
  return value.trim().normalize('NFC');
}

function lifetimeHours(issuedAt: Date, expiresAt: Date): number {
  if (!(issuedAt instanceof Date) || !(expiresAt instanceof Date) ||
    !Number.isFinite(issuedAt.getTime()) || !Number.isFinite(expiresAt.getTime())) invalidTemplate();
  const hours = (expiresAt.getTime() - issuedAt.getTime()) / 3_600_000;
  if (!Number.isInteger(hours) || hours < MIN_INVITATION_TTL_HOURS || hours > MAX_INVITATION_TTL_HOURS) invalidTemplate();
  return hours;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function invalidTemplate(): never {
  throw new Error('Invalid invitation email template input');
}
