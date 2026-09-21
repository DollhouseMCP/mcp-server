export const DURABLE_INVITATION_ROUTE = '/admin/accounts/invitations';
export const INVITATION_TTL_HOURS = Object.freeze({ minimum: 1, default: 24, maximum: 168 });

export function invitationTtlHours(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Invitation lifetime must be a whole number of hours.');
  }
  const hours = Number(value);
  if (!Number.isSafeInteger(hours) ||
      hours < INVITATION_TTL_HOURS.minimum ||
      hours > INVITATION_TTL_HOURS.maximum) {
    throw new Error(
      `Invitation lifetime must be between ${INVITATION_TTL_HOURS.minimum} and ${INVITATION_TTL_HOURS.maximum} hours.`,
    );
  }
  return hours;
}

export function invitationExpiryPresentation(value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 64 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error('Invitation expiry is unavailable.');
  const expiresAt = Date.parse(value);
  if (!Number.isFinite(expiresAt) || new Date(expiresAt).toISOString() !== value) throw new Error('Invitation expiry is unavailable.');
  if (expiresAt <= now) return { exact: value, remaining: 'Expiration time reached according to this device clock' };
  const minutes = Math.max(1, Math.ceil((expiresAt - now) / 60_000));
  let amount = minutes;
  let unit = 'minute';
  if (minutes >= 2_880) { amount = Math.ceil(minutes / 1_440); unit = 'day'; }
  else if (minutes >= 120) { amount = Math.ceil(minutes / 60); unit = 'hour'; }
  return {
    exact: value,
    remaining: `About ${amount} ${unit}${amount === 1 ? '' : 's'} remaining`,
  };
}

/** Fixed presentation only. Provider details and errors are never rendered. */
export function invitationDeliveryPresentation(delivery) {
  if (delivery?.status === 'manual_fallback' && delivery.reason === 'not_configured') {
    return {
      label: 'Manual copy required',
      message: 'Email delivery is not configured. Copy and send the claim link manually.',
    };
  }
  if ((delivery?.status === 'recorded' || delivery?.status === 'existing_attempt') &&
      delivery.state === 'submitted') {
    return {
      label: 'Submitted',
      message: 'The email provider accepted this invitation for delivery. Keep the claim link until enrollment completes.',
    };
  }
  if ((delivery?.status === 'recorded' || delivery?.status === 'existing_attempt') &&
      delivery.state === 'failed') {
    return {
      label: 'Failed',
      message: 'Email delivery failed. Copy and send the claim link manually.',
    };
  }
  return {
    label: 'Unknown',
    message: 'Delivery status is unknown. Do not retry automatically; copy the claim link if needed.',
  };
}
