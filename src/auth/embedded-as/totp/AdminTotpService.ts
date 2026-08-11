import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';

import type { IAuthStorageLayer } from '../storage/IAuthStorageLayer.js';
import type { ISecretEncryptionService } from '../../../web-console/security/SecretEncryption.js';
import type { IConsoleFactorStore } from '../../../web-console/stores/IConsoleFactorStore.js';
import { SecurityMonitor } from '../../../security/securityMonitor.js';

const ENROLLMENT_MODEL = 'ConsoleTotpEnrollment';
const ENROLLMENT_TTL_SECONDS = 10 * 60;
const TOTP_ISSUER = 'DollhouseMCP';
const TOTP_ALGORITHM = 'SHA1';
const TOTP_DIGITS = 6;
const TOTP_PERIOD_SECONDS = 30;
const TOTP_VALIDATE_WINDOW = 1;
const TOTP_SECRET_SIZE_BYTES = 20;
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 12;
const BACKUP_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const LABEL_PATTERN = /^[A-Za-z0-9 ._@-]{1,64}$/;

export const ADMIN_TOTP_PARAMETERS = {
  issuer: TOTP_ISSUER,
  algorithm: TOTP_ALGORITHM,
  digits: TOTP_DIGITS,
  periodSeconds: TOTP_PERIOD_SECONDS,
  validationWindow: TOTP_VALIDATE_WINDOW,
} as const;

export type AdminTotpErrorCode =
  | 'already_enrolled'
  | 'invalid_label'
  | 'pending_not_found'
  | 'invalid_totp_code'
  | 'not_enrolled';

export class AdminTotpError extends Error {
  constructor(
    message: string,
    readonly code: AdminTotpErrorCode,
  ) {
    super(message);
    this.name = 'AdminTotpError';
  }
}

export interface AdminTotpServiceOptions {
  readonly authStorage: IAuthStorageLayer;
  readonly factorStore: IConsoleFactorStore;
  readonly secretEncryption: ISecretEncryptionService;
  readonly now?: () => Date;
  readonly randomUuid?: () => string;
}

export interface BeginTotpEnrollmentResult {
  readonly pendingId: string;
  readonly secretBase32: string;
  readonly otpauthUri: string;
  readonly expiresAt: Date;
}

export interface ConfirmTotpEnrollmentResult {
  readonly factorId: string;
  readonly enrolledAt: Date;
  readonly backupCodes: readonly string[];
}

export type AdminTotpProofResult =
  | { readonly ok: true; readonly method: 'totp' | 'backup'; readonly authTime: Date }
  | { readonly ok: false };

export type AdminTotpDisableResult =
  | { readonly ok: true; readonly method: 'totp' | 'backup'; readonly authTime: Date }
  | { readonly ok: false };

interface PendingEnrollment {
  readonly userId: string;
  readonly label: string;
  readonly secretCiphertextBase64: string;
  readonly expiresAt: string;
}

export class AdminTotpService {
  private readonly authStorage: IAuthStorageLayer;
  private readonly factorStore: IConsoleFactorStore;
  private readonly secretEncryption: ISecretEncryptionService;
  private readonly now: () => Date;
  private readonly randomUuid: () => string;

  constructor(options: AdminTotpServiceOptions) {
    this.authStorage = options.authStorage;
    this.factorStore = options.factorStore;
    this.secretEncryption = options.secretEncryption;
    this.now = options.now ?? (() => new Date());
    this.randomUuid = options.randomUuid ?? randomUUID;
  }

