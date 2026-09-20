import { normalizeAuthAllowlistValue } from '../auth/embedded-as/allowlistIdentity.js';

export function normalizeInvitationEmail(email: string): string {
  const normalized = normalizeAuthAllowlistValue('email', email);
  if (!isLiteEmailAddress(normalized)) {
    throw new Error('invitation email must be a valid email address');
  }
  return normalized;
}

function isLiteEmailAddress(value: string): boolean {
  if (value.length > 254 || /\s/.test(value) || containsAsciiControl(value)) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return false;
  const domain = value.slice(at + 1);
  const labels = domain.split('.');
  return labels.length > 1 && labels.every(label => label.length > 0);
}

function containsAsciiControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}
