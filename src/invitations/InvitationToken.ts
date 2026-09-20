import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const INVITATION_TOKEN_VERSION = 'dhi1';
export const INVITATION_SECRET_BYTES = 32;
export const INVITATION_DIGEST_BYTES = 32;
export const MAX_INVITATION_TOKEN_LENGTH = 160;
export const MAX_INVITATION_GENERATION = 2_147_483_647;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ParsedInvitationToken {
  readonly invitationId: string;
  readonly generation: number;
  readonly secret: Buffer;
}

export interface GeneratedInvitationToken extends ParsedInvitationToken {
  readonly token: string;
}

export class InvitationTokenError extends Error {
  constructor(message = 'invalid invitation credential') {
    super(message);
    this.name = 'InvitationTokenError';
  }
}

export function generateInvitationToken(
  invitationId: string,
  generation: number,
  random: (size: number) => Buffer = randomBytes,
): GeneratedInvitationToken {
  assertUuid(invitationId);
  assertGeneration(generation);
  const secret = random(INVITATION_SECRET_BYTES);
  if (!Buffer.isBuffer(secret) || secret.length !== INVITATION_SECRET_BYTES) {
    throw new InvitationTokenError('invitation random source returned an invalid secret');
  }
  const token = [
    INVITATION_TOKEN_VERSION,
    uuidToBytes(invitationId).toString('base64url'),
    String(generation),
    secret.toString('base64url'),
  ].join('.');
  return { invitationId: invitationId.toLowerCase(), generation, secret: Buffer.from(secret), token };
}

export function parseInvitationToken(token: string): ParsedInvitationToken {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_INVITATION_TOKEN_LENGTH) {
    throw new InvitationTokenError();
  }
  const [version, encodedId, rawGeneration, encodedSecret, extra] = token.split('.');
  if (extra !== undefined || version !== INVITATION_TOKEN_VERSION ||
      !encodedId || !encodedSecret || !BASE64URL_PATTERN.test(encodedId) ||
      !BASE64URL_PATTERN.test(encodedSecret) || !/^[1-9][0-9]*$/.test(rawGeneration ?? '')) {
    throw new InvitationTokenError();
  }
  const idBytes = decodeBase64Url(encodedId);
  const secret = decodeBase64Url(encodedSecret);
  const generation = Number(rawGeneration);
  if (idBytes.length !== 16 || secret.length !== INVITATION_SECRET_BYTES) {
    throw new InvitationTokenError();
  }
  assertGeneration(generation);
  return { invitationId: bytesToUuid(idBytes), generation, secret };
}

/**
 * Hash a high-entropy invitation secret with all persisted security context.
 * Length prefixes make field boundaries unambiguous.
 */
export function hashInvitationCredential(
  token: ParsedInvitationToken,
  normalizedEmail: string,
  expiresAt: Date,
): Buffer {
  assertUuid(token.invitationId);
  assertGeneration(token.generation);
  if (token.secret.length !== INVITATION_SECRET_BYTES || normalizedEmail.length === 0 ||
      Number.isNaN(expiresAt.getTime())) {
    throw new InvitationTokenError('invalid invitation hash context');
  }
  const hash = createHash('sha256');
  for (const part of [
    Buffer.from('dollhouse/invitation-credential/v1', 'utf8'),
    uuidToBytes(token.invitationId),
    Buffer.from(String(token.generation), 'ascii'),
    Buffer.from(normalizedEmail, 'utf8'),
    Buffer.from(expiresAt.toISOString(), 'ascii'),
    token.secret,
  ]) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(part.length);
    hash.update(length);
    hash.update(part);
  }
  return hash.digest();
}

export function invitationCredentialMatches(expected: Buffer, actual: Buffer): boolean {
  return expected.length === INVITATION_DIGEST_BYTES &&
    actual.length === INVITATION_DIGEST_BYTES && timingSafeEqual(expected, actual);
}

function decodeBase64Url(value: string): Buffer {
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new InvitationTokenError();
    return decoded;
  } catch {
    throw new InvitationTokenError();
  }
}

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function assertUuid(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new InvitationTokenError('invitation id must be a UUID');
}

function assertGeneration(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_INVITATION_GENERATION) {
    throw new InvitationTokenError(
      `invitation generation must be between 1 and ${MAX_INVITATION_GENERATION}`,
    );
  }
}
