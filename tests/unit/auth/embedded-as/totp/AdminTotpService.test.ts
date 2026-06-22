import { describe, expect, it } from '@jest/globals';
import { Secret, TOTP } from 'otpauth';

import {
  ADMIN_TOTP_PARAMETERS,
  AdminTotpError,
  AdminTotpService,
} from '../../../../../src/auth/embedded-as/totp/AdminTotpService.js';
import { InMemoryAuthStorageLayer } from '../../../../../src/auth/embedded-as/storage/InMemoryAuthStorageLayer.js';
import { AeadSecretEncryptionService } from '../../../../../src/web-console/security/SecretEncryption.js';
import { InMemoryConsoleFactorStore } from '../../../../../src/web-console/stores/InMemoryConsoleFactorStore.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const OTHER_USER_ID = '718c692b-d62b-418b-a495-8255e125ff51';
const TOTP_LABEL = 'Admin Console';
const NOW = new Date('2026-05-27T12:00:00.000Z');
const FIVE_MINUTES = new Date('2026-05-27T12:05:00.000Z');
const ELEVEN_MINUTES = new Date('2026-05-27T12:11:00.000Z');

function createService(now: () => Date = () => NOW): {
  service: AdminTotpService;
  factors: InMemoryConsoleFactorStore;
} {
  const factors = new InMemoryConsoleFactorStore();
  const uuids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
  ];
  const service = new AdminTotpService({
    authStorage: new InMemoryAuthStorageLayer(),
    factorStore: factors,
    secretEncryption: new AeadSecretEncryptionService({
      keyId: 'test-key',
      key: Buffer.alloc(32, 7),
    }),
    now,
    randomUuid: () => uuids.shift() ?? '99999999-9999-4999-8999-999999999999',
  });
  return { service, factors };
}

function totpCodeAt(base32Secret: string, timestampMs: number = NOW.getTime()): string {
  const totp = new TOTP({
    issuer: ADMIN_TOTP_PARAMETERS.issuer,
    label: TOTP_LABEL,
    algorithm: ADMIN_TOTP_PARAMETERS.algorithm,
    digits: ADMIN_TOTP_PARAMETERS.digits,
    period: ADMIN_TOTP_PARAMETERS.periodSeconds,
    secret: Secret.fromBase32(base32Secret),
  });
  return totp.generate({ timestamp: timestampMs });
}

