/**
 * Shared environment variable parsing utilities
 *
 * Used by active-element-limits.ts, autonomy-config.ts,
 * and ensembles/constants.ts to avoid duplicating env-var parsing logic.
 */

import { logger } from '../utils/logger.js';

/**
 * Parse an integer from environment variable with validation and clamping.
 *
 * - Returns defaultValue if env var is unset or empty
 * - Returns defaultValue with warning if value is non-numeric
 * - Clamps to min with warning if value is below safety floor
 * - Clamps to max with warning if value exceeds security ceiling
 *
 * @param envVar - Environment variable name
 * @param defaultValue - Default value if not set or invalid
 * @param min - Minimum allowed value (safety floor)
 * @param max - Maximum allowed value (security ceiling)
 * @param domain - Domain label for warning messages (e.g. 'Active element limit', 'Ensemble limit')
 * @returns Validated integer value
 */
export function parseEnvInt(
  envVar: string,
  defaultValue: number,
  min: number,
  max: number,
  domain: string = 'Configuration'
): number {
  const envValue = process.env[envVar];
  if (envValue === undefined || envValue === '') {
    return defaultValue;
  }

  const parsed = parseInt(envValue, 10);
  if (isNaN(parsed)) {
    logger.warn(`${domain} environment variable validation failed: non-numeric value`, {
      envVar,
      providedValue: envValue,
      expectedType: 'integer',
      validRange: `${min}-${max}`,
      defaultValue,
      resolution: `Using default value: ${defaultValue}`,
      suggestion: `Set ${envVar} to an integer between ${min} and ${max}`
    });
    return defaultValue;
  }

  if (parsed < min) {
    logger.warn(`${domain} environment variable validation failed: value below minimum`, {
      envVar,
      providedValue: parsed,
      minimumAllowed: min,
      maximumAllowed: max,
      validRange: `${min}-${max}`,
      resolution: `Clamping to minimum value: ${min}`,
      suggestion: `Set ${envVar} to a value between ${min} and ${max}`
    });
    return min;
  }

  if (parsed > max) {
    logger.warn(`${domain} environment variable validation failed: value exceeds security ceiling`, {
      envVar,
      providedValue: parsed,
      minimumAllowed: min,
      maximumAllowed: max,
      validRange: `${min}-${max}`,
      resolution: `Clamping to security ceiling: ${max}`,
      reason: 'Values above the security ceiling could enable resource exhaustion',
      suggestion: `Set ${envVar} to a value between ${min} and ${max}`
    });
    return max;
  }

  return parsed;
}

/**
 * Parse a string enum from environment variable with validation.
 *
 * - Returns defaultValue if env var is unset or empty
 * - Normalizes to lowercase before comparison
 * - Returns defaultValue with warning if value is not in the valid set
 *
 * @param envVar - Environment variable name
 * @param defaultValue - Default value if not set or invalid
 * @param validValues - Set of allowed values (compared case-insensitively)
 * @param domain - Domain label for warning messages (e.g. 'Naming validation')
 * @returns Validated string value from the valid set
 */
export function parseEnvEnum<T extends string>(
  envVar: string,
  defaultValue: T,
  validValues: ReadonlySet<string>,
  domain: string = 'Configuration'
): T {
  const envValue = process.env[envVar];
  if (envValue === undefined || envValue === '') {
    return defaultValue;
  }

  const normalized = envValue.toLowerCase();
  if (validValues.has(normalized)) {
    return normalized as T;
  }

  const validList = Array.from(validValues).join(', ');
  logger.warn(`${domain} environment variable validation failed: invalid value`, {
    envVar,
    providedValue: envValue,
    expectedType: 'string enum',
    validValues: validList,
    defaultValue,
    resolution: `Using default value: ${defaultValue}`,
    suggestion: `Set ${envVar} to one of: ${validList}`
  });
  return defaultValue;
}
