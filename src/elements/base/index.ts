/**
 * Base Element Module - Exports for element manager foundation classes
 *
 * This module provides the core infrastructure for element management:
 * - BaseElementManager: Abstract base class for all element managers
 * - ElementFileOperations: Common file operations
 * - ElementValidation: Common validation utilities
 *
 * These classes provide shared functionality across all element managers
 * (PersonaManager, SkillManager, TemplateManager, AgentManager, MemoryManager).
 */

export { BaseElementManager, type BaseElementManagerOptions, type InvalidElementRecord } from './BaseElementManager.js';
export { ElementFileOperations, type ParsedFile, type FileOperationOptions } from './ElementFileOperations.js';
export { ElementValidation, VALIDATION_CONSTANTS, type TriggerValidationResult } from './ElementValidation.js';