describe('AdminTotpService', () => {
  it('enrolls a principal-owned TOTP factor and shows backup codes once', async () => {
    const { service, factors } = createService();
    const begin = await service.beginEnrollment(USER_ID, TOTP_LABEL);

    expect(begin.pendingId).toBe('11111111-1111-4111-8111-111111111111');
    expect(begin.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(begin.otpauthUri).toContain('issuer=DollhouseMCP');

    const result = await service.confirmEnrollment(
      USER_ID,
      begin.pendingId,
      totpCodeAt(begin.secretBase32),
    );

    expect(result.factorId).toBe('22222222-2222-4222-8222-222222222222');
    expect(result.enrolledAt).toEqual(NOW);
    expect(result.backupCodes).toHaveLength(10);
    expect(await factors.getTotpStatus(USER_ID)).toMatchObject({
      enrolled: true,
      factorType: 'totp',
      enrolledAt: NOW,
    });
    await expect(service.confirmEnrollment(USER_ID, begin.pendingId, totpCodeAt(begin.secretBase32)))
      .rejects.toMatchObject({ code: 'pending_not_found' });
  });

  it('rejects bad or expired enrollment confirmations without creating a factor', async () => {
    let current = NOW;
    const { service, factors } = createService(() => current);
    const begin = await service.beginEnrollment(USER_ID, TOTP_LABEL);

    await expect(service.confirmEnrollment(USER_ID, begin.pendingId, '000000'))
      .rejects.toBeInstanceOf(AdminTotpError);
    expect((await factors.getTotpStatus(USER_ID)).enrolled).toBe(false);

    current = ELEVEN_MINUTES;
    await expect(service.confirmEnrollment(USER_ID, begin.pendingId, totpCodeAt(begin.secretBase32, ELEVEN_MINUTES.getTime())))
      .rejects.toMatchObject({ code: 'pending_not_found' });
  });

  it('rejects cross-user pending confirmation and duplicate enrollment', async () => {
    const { service } = createService();
    const begin = await service.beginEnrollment(USER_ID, TOTP_LABEL);

    await expect(service.confirmEnrollment(OTHER_USER_ID, begin.pendingId, totpCodeAt(begin.secretBase32)))
      .rejects.toMatchObject({ code: 'pending_not_found' });

    await service.confirmEnrollment(USER_ID, begin.pendingId, totpCodeAt(begin.secretBase32));
    await expect(service.beginEnrollment(USER_ID, TOTP_LABEL))
      .rejects.toMatchObject({ code: 'already_enrolled' });
  });

  it('validates enrollment labels before creating pending state', async () => {
    const { service } = createService();

    await expect(service.beginEnrollment(USER_ID, '<script>alert(1)</script>'))
      .rejects.toMatchObject({ code: 'invalid_label' });
  });

  it('proves administrative TOTP with live code and updates last-used time', async () => {
    let current = NOW;
    const { service, factors } = createService(() => current);
    const begin = await service.beginEnrollment(USER_ID, TOTP_LABEL);
    await service.confirmEnrollment(USER_ID, begin.pendingId, totpCodeAt(begin.secretBase32));

    current = FIVE_MINUTES;
    await expect(service.prove(USER_ID, totpCodeAt(begin.secretBase32, FIVE_MINUTES.getTime())))
      .resolves.toEqual({ ok: true, method: 'totp', authTime: FIVE_MINUTES });
    expect((await factors.getTotpStatus(USER_ID)).lastUsedAt).toEqual(FIVE_MINUTES);
  });

  it('consumes backup codes once and rejects replay', async () => {
    const { service } = createService();
    const begin = await service.beginEnrollment(USER_ID, TOTP_LABEL);
    const enrolled = await service.confirmEnrollment(USER_ID, begin.pendingId, totpCodeAt(begin.secretBase32));
    const formatted = `${enrolled.backupCodes[0].slice(0, 4)}-${enrolled.backupCodes[0].slice(4).toLowerCase()}`;

    await expect(service.prove(USER_ID, formatted))
      .resolves.toEqual({ ok: true, method: 'backup', authTime: NOW });
    await expect(service.prove(USER_ID, formatted)).resolves.toEqual({ ok: false });
  });

  it('disables an active factor only after a valid proof', async () => {
    const { service, factors } = createService();
    const begin = await service.beginEnrollment(USER_ID, TOTP_LABEL);
    await service.confirmEnrollment(USER_ID, begin.pendingId, totpCodeAt(begin.secretBase32));

    await expect(service.disable(USER_ID, '000000')).resolves.toBe(false);
    expect((await factors.getTotpStatus(USER_ID)).enrolled).toBe(true);

    await expect(service.disable(USER_ID, totpCodeAt(begin.secretBase32))).resolves.toBe(true);
    expect((await factors.getTotpStatus(USER_ID)).enrolled).toBe(false);
  });

  it('disables with a backup code through the store-level atomic disable path', async () => {
    const { service, factors } = createService();
    const begin = await service.beginEnrollment(USER_ID, TOTP_LABEL);
    const enrolled = await service.confirmEnrollment(USER_ID, begin.pendingId, totpCodeAt(begin.secretBase32));
    const code = enrolled.backupCodes[0];

    await expect(service.disable(USER_ID, code)).resolves.toBe(true);
    expect((await factors.getTotpStatus(USER_ID)).enrolled).toBe(false);
  });

  it('returns false for proof or disable when no factor exists', async () => {
    const { service } = createService();

    await expect(service.prove(USER_ID, '000000')).resolves.toEqual({ ok: false });
    await expect(service.disable(USER_ID, '000000')).resolves.toBe(false);
  });
});
