import { normalizeAuthAllowlistValue } from '../auth/embedded-as/allowlistIdentity.js';

export const MAX_INVITATION_EMAIL_OCTETS = 254;
export const MAX_INVITATION_EMAIL_LOCAL_PART_OCTETS = 64;
export const MAX_INVITATION_EMAIL_DOMAIN_LABEL_OCTETS = 63;

const LOCAL_PART_PATTERN = /^[\p{L}\p{M}\p{N}!#$%&'*+\/=\?^_`{|}~.-]+$/u;
const DOMAIN_LABEL_PATTERN = /^[\p{L}\p{N}](?:[\p{L}\p{M}\p{N}-]*[\p{L}\p{M}\p{N}])?$/u;

export function normalizeInvitationEmail(email: unknown): string {
  if (typeof email !== 'string') {
    throw new Error('invitation email must be a valid email address');
  }
  const normalized = normalizeAuthAllowlistValue('email', email);
  if (!isSupportedInvitationEmail(normalized)) {
    throw new Error('invitation email must be a valid email address');
  }
  return normalized;
}

/** Validate the supplied spelling; identity normalization is a separate step. */
export function isSupportedInvitationEmail(value: string): boolean {
  if (Buffer.byteLength(value, 'utf8') > MAX_INVITATION_EMAIL_OCTETS ||
      /\s/u.test(value) || containsAsciiControl(value)) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return false;
  const localPart = value.slice(0, at);
  const domain = value.slice(at + 1);
  const labels = domain.split('.');
  return Buffer.byteLength(localPart, 'utf8') <= MAX_INVITATION_EMAIL_LOCAL_PART_OCTETS &&
    LOCAL_PART_PATTERN.test(localPart) && !localPart.startsWith('.') &&
    !localPart.endsWith('.') && !localPart.includes('..') && labels.length > 1 &&
    labels.every(label => Buffer.byteLength(label, 'utf8') <= MAX_INVITATION_EMAIL_DOMAIN_LABEL_OCTETS &&
      DOMAIN_LABEL_PATTERN.test(label));
}

function containsAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
