/**
 * Capability detection utilities
 *
 * This module provides utilities for detecting and analyzing element capabilities.
 * It helps determine which tests should run based on element type configuration.
 *
 * Key Design Principles:
 * - Declarative: Capabilities declared in config, not detected at runtime
 * - Clear: Simple boolean checks for capability presence
 * - Extensible: Easy to add new capability checks
 */

import type {
  ElementTypeTestConfig,
  ElementCapabilities,
  ActivationConfig,
  NestingConfig,
  StateConfig,
  ReferenceConfig,
} from '../config/types.js';

/**
 * Detect all capabilities from element type configuration
 *
 * Returns a summary of which capabilities are present.
 *
 * @param config - Element type test configuration
 * @returns Capability detection result
 *
 * @example
 * ```typescript
 * const caps = detectCapabilities(personaConfig);
 * if (caps.hasActivation) {
 *   // Run activation tests
 * }
 * ```
 */
export function detectCapabilities(config: ElementTypeTestConfig): CapabilityDetectionResult {
  return {
    hasActivation: hasActivationSupport(config),
    hasNesting: hasNestingSupport(config),
    hasStateFile: hasStateFileSupport(config),
    hasReferences: hasReferenceSupport(config),
    capabilities: config.capabilities,
  };
}

/**
 * Check if element type supports activation
 *
 * @param config - Element type test configuration
 * @returns True if activation is supported
 */
export function hasActivationSupport(config: ElementTypeTestConfig): boolean {
  return config.capabilities.supportsActivation !== undefined;
}

/**
 * Check if element type supports nesting
 *
 * @param config - Element type test configuration
 * @returns True if nesting is supported
 */
export function hasNestingSupport(config: ElementTypeTestConfig): boolean {
  return config.capabilities.supportsNesting !== undefined;
}

/**
 * Check if element type has state file
 *
 * @param config - Element type test configuration
 * @returns True if state file is used
 */
export function hasStateFileSupport(config: ElementTypeTestConfig): boolean {
  return config.capabilities.hasStateFile !== undefined;
}

/**
 * Check if element type supports references
 *
 * @param config - Element type test configuration
 * @returns True if references are supported
 */
export function hasReferenceSupport(config: ElementTypeTestConfig): boolean {
  return config.capabilities.supportsReferences !== undefined;
}

/**
 * Get activation configuration
 *
 * @param config - Element type test configuration
 * @returns Activation config or undefined
 */
export function getActivationConfig(config: ElementTypeTestConfig): ActivationConfig | undefined {
  return config.capabilities.supportsActivation;
}

/**
 * Get nesting configuration
 *
 * @param config - Element type test configuration
 * @returns Nesting config or undefined
 */
export function getNestingConfig(config: ElementTypeTestConfig): NestingConfig | undefined {
  return config.capabilities.supportsNesting;
}

/**
 * Get state file configuration
 *
 * @param config - Element type test configuration
 * @returns State config or undefined
 */
export function getStateConfig(config: ElementTypeTestConfig): StateConfig | undefined {
  return config.capabilities.hasStateFile;
}

/**
 * Get reference configuration
 *
 * @param config - Element type test configuration
 * @returns Reference config or undefined
 */
export function getReferenceConfig(config: ElementTypeTestConfig): ReferenceConfig | undefined {
  return config.capabilities.supportsReferences;
}

/**
 * Check if activation requires context
 *
 * @param config - Element type test configuration
 * @returns True if activation requires context
 */
export function requiresActivationContext(config: ElementTypeTestConfig): boolean {
  const activationConfig = getActivationConfig(config);
  return activationConfig?.requiresContext ?? false;
}

/**
 * Get activation strategy
 *
 * @param config - Element type test configuration
 * @returns Activation strategy or undefined
 */
export function getActivationStrategy(
  config: ElementTypeTestConfig
): ActivationConfig['activationStrategy'] | undefined {
  const activationConfig = getActivationConfig(config);
  return activationConfig?.activationStrategy;
}

/**
 * Get maximum nesting depth
 *
 * @param config - Element type test configuration
 * @returns Max nesting depth or 0 if not supported
 */
export function getMaxNestingDepth(config: ElementTypeTestConfig): number {
  const nestingConfig = getNestingConfig(config);
  return nestingConfig?.maxDepth ?? 0;
}

/**
 * Check if circular dependency detection is enabled
 *
 * @param config - Element type test configuration
 * @returns True if circular detection enabled
 */
