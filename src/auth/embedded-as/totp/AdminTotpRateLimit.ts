import type { IRateLimitStore } from '../storage/IRateLimitStore.js';
import { normalizeIp } from '../rateLimit.js';

const IP_THRESHOLD = 5;
const IP_WINDOW_MS = 5 * 60 * 1000;
const IP_LOCK_MS = 15 * 60 * 1000;
const USER_THRESHOLD = 20;
const USER_WINDOW_MS = 60 * 60 * 1000;
const USER_LOCK_MS = 60 * 60 * 1000;

interface TotpProofState {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

export interface AdminTotpRateLimitSubject {
  userId: string;
  ip: string;
}

export interface AdminTotpRateLimitResult {
  allowed: boolean;
}

export async function checkAdminTotpRateLimit(
  store: IRateLimitStore | undefined,
  scope: string,
  subject: AdminTotpRateLimitSubject,
): Promise<AdminTotpRateLimitResult> {
  if (!store) return { allowed: true };
  const now = Date.now();
  const [ipRecord, userRecord] = await Promise.all([
    store.get<TotpProofState>(`${scope}:ip`, ipKey(subject)),
    store.get<TotpProofState>(`${scope}:user`, subject.userId),
  ]);
  return {
    allowed: !isLocked(ipRecord?.state, now) && !isLocked(userRecord?.state, now),
  };
}

export async function noteAdminTotpFailure(
  store: IRateLimitStore | undefined,
  scope: string,
  subject: AdminTotpRateLimitSubject,
): Promise<void> {
  if (!store) return;
  const now = Date.now();
  await Promise.all([
    store.update<TotpProofState>(
      `${scope}:ip`,
      ipKey(subject),
      prev => stepFailure(prev, now, IP_WINDOW_MS, IP_THRESHOLD, IP_LOCK_MS),
      { expiresAt: now + IP_LOCK_MS * 2 },
    ),
    store.update<TotpProofState>(
      `${scope}:user`,
      subject.userId,
      prev => stepFailure(prev, now, USER_WINDOW_MS, USER_THRESHOLD, USER_LOCK_MS),
      { expiresAt: now + USER_LOCK_MS * 2 },
    ),
  ]);
}

export async function resetAdminTotpRateLimit(
  store: IRateLimitStore | undefined,
  scope: string,
  subject: AdminTotpRateLimitSubject,
): Promise<void> {
  if (!store) return;
  await Promise.all([
    store.reset(`${scope}:ip`, ipKey(subject)),
    store.reset(`${scope}:user`, subject.userId),
  ]);
}

export function adminTotpRateLimitSubject(userId: string, ip: string | undefined): AdminTotpRateLimitSubject {
  return { userId, ip: normalizeIp(ip ?? 'unknown') };
}

function stepFailure(
  prev: TotpProofState | null,
  now: number,
  windowMs: number,
  threshold: number,
  lockMs: number,
): { state: TotpProofState } {
  const state = prev && now - prev.firstFailureAt <= windowMs
    ? { ...prev }
    : { failures: 0, firstFailureAt: now, lockedUntil: 0 };
  state.failures += 1;
  if (state.failures >= threshold) state.lockedUntil = now + lockMs;
  return { state };
}

function ipKey(subject: AdminTotpRateLimitSubject): string {
  return `${subject.userId}|${subject.ip}`;
}

function isLocked(state: TotpProofState | undefined, now: number): boolean {
  return !!state?.lockedUntil && state.lockedUntil > now;
}
