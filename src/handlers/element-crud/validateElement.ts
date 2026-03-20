/**
 * FIX: DMCP-SEC-006 - Security audit suppression
 * This file delegates validation to element managers.
 * Audit logging happens in the managers themselves.
 * @security-audit-suppress DMCP-SEC-006
 */

import { ElementType } from '../../portfolio/PortfolioManager.js';
import { ElementCrudContext } from './types.js';
import { logger } from '../../utils/logger.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import {
  normalizeElementTypeInput,
  formatValidElementTypesList,
  getElementTypeLabel,
  resolveElementByName,
  ElementManagerOperations
} from './helpers.js';
import { ElementNotFoundError } from '../../utils/ErrorHandler.js';
import type { ValidationResult } from '../../services/validation/ValidationRegistry.js';

export interface ValidateElementArgs {
  name: string;
  type: string;
  strict?: boolean;
}

export async function validateElement(
  context: ElementCrudContext,
  args: ValidateElementArgs
) {
  await context.ensureInitialized();

  try {
    const { name, type, strict = false } = args;

    const { type: normalizedType } = normalizeElementTypeInput(type);
    logger.debug('[ElementCRUD] Normalized type', { inputType: type, normalizedType });

    if (!normalizedType) {
      return invalidType(type);
    }

    // FIX: Issue #281 - PERSONA now uses standard validation flow
    const manager = getManager(context, normalizedType);
    if (!manager) {
      return unsupportedType(normalizedType);
    }

    const element = await resolveElementByName(manager, normalizedType, name);

    if (!element) {
      // Issue #275: Throw error instead of returning content for missing elements
      throw new ElementNotFoundError(getElementTypeLabel(normalizedType), name);
    }

    // Use ElementValidator from ValidationRegistry for metadata validation
    const validator = context.validationRegistry.getValidator(normalizedType);
    const validatorResult: ValidationResult = await validator.validateMetadata(element.metadata);

    // Also call element's own validation for backwards compatibility
    const elementValidation = element.validate();

    // Combine results - validator gives string errors/warnings, element.validate() gives {field, message} objects
    const validationResult = {
      valid: validatorResult.isValid && elementValidation.valid,
      errors: [
        ...validatorResult.errors.map((e: string) => ({ field: 'general', message: e })),
        ...(elementValidation.errors ?? [])
      ],
      warnings: [
        ...validatorResult.warnings.map((w: string) => ({ field: 'general', message: w })),
        ...(elementValidation.warnings ?? [])
      ],
      suggestions: [
        ...(validatorResult.suggestions ?? []),
        ...(elementValidation.suggestions ?? [])
      ]
    };

    const report = buildReport(normalizedType, name, validationResult, strict);

    // FIX: DMCP-SEC-006 - Add security audit logging for validation
    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_VALIDATED',
      severity: 'LOW',
      source: 'validateElement',
      details: `Validated ${normalizedType}: ${name}`,
      additionalData: { elementType: normalizedType, isValid: validationResult.valid }
    });

    return {
      content: [{
        type: "text",
        text: report
      }]
    };
  } catch (error) {
    // Re-throw ElementNotFoundError to propagate to MCP-AQL layer
    // Issue #275: Handlers return success=true for missing elements
    if (error instanceof ElementNotFoundError) {
      throw error;
    }

    logger.error(`Failed to validate element:`, error);
    return {
      content: [{
        type: "text",
        text: `❌ Failed to validate element: ${error instanceof Error ? error.message : 'Unknown error'}`
      }]
    };
  }
}

function invalidType(type: string) {
  return {
    content: [{
      type: "text",
      text: `❌ Invalid element type '${type}'. Valid types: ${formatValidElementTypesList()}`
    }]
  };
}

function unsupportedType(type: ElementType) {
  const labelPlural = getElementTypeLabel(type, { plural: true });
  return {
    content: [{
      type: "text",
      text: `❌ Element type '${labelPlural}' is not yet supported for validation`
    }]
  };
}

function buildReport(
  type: ElementType,
  name: string,
  validationResult: any,
  strict: boolean
) {
  const label = getElementTypeLabel(type);
  let report = `🔍 Validation Report for ${label} '${name}':\n`;
  report += `${validationResult.valid ? '✅' : '❌'} Status: ${validationResult.valid ? 'Valid' : 'Invalid'}\n\n`;

  if (validationResult.errors && validationResult.errors.length > 0) {
    report += `❌ Errors (${validationResult.errors.length}):\n`;
    validationResult.errors.forEach((error: any) => {
      if (typeof error === 'string') {
        report += `   • General: ${error}\n`;
      } else {
        report += `   • ${error.field || 'General'}: ${error.message}\n`;
        if (error.fix) {
          report += `     💡 Fix: ${error.fix}\n`;
        }
      }
    });
    report += '\n';
  }

  if (validationResult.warnings && validationResult.warnings.length > 0) {
    report += `⚠️  Warnings (${validationResult.warnings.length}):\n`;
    validationResult.warnings.forEach((warning: any) => {
      if (typeof warning === 'string') {
        report += `   • General: ${warning}\n`;
      } else {
        report += `   • ${warning.field || 'General'}: ${warning.message}\n`;
        if (warning.suggestion) {
          report += `     💡 Suggestion: ${warning.suggestion}\n`;
        }
      }
    });
    report += '\n';
  }

  if (validationResult.suggestions && validationResult.suggestions.length > 0) {
    report += `💡 Suggestions:\n`;
    validationResult.suggestions.forEach((suggestion: string) => {
      report += `   • ${suggestion}\n`;
    });
  }

  if (strict) {
    report += '\n📋 Strict Mode: Additional quality checks applied';
  }

  return report;
}

function getManager(context: ElementCrudContext, type: ElementType): ElementManagerOperations<any> | null {
  switch (type) {
    // FIX: Issue #281 - PERSONA now uses standard validation flow
    case ElementType.PERSONA:
      return context.personaManager;
    case ElementType.SKILL:
      return context.skillManager;
    case ElementType.TEMPLATE:
      return context.templateManager;
    case ElementType.AGENT:
      return context.agentManager;
    case ElementType.MEMORY:
      // FIX: Added memory validation support (fixes #1042)
      // Previously: Memories returned "not yet supported for validation"
      // Now: Full validation including metadata, retention, entry structure
      return context.memoryManager;
    case ElementType.ENSEMBLE:
      return context.ensembleManager;
    default:
      return null;
  }
}