export function detectsCircularDependencies(config: ElementTypeTestConfig): boolean {
  const nestingConfig = getNestingConfig(config);
  return nestingConfig?.detectCircular ?? false;
}

/**
 * Get test contexts for activation testing
 *
 * @param config - Element type test configuration
 * @returns Array of test contexts or empty array
 */
export function getTestContexts(config: ElementTypeTestConfig): Array<{
  description: string;
  context?: Record<string, any>;
  expectedOutcome: string;
}> {
  const activationConfig = getActivationConfig(config);
  return activationConfig?.testContexts ?? [];
}

/**
 * Generate capability summary for logging
 *
 * Creates a human-readable summary of element capabilities.
 *
 * @param config - Element type test configuration
 * @returns Formatted capability summary
 */
export function getCapabilitySummary(config: ElementTypeTestConfig): string {
  const lines: string[] = [
    `Capabilities for ${config.displayName}:`,
  ];

  if (hasActivationSupport(config)) {
    const strategy = getActivationStrategy(config);
    const requiresCtx = requiresActivationContext(config);
    lines.push(`  ✓ Activation (${strategy}, ${requiresCtx ? 'requires context' : 'no context'})`);
  } else {
    lines.push('  ✗ Activation');
  }

  if (hasNestingSupport(config)) {
    const maxDepth = getMaxNestingDepth(config);
    const circular = detectsCircularDependencies(config);
    lines.push(`  ✓ Nesting (max depth: ${maxDepth}, ${circular ? 'circular detection' : 'no circular detection'})`);
  } else {
    lines.push('  ✗ Nesting');
  }

  if (hasStateFileSupport(config)) {
    const stateConfig = getStateConfig(config);
    lines.push(`  ✓ State File (${stateConfig?.fileExtension})`);
  } else {
    lines.push('  ✗ State File');
  }

  if (hasReferenceSupport(config)) {
    const refConfig = getReferenceConfig(config);
    lines.push(`  ✓ References (${refConfig?.bidirectional ? 'bidirectional' : 'unidirectional'})`);
  } else {
    lines.push('  ✗ References');
  }

  return lines.join('\n');
}

/**
 * Capability detection result
 */
export interface CapabilityDetectionResult {
  hasActivation: boolean;
  hasNesting: boolean;
  hasStateFile: boolean;
  hasReferences: boolean;
  capabilities: ElementCapabilities;
}

/**
 * Validate capability configuration
 *
 * Checks that capability configuration is complete and valid.
 *
 * @param config - Element type test configuration
 * @returns Validation result with any errors
 */
export function validateCapabilityConfig(config: ElementTypeTestConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Validate activation config if present
  if (config.capabilities.supportsActivation) {
    const activationConfig = config.capabilities.supportsActivation;
    if (!activationConfig.activationStrategy) {
      errors.push('Activation config missing activationStrategy');
    }
    if (activationConfig.requiresContext === undefined) {
      errors.push('Activation config missing requiresContext');
    }
    if (!activationConfig.expectedResultType) {
      errors.push('Activation config missing expectedResultType');
    }
  }

  // Validate nesting config if present
  if (config.capabilities.supportsNesting) {
    const nestingConfig = config.capabilities.supportsNesting;
    if (!nestingConfig.maxDepth || nestingConfig.maxDepth <= 0) {
      errors.push('Nesting config has invalid maxDepth');
    }
    if (!nestingConfig.allowedTypes || nestingConfig.allowedTypes.length === 0) {
      errors.push('Nesting config missing allowedTypes');
    }
    if (nestingConfig.detectCircular === undefined) {
      errors.push('Nesting config missing detectCircular');
    }
    if (!nestingConfig.nestingField) {
      errors.push('Nesting config missing nestingField');
    }
  }

  // Validate state file config if present
  if (config.capabilities.hasStateFile) {
    const stateConfig = config.capabilities.hasStateFile;
    if (!stateConfig.fileExtension) {
      errors.push('State file config missing fileExtension');
    }
    if (stateConfig.cleanupOnDelete === undefined) {
      errors.push('State file config missing cleanupOnDelete');
    }
  }

  // Validate reference config if present
  if (config.capabilities.supportsReferences) {
    const refConfig = config.capabilities.supportsReferences;
    if (!refConfig.referenceTypes || refConfig.referenceTypes.length === 0) {
      errors.push('Reference config missing referenceTypes');
    }
    if (refConfig.bidirectional === undefined) {
      errors.push('Reference config missing bidirectional');
    }
    if (!refConfig.referenceField) {
      errors.push('Reference config missing referenceField');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