  async beginEnrollment(userId: string, label: string): Promise<BeginTotpEnrollmentResult> {
    const safeLabel = validateLabel(label);
    const status = await this.factorStore.getTotpStatus(userId);
    if (status.enrolled) {
      throw new AdminTotpError('TOTP is already enrolled for this principal', 'already_enrolled');
    }
    const secret = new Secret({ size: TOTP_SECRET_SIZE_BYTES });
    const pendingId = this.randomUuid();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + ENROLLMENT_TTL_SECONDS * 1000);
    const secretCiphertext = this.secretEncryption.encrypt(
      Buffer.from(secret.base32, 'utf8'),
      { secretClass: 'console_totp_enrollment_seed', ownerId: userId },
    );
    const pending: PendingEnrollment = {
      userId,
      label: safeLabel,
      secretCiphertextBase64: secretCiphertext.toString('base64'),
      expiresAt: expiresAt.toISOString(),
    };
    await this.authStorage.genericSet(ENROLLMENT_MODEL, pendingId, pending, ENROLLMENT_TTL_SECONDS);
    return {
      pendingId,
      secretBase32: secret.base32,
      otpauthUri: buildTotpUri(secret, safeLabel),
      expiresAt,
    };
  }

  async confirmEnrollment(
    userId: string,
    pendingId: string,
    code: string,
  ): Promise<ConfirmTotpEnrollmentResult> {
    const pending = await this.readPendingEnrollment(userId, pendingId);
    const secretBase32 = this.decryptPendingSecret(pending);
    if (!verifyTotpCode(secretBase32, pending.label, code, this.now())) {
      logTotpEvent('TOTP_VERIFICATION_FAILED', 'MEDIUM', 'Admin TOTP enrollment confirmation failed', userId);
      throw new AdminTotpError('Invalid TOTP code', 'invalid_totp_code');
    }

    const factorId = this.randomUuid();
    const enrolledAt = this.now();
    const backupCodes = generateBackupCodes();
    const backupCodeHashes = backupCodes.map(hashBackupCode);
    const secretCiphertext = this.secretEncryption.encrypt(
      Buffer.from(secretBase32, 'utf8'),
      { secretClass: 'console_totp_seed', ownerId: secretOwnerId(userId, factorId) },
    );

    await this.factorStore.createTotpFactor({
      userId,
      factorId,
      factorType: 'totp',
      secretCiphertext,
      enrolledAt,
      disabledAt: null,
      lastUsedAt: null,
    }, backupCodeHashes);
    await this.authStorage.genericDestroy(ENROLLMENT_MODEL, pendingId);
    logTotpEvent('TOTP_ENROLLED', 'LOW', 'Admin TOTP factor enrolled', userId);

    return { factorId, enrolledAt, backupCodes };
  }

  async hasActiveFactor(userId: string): Promise<boolean> {
    return (await this.factorStore.getTotpStatus(userId)).enrolled;
  }

  async prove(userId: string, code: string): Promise<AdminTotpProofResult> {
    const factor = await this.factorStore.getActiveTotpFactorForAs(userId);
    if (!factor) return { ok: false };
    const authTime = this.now();
    const secretBase32 = this.secretEncryption.decrypt(
      factor.secretCiphertext,
      { secretClass: 'console_totp_seed', ownerId: secretOwnerId(userId, factor.factorId) },
    ).toString('utf8');
    if (verifyTotpCode(secretBase32, userId, code, authTime)) {
      const marked = await this.factorStore.markTotpUsed(userId, factor.factorId, authTime);
      return marked ? { ok: true, method: 'totp', authTime } : { ok: false };
    }
    const consumed = await this.factorStore.consumeBackupCode(
      userId,
      factor.factorId,
      hashBackupCode(normalizeBackupCode(code)),
      authTime,
    );
    if (consumed) {
      logTotpEvent('TOTP_BACKUP_CODE_CONSUMED', 'LOW', 'Admin TOTP backup code consumed', userId);
    } else {
      logTotpEvent('TOTP_VERIFICATION_FAILED', 'MEDIUM', 'Admin TOTP proof failed', userId);
    }
    return consumed ? { ok: true, method: 'backup', authTime } : { ok: false };
  }

  async disable(userId: string, code: string): Promise<boolean> {
    return (await this.disableWithProof(userId, code)).ok;
  }

  async disableWithProof(userId: string, code: string): Promise<AdminTotpDisableResult> {
    const factor = await this.factorStore.getActiveTotpFactorForAs(userId);
    if (!factor) return { ok: false };
    const authTime = this.now();
    const secretBase32 = this.secretEncryption.decrypt(
      factor.secretCiphertext,
      { secretClass: 'console_totp_seed', ownerId: secretOwnerId(userId, factor.factorId) },
    ).toString('utf8');
    if (verifyTotpCode(secretBase32, userId, code, authTime)) {
      const disabled = await this.factorStore.disableActiveTotp(userId, authTime);
      if (disabled) {
        logTotpEvent('TOTP_DISABLED', 'LOW', 'Admin TOTP factor disabled', userId);
      }
      return disabled ? { ok: true, method: 'totp', authTime } : { ok: false };
    }
    const disabled = await this.factorStore.disableActiveTotpWithBackupCode(
      userId,
      factor.factorId,
      hashBackupCode(normalizeBackupCode(code)),
      authTime,
    );
    if (disabled) {
      logTotpEvent('TOTP_BACKUP_CODE_CONSUMED', 'LOW', 'Admin TOTP backup code consumed for disable', userId);
      logTotpEvent('TOTP_DISABLED', 'LOW', 'Admin TOTP factor disabled', userId);
    } else {
      logTotpEvent('TOTP_VERIFICATION_FAILED', 'MEDIUM', 'Admin TOTP disable proof failed', userId);
    }
    return disabled ? { ok: true, method: 'backup', authTime } : { ok: false };
  }

  private async readPendingEnrollment(userId: string, pendingId: string): Promise<PendingEnrollment> {
    const raw = await this.authStorage.genericGet(ENROLLMENT_MODEL, pendingId);
    if (!isPendingEnrollment(raw) || raw.userId !== userId || new Date(raw.expiresAt) <= this.now()) {
      throw new AdminTotpError('Pending TOTP enrollment not found or expired', 'pending_not_found');
    }
    return raw;
  }

  private decryptPendingSecret(pending: PendingEnrollment): string {
    return this.secretEncryption.decrypt(
      Buffer.from(pending.secretCiphertextBase64, 'base64'),
      { secretClass: 'console_totp_enrollment_seed', ownerId: pending.userId },
    ).toString('utf8');
  }
}

