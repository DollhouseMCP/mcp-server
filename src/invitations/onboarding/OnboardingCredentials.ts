import type { IConsoleOpaqueValueService } from '../../web-console/security/ConsoleOpaqueValues.js';

export type OnboardingCredentialPurpose = 'owner' | 'session' | 'csrf';
const PURPOSES: readonly OnboardingCredentialPurpose[] = ['owner', 'session', 'csrf'];

/** Reuses the server opaque-value primitive, with distinct keyed hash domains. */
export class OnboardingCredentials {
  constructor(private readonly opaqueValues: IConsoleOpaqueValueService) {}

  issue(purpose: OnboardingCredentialPurpose): { readonly value: string; readonly hash: Buffer } {
    const value = this.opaqueValues.createOpaqueValue();
    return { value, hash: this.hash(purpose, value) };
  }

  hash(purpose: OnboardingCredentialPurpose, value: string): Buffer {
    if (!PURPOSES.includes(purpose) || !isOnboardingCredential(value)) throw new Error('Invalid onboarding credential');
    return this.opaqueValues.hashOpaqueValue(domainValue(purpose, value));
  }

  matches(purpose: OnboardingCredentialPurpose, value: string, expectedHash: Buffer): boolean {
    return PURPOSES.includes(purpose) && isOnboardingCredential(value)
      && Buffer.isBuffer(expectedHash) && expectedHash.length === 32
      && this.opaqueValues.matchesHash(domainValue(purpose, value), expectedHash);
  }
}

export function isOnboardingCredential(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

function domainValue(purpose: OnboardingCredentialPurpose, value: string): string {
  return `dollhouse/onboarding/${purpose}/v1\0${value}`;
}
