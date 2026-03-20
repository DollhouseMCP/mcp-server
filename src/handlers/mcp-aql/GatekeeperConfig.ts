/**
 * Gatekeeper Configuration
 *
 * Default configuration for the Gatekeeper Policy Engine.
 * Contains tunable settings for verification strictness,
 * timeouts, and other enforcement parameters.
 */

import { VerificationStrictness } from './GatekeeperTypes.js';

/**
 * Gatekeeper configuration interface.
 * All settings are optional and fall back to defaults.
 */
export interface GatekeeperConfigOptions {
  /** Verification strictness level (default: STANDARD) */
  strictness?: VerificationStrictness;
  /** Timeout for verification prompts in milliseconds (default: 60000) */
  verificationTimeoutMs?: number;
  /** Whether to enable audit logging (default: true) */
  enableAuditLogging?: boolean;
  /** Maximum number of session confirmations to cache (default: 100) */
  maxSessionConfirmations?: number;
  /**
   * Whether active element policies (allow/confirm/deny/scopeRestrictions) can override the
   * default operation permission levels (default: true).
   *
   * When `true` (default): elements loaded into the session can elevate or restrict any
   * elevatable operation within the policy hierarchy (deny > confirm > allow > route default).
   *
   * When `false`: Layer 2 of `Gatekeeper.enforce()` is bypassed entirely. Only route validation
   * and default operation permission levels apply — no element can elevate or restrict anything.
   *
   * Use cases:
   * - **Emergency lockdown**: operator disables the element policy layer when a compromised
   *   or malformed element is suspected of influencing enforcement decisions.
   * - **Hardened deployment**: infrastructure-managed policy only; elements must never touch
   *   security posture (set this via env-var or deploy config).
   * - **Policy debugging**: isolate whether a gatekeeper decision originates from element
   *   policy or from the route default by toggling this flag.
   */
  allowElementPolicyOverrides?: boolean;
  /** Whether danger zone operations require extra verification (default: true) */
  requireDangerZoneVerification?: boolean;
}

/**
 * Default Gatekeeper configuration.
 * These values provide a secure, user-friendly balance.
 */
export const DEFAULT_GATEKEEPER_CONFIG: Required<GatekeeperConfigOptions> = {
  strictness: VerificationStrictness.STANDARD,
  verificationTimeoutMs: 60000, // 60 seconds
  enableAuditLogging: true,
  maxSessionConfirmations: 100,
  allowElementPolicyOverrides: true,
  requireDangerZoneVerification: true,
};

/**
 * Gatekeeper configuration manager.
 * Merges user config with defaults and provides type-safe access.
 */
export class GatekeeperConfig {
  private readonly config: Required<GatekeeperConfigOptions>;

  constructor(options: GatekeeperConfigOptions = {}) {
    this.config = {
      ...DEFAULT_GATEKEEPER_CONFIG,
      ...options,
    };
  }

  /**
   * Get the verification strictness level.
   */
  get strictness(): VerificationStrictness {
    return this.config.strictness;
  }

  /**
   * Get the verification timeout in milliseconds.
   */
  get verificationTimeoutMs(): number {
    return this.config.verificationTimeoutMs;
  }

  /**
   * Check if audit logging is enabled.
   */
  get enableAuditLogging(): boolean {
    return this.config.enableAuditLogging;
  }

  /**
   * Get the maximum number of session confirmations to cache.
   */
  get maxSessionConfirmations(): number {
    return this.config.maxSessionConfirmations;
  }

  /**
   * Whether element policies are permitted to override default operation permission levels.
   * When `false`, Layer 2 of `Gatekeeper.enforce()` is skipped entirely (operator kill switch).
   */
  get allowElementPolicyOverrides(): boolean {
    return this.config.allowElementPolicyOverrides;
  }

  /**
   * Check if danger zone operations require extra verification.
   */
  get requireDangerZoneVerification(): boolean {
    return this.config.requireDangerZoneVerification;
  }

  /**
   * Get a copy of the full configuration.
   */
  toJSON(): Required<GatekeeperConfigOptions> {
    return { ...this.config };
  }
}