function validateLabel(label: string): string {
  const trimmed = label.trim();
  if (!LABEL_PATTERN.test(trimmed)) {
    throw new AdminTotpError('Invalid TOTP label', 'invalid_label');
  }
  return trimmed;
}

function logTotpEvent(
  type: 'TOTP_ENROLLED' | 'TOTP_DISABLED' | 'TOTP_BACKUP_CODE_CONSUMED' | 'TOTP_VERIFICATION_FAILED',
  severity: 'LOW' | 'MEDIUM',
  details: string,
  userId: string,
): void {
  SecurityMonitor.logSecurityEvent({
    type,
    severity,
    source: 'AdminTotpService',
    details: `${details} [principal:${auditPrincipalFingerprint(userId)}]`,
    additionalData: { userId },
  });
}

function auditPrincipalFingerprint(userId: string): string {
  return createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, 16);
}

function secretOwnerId(userId: string, factorId: string): string {
  return `${userId}:${factorId}`;
}

function isPendingEnrollment(raw: unknown): raw is PendingEnrollment {
  if (!raw || typeof raw !== 'object') return false;
  const value = raw as Record<string, unknown>;
  return typeof value.userId === 'string'
    && typeof value.label === 'string'
    && typeof value.secretCiphertextBase64 === 'string'
    && typeof value.expiresAt === 'string';
}

function buildTotpUri(secret: Secret, label: string): string {
  return new TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret,
  }).toString();
}

function verifyTotpCode(secretBase32: string, label: string, code: string, at: Date): boolean {
  const token = code.replaceAll(/\s/g, '');
  if (!token) return false;
  const totp = new TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: TOTP_ALGORITHM,
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: Secret.fromBase32(secretBase32),
  });
  return totp.validate({ token, window: TOTP_VALIDATE_WINDOW, timestamp: at.getTime() }) !== null;
}

function generateBackupCodes(): string[] {
  const codes: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i += 1) {
    const bytes = randomBytes(BACKUP_CODE_LENGTH);
    let code = '';
    for (const byte of bytes) {
      code += BACKUP_CODE_ALPHABET[byte & 0x1f];
    }
    codes.push(code);
  }
  return codes;
}

function normalizeBackupCode(raw: string): string {
  return raw.replaceAll(/[\s-]/g, '').toUpperCase();
}

function hashBackupCode(code: string): Buffer {
  return createHash('sha256').update(code, 'utf8').digest();
}
