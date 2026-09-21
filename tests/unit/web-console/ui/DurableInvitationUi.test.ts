import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_INVITATION_TTL_HOURS,
  MAX_INVITATION_TTL_HOURS,
  MIN_INVITATION_TTL_HOURS,
} from '../../../../src/invitations/InvitationConfig';
import {
  INVITATION_TTL_HOURS,
  invitationDeliveryPresentation,
  invitationExpiryPresentation,
  invitationTtlHours,
} from '../../../../src/web-console/ui/durable-invitation-ui';

describe('durable invitation browser contract', () => {
  it('pins the browser TTL bounds and default to the server contract', () => {
    expect(INVITATION_TTL_HOURS).toEqual({
      minimum: MIN_INVITATION_TTL_HOURS,
      default: DEFAULT_INVITATION_TTL_HOURS,
      maximum: MAX_INVITATION_TTL_HOURS,
    });
    expect([1, 24, 168].map(value => invitationTtlHours(String(value)))).toEqual([1, 24, 168]);
  });

  it.each(['', '0', '169', '1.5', ' 24', '24 ', '-1', 'unknown'])(
    'rejects invalid invitation lifetime %p',
    value => expect(() => invitationTtlHours(value)).toThrow(),
  );

  it('validates and presents the exact invitation expiry with remaining time', () => {
    expect(invitationExpiryPresentation('2026-09-21T17:00:00.000Z', Date.parse('2026-09-21T16:00:00.000Z')))
      .toEqual({ exact: '2026-09-21T17:00:00.000Z', remaining: 'About 60 minutes remaining' });
    expect(() => invitationExpiryPresentation('tomorrow', 0)).toThrow('Invitation expiry is unavailable.');
    expect(() => invitationExpiryPresentation('2026-02-31T17:00:00.000Z', 0)).toThrow('Invitation expiry is unavailable.');
    expect(invitationExpiryPresentation('2026-09-21T15:59:59.000Z', Date.parse('2026-09-21T16:00:00.000Z')))
      .toEqual({
        exact: '2026-09-21T15:59:59.000Z',
        remaining: 'Expiration time reached according to this device clock',
      });
  });

  it.each([
    [
      { status: 'manual_fallback', state: 'not_attempted', reason: 'not_configured' },
      'Manual copy required',
    ],
    [{ status: 'recorded', state: 'submitted' }, 'Submitted'],
    [{ status: 'existing_attempt', state: 'failed' }, 'Failed'],
    [{ status: 'uncertain', state: 'unknown', last_known_state: 'submitting' }, 'Unknown'],
    [{ status: 'unavailable', state: 'unknown' }, 'Unknown'],
    [{ status: 'recorded', state: 'submitting' }, 'Unknown'],
    [undefined, 'Unknown'],
  ])('maps only fixed delivery enums for %#', (delivery, label) => {
    const result = invitationDeliveryPresentation(delivery);
    expect(result.label).toBe(label);
    expect(Object.keys(result).sort()).toEqual(['label', 'message']);
    expect(result.message).not.toContain('undefined');
  });
});
