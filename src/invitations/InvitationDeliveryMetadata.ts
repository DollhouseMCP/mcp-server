import { InvitationError, type InvitationDeliveryResultUpdate } from './InvitationTypes.js';

const FAILED_CLASSES = ['configuration', 'authentication', 'recipient_rejected', 'rate_limited', 'not_sent'];
const UNKNOWN_CLASSES = ['timeout', 'connection_lost', 'unknown'];

/** Fixed metadata fields only; never accept provider error text or nested payloads. */
export function sanitizeDeliveryDetail(raw: InvitationDeliveryResultUpdate['sanitizedDetail']): Record<string, number | boolean> | null {
  if (raw == null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) invalid();
  const detail: Record<string, number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'durationMs' && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000) {
      detail.durationMs = value;
    } else if (key === 'smtpStatus' && typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) {
      detail.smtpStatus = value;
    } else if (key === 'providerAccepted' && typeof value === 'boolean') {
      detail.providerAccepted = value;
    } else invalid();
  }
  return Object.keys(detail).length ? detail : null;
}

export function validateDeliveryProvider(provider: string | null): void {
  if (provider !== null && (typeof provider !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(provider))) invalid();
}

export function sanitizeDeliveryResult(update: InvitationDeliveryResultUpdate): Required<InvitationDeliveryResultUpdate> {
  const state = update.state;
  const failureClass = update.failureClass ?? null;
  const providerMessageId = update.providerMessageId ?? null;
  if (!['submitted', 'failed', 'unknown'].includes(state)) invalid();
  // Nodemailer RFC Message-ID is not a provider ID; adapters must leave this null
  // unless an actual provider ID is available. Preserve opaque IDs, never URLs,
  // multiline provider responses, or arbitrary unbounded diagnostics.
  if (providerMessageId !== null && (typeof providerMessageId !== 'string' ||
    !/^[A-Za-z0-9<][A-Za-z0-9_.:@<>-]{0,254}$/.test(providerMessageId))) invalid();
  if (state === 'submitted' ? failureClass !== null :
    !(state === 'failed' ? FAILED_CLASSES : UNKNOWN_CLASSES).includes(failureClass ?? '')) invalid();
  if (state !== 'submitted' && providerMessageId !== null) invalid();
  const sanitizedDetail = sanitizeDeliveryDetail(update.sanitizedDetail);
  if (sanitizedDetail?.providerAccepted !== undefined &&
    (state === 'unknown' || (state === 'submitted' ? sanitizedDetail.providerAccepted !== true : sanitizedDetail.providerAccepted !== false))) invalid();
  // smtpStatus describes the final submission outcome, never an earlier SMTP command.
  const smtpStatus = sanitizedDetail?.smtpStatus;
  if (typeof smtpStatus === 'number' && (state === 'unknown' ||
    (state === 'submitted' ? smtpStatus < 200 || smtpStatus >= 300 : smtpStatus < 400 || smtpStatus >= 600))) invalid();
  return { state, failureClass, providerMessageId, sanitizedDetail };
}

function invalid(): never {
  throw new InvitationError('invitation_invalid', 'Invalid invitation delivery metadata');
}
