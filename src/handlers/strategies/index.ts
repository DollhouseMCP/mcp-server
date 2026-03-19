/**
 * Strategy Pattern implementations for element activation/deactivation
 *
 * This module provides type-specific strategies for handling element operations,
 * replacing the previous switch-case pattern with more maintainable, testable code.
 */

// Export types (interfaces) - these are type-only exports
export type { ElementActivationStrategy, MCPResponse } from './ElementActivationStrategy.js';

// Export concrete classes
export { BaseActivationStrategy } from './BaseActivationStrategy.js';
export { TemplateActivationStrategy } from './TemplateActivationStrategy.js';
export { SkillActivationStrategy } from './SkillActivationStrategy.js';
export { AgentActivationStrategy } from './AgentActivationStrategy.js';
export { MemoryActivationStrategy } from './MemoryActivationStrategy.js';
export { PersonaActivationStrategy } from './PersonaActivationStrategy.js';
export { EnsembleActivationStrategy } from './EnsembleActivationStrategy.js';
