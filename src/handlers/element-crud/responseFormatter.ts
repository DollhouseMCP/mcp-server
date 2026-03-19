/**
 * Standardized response formatting for element CRUD operations
 *
 * This module provides consistent response formatting across all element handlers,
 * addressing the type confusion between CrudResponse and MCP response formats.
 */

import { CrudResponse } from '../../types/CrudResponse.js';
import { ElementType } from '../../portfolio/PortfolioManager.js';
import { getElementTypeLabel } from './helpers.js';

/**
 * MCP tool response format
 * This is the actual format returned by MCP tools
 */
export interface McpToolResponse {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

/**
 * Bridge between CrudResponse and MCP format
 * Converts structured CRUD responses to MCP tool responses
 */
export function crudResponseToMcp<T>(
  response: CrudResponse<T>,
  options?: {
    formatData?: (data: T) => string;
    context?: string;
  }
): McpToolResponse {
  if (response.success && response.data !== undefined) {
    const text = options?.formatData
      ? options.formatData(response.data)
      : `✅ Operation completed successfully`;

    return {
      content: [{ type: 'text', text }],
      isError: false
    };
  }

  // Error case
  const errorPrefix = options?.context || 'Operation failed';
  const errorMessage = response.error || 'Unknown error';
  const errorCode = response.errorCode ? ` (${response.errorCode})` : '';

  return {
    content: [{
      type: 'text',
      text: `❌ ${errorPrefix}: ${errorMessage}${errorCode}`
    }],
    isError: true
  };
}

/**
 * Format a structured error response with consistent styling
 *
 * @param title - Bold title for the error (e.g., "Persona Not Found")
 * @param message - Main error message
 * @param suggestion - Optional suggestion for the user
 * @returns Formatted MCP response
 */
export function formatErrorResponse(
  title: string,
  message: string,
  suggestion?: string
): McpToolResponse {
  let text = `❌ **${title}**\n\n${message}`;

  if (suggestion) {
    text += `\n\n${suggestion}`;
  }

  return {
    content: [{ type: 'text', text }],
    isError: true
  };
}

/**
 * Format a simple success message
 */
export function formatSuccessResponse(message: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: `✅ ${message}` }],
    isError: false
  };
}

/**
 * Format a simple error message
 */
export function formatSimpleErrorResponse(message: string): McpToolResponse {
  return {
    content: [{ type: 'text', text: `❌ ${message}` }],
    isError: true
  };
}

/**
 * Format element not found error with consistent styling
 */
export function formatNotFoundError(
  type: ElementType,
  name: string,
  listCommand?: string
): McpToolResponse {
  const typeLabel = getElementTypeLabel(type);
  const suggestion = listCommand
    ? `Use \`${listCommand}\` to see available ${getElementTypeLabel(type, { plural: true })}.`
    : `Check the ${typeLabel} name and try again.`;

  return formatErrorResponse(
    `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} Not Found`,
    `Could not find ${typeLabel}: "${name}"`,
    suggestion
  );
}

/**
 * Issue #708: Format error for elements that exist on disk but failed validation.
 * Distinct from "not found" — the file is present but the server can't load it.
 */
export function formatValidationFailedError(
  type: ElementType,
  name: string,
  reason: string,
  filePath?: string
): McpToolResponse {
  const typeLabel = getElementTypeLabel(type);
  const locationHint = filePath ? ` (file: ${filePath})` : '';
  return formatErrorResponse(
    `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} Invalid`,
    `The ${typeLabel} "${name}" exists on disk but failed to load${locationHint}: ${reason}`,
    'Fix the file manually or re-create the element. Run `query_logs level="error"` for details.'
  );
}

/**
 * Format duplicate element error with consistent styling
 */
export function formatDuplicateError(
  type: ElementType,
  name: string
): McpToolResponse {
  const typeLabel = getElementTypeLabel(type);

  return formatErrorResponse(
    'Element Already Exists',
    `A ${typeLabel} named "${name}" already exists`,
    `Choose a different name or delete the existing ${typeLabel} first.`
  );
}

/**
 * Format element creation success
 */
export function formatCreateSuccess(
  type: ElementType,
  name: string
): McpToolResponse {
  const typeLabel = getElementTypeLabel(type);
  return formatSuccessResponse(`Created ${typeLabel} '${name}' successfully`);
}

/**
 * Format element update success
 */
export function formatUpdateSuccess(
  type: ElementType,
  name: string,
  field?: string
): McpToolResponse {
  const typeLabel = getElementTypeLabel(type);
  const fieldInfo = field ? ` (updated ${field})` : '';
  return formatSuccessResponse(`Updated ${typeLabel} '${name}'${fieldInfo} successfully`);
}

/**
 * Format element deletion success
 */
export function formatDeleteSuccess(
  type: ElementType,
  name: string
): McpToolResponse {
  const typeLabel = getElementTypeLabel(type);
  return formatSuccessResponse(`Deleted ${typeLabel} '${name}' successfully`);
}

/**
 * Convert exception to formatted error response.
 * Issue #668: When the error is about invalid characters in a name,
 * suggest a corrected name so the caller can retry immediately.
 */
export function formatExceptionError(
  error: unknown,
  operation: string,
  type?: ElementType,
  name?: string
): McpToolResponse {
  const message = error instanceof Error ? error.message : String(error);
  const context = type && name
    ? `Failed to ${operation} ${getElementTypeLabel(type)} '${name}'`
    : `Failed to ${operation}`;

  let suggestion = '';
  if (name && message.includes('invalid characters')) {
    // Replace disallowed characters with hyphens, collapse runs, trim edges
    const corrected = name
      .replace(/[^a-zA-Z0-9\s\-_.]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');
    if (corrected && corrected !== name) {
      suggestion = ` Suggested name: '${corrected}'`;
    }
  }

  return formatSimpleErrorResponse(`${context}: ${message}${suggestion}`);
}
