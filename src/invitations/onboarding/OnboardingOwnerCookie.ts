import {
  ONBOARDING_OWNER_MAX_AGE_SECONDS, validateOnboardingOwnerRecord, type OnboardingOwnerRecord,
} from './OnboardingRecords.js';

/**
 * Set during bootstrap BEFORE claim exchange. The cookie survives the short
 * unclaimed server record so a committed atomic exchange remains recoverable if
 * its response is lost. Possession alone never authorizes: resolve the live owner.
 * Later calls cannot slide the horizon beyond original creation +168 hours.
 */
export function onboardingOwnerCookieMaxAgeSeconds(owner: OnboardingOwnerRecord, now: Date): number {
  validateOnboardingOwnerRecord(owner);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()) || owner.createdAt > now ||
      owner.expiresAt <= now || owner.revokedAt !== null) throw new Error('Onboarding owner is unavailable');
  const remaining = Math.floor((owner.createdAt.getTime() + ONBOARDING_OWNER_MAX_AGE_SECONDS * 1000 - now.getTime()) / 1000);
  if (remaining <= 0) throw new Error('Onboarding owner is unavailable');
  return remaining;
}
