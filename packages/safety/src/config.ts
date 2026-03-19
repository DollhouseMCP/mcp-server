/**
 * Default safety configuration
 *
 * @since v1.0.0
 */

import { SafetyConfig } from './types.js';

/**
 * Default safety configuration for tiered safety system
 */
export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  thresholds: {
    advisory: 30,
    confirm: 31,
    verify: 61,
    dangerZone: 86,
  },
  dangerZone: {
    enabled: false,
    requiresVerify: true,
    requiresAuthenticator: true,
    patterns: [
      'rm\\s+-rf',
      'DROP\\s+TABLE',
      'DELETE\\s+FROM.*WHERE\\s+1\\s*=\\s*1',
      'eval\\s*\\(',
      'exec\\s*\\(',
      'child_process',
      'process\\.exit',
    ],
  },
  agentChain: {
    maxAutonomousDepth: 2,
    requireOriginatingHuman: true,
  },
  verificationMethods: ['authenticator', 'display_code'],
};
