/**
 * Ensemble element public exports
 */

// Types
export type {
  ActivationStrategy,
  ConflictResolutionStrategy,
  ElementRole,
  ActivationMode,
  ResourceLimits,
  EnsembleMetadata,
  EnsembleElement,
  ElementActivationResult,
  SharedContext,
  ContextConflict,
  EnsembleActivationResult,
  CircularDependency
} from './types.js';

// Constants
export {
  ENSEMBLE_LIMITS,
  ENSEMBLE_DEFAULTS,
  ACTIVATION_STRATEGIES,
  CONFLICT_STRATEGIES,
  ELEMENT_ROLES,
  ACTIVATION_MODES,
  ENSEMBLE_SECURITY_EVENTS,
  ENSEMBLE_ERRORS,
  ENSEMBLE_PATTERNS,
  // Configurable limits (Issue #368)
  ENSEMBLE_HARD_LIMITS,
  ENSEMBLE_MIN_LIMITS,
  getEffectiveLimits,
  setGlobalEnsembleLimits,
  getGlobalEnsembleLimits,
  resetGlobalEnsembleLimits
} from './constants.js';

// Configurable limits types (Issue #368)
export type { EnsembleLimitsConfig, ResolvedEnsembleLimits } from './constants.js';

// Classes
export { Ensemble } from './Ensemble.js';
export { EnsembleManager } from './EnsembleManager.js';
