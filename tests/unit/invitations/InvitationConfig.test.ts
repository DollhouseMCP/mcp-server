import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_INVITATION_TTL_HOURS,
  InvitationConfigError,
  readInvitationConfig,
} from '../../../src/invitations/InvitationConfig.js';

describe('InvitationConfig', () => {
  it('uses a 24-hour TTL and disables cleanup by default', () => {
    expect(readInvitationConfig({})).toEqual({
      ttlHours: DEFAULT_INVITATION_TTL_HOURS,
      terminalRetentionDays: null,
    });
  });

  it.each(['1', '24', '168'])('accepts bounded integer TTL %s', ttl => {
    expect(readInvitationConfig({ DOLLHOUSE_INVITE_TTL_HOURS: ttl }).ttlHours).toBe(Number(ttl));
  });

  it.each(['', '0', '169', '-1', '1.5', ' 24 ', '1e2'])('rejects malformed or out-of-range TTL %s', ttl => {
    expect(() => readInvitationConfig({ DOLLHOUSE_INVITE_TTL_HOURS: ttl }))
      .toThrow(InvitationConfigError);
  });

  it('enables terminal cleanup only when retention is explicitly valid', () => {
    expect(readInvitationConfig({ DOLLHOUSE_INVITE_RETENTION_DAYS: '90' }).terminalRetentionDays).toBe(90);
    expect(() => readInvitationConfig({ DOLLHOUSE_INVITE_RETENTION_DAYS: '' }))
      .toThrow(InvitationConfigError);
    expect(() => readInvitationConfig({ DOLLHOUSE_INVITE_RETENTION_DAYS: '0' }))
      .toThrow(InvitationConfigError);
    expect(() => readInvitationConfig({ DOLLHOUSE_INVITE_RETENTION_DAYS: '3651' }))
      .toThrow(InvitationConfigError);
  });
});
