/**
 * Standardized message templates for element operations
 *
 * Issue #24 (LOW PRIORITY): Consistent error message formatting across all managers
 *
 * This utility provides consistent message formatting for common element operations
 * across all manager implementations (SkillManager, AgentManager, MemoryManager, EnsembleManager).
 *
 * USAGE:
 * - Use ElementMessages.notFound() for element not found errors
 * - Use ElementMessages.activated() for successful activation
 * - Use ElementMessages.deactivated() for successful deactivation
 * - Use ElementMessages.alreadyExists() for duplicate element errors
 *
 * BENEFITS:
 * - Consistent UX across all element types
 * - Single source of truth for message formatting
 * - Easier to update message formats in the future
 * - Better i18n support if needed later
 */

import { ElementType } from '../portfolio/types.js';

/**
 * Get human-readable label for element type (singular form)
 */
function getElementLabel(elementType: ElementType): string {
  const labels: Record<ElementType, string> = {
    [ElementType.PERSONA]: 'persona',
    [ElementType.SKILL]: 'skill',
    [ElementType.TEMPLATE]: 'template',
    [ElementType.AGENT]: 'agent',
    [ElementType.MEMORY]: 'memory',
    [ElementType.ENSEMBLE]: 'ensemble'
  };
  return labels[elementType] || 'element';
}

/**
 * Get capitalized element label
 */
function getElementLabelCapitalized(elementType: ElementType): string {
  const label = getElementLabel(elementType);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Standardized message templates for element operations
 */
export const ElementMessages = {
  /**
   * Element not found error message
   * @param elementType - Type of element
   * @param identifier - Name or ID that was searched for
   * @returns Formatted error message
   */
  notFound(elementType: ElementType, identifier: string): string {
    const label = getElementLabelCapitalized(elementType);
    return `${label} '${identifier}' not found`;
  },

  /**
   * Element successfully activated message
   * @param elementType - Type of element
   * @param name - Name of the activated element
   * @returns Formatted success message
   */
  activated(elementType: ElementType, name: string): string {
    const label = getElementLabelCapitalized(elementType);
    return `${label} '${name}' activated`;
  },

  /**
   * Element successfully deactivated message
   * @param elementType - Type of element
   * @param name - Name of the deactivated element
   * @returns Formatted success message
   */
  deactivated(elementType: ElementType, name: string): string {
    const label = getElementLabelCapitalized(elementType);
    return `${label} '${name}' deactivated`;
  },

  /**
   * Element already exists error message
   * @param elementType - Type of element
   * @param name - Name of the existing element
   * @returns Formatted error message
   */
  alreadyExists(elementType: ElementType, name: string): string {
    const label = getElementLabelCapitalized(elementType);
    return `${label} '${name}' already exists`;
  },

  /**
   * Invalid element name error message
   * @param elementType - Type of element
   * @returns Formatted error message
   */
  invalidName(elementType: ElementType): string {
    const label = getElementLabelCapitalized(elementType);
    return `Invalid ${label.toLowerCase()} name. Use only letters, numbers, hyphens, and underscores.`;
  },

  /**
   * Element created success message
   * @param elementType - Type of element
   * @param name - Name of the created element
   * @param author - Author of the element (optional)
   * @returns Formatted success message
   */
  created(elementType: ElementType, name: string, author?: string): string {
    const icon = elementType === ElementType.AGENT ? '🤖' : '✓';
    const authorSuffix = author ? ` by ${author}` : '';
    return `${icon} **${name}**${authorSuffix}`;
  },

  /**
   * Element validation failed error message
   * @param elementType - Type of element
   * @param errors - Array of validation error messages
   * @returns Formatted error message
   */
  validationFailed(elementType: ElementType, errors: string[]): string {
    const label = getElementLabelCapitalized(elementType);
    return `Invalid ${label.toLowerCase()}: ${errors.join(', ')}`;
  }
};
