/**
 * BaseActivationStrategy - Shared functionality for all activation strategies
 *
 * Provides common helper methods used by multiple strategy implementations:
 * - Flexible element finding (by name or filename)
 * - Error response formatting
 */

import { findElementFlexibly as findHelper } from '../element-crud/helpers.js';
import { ElementNotFoundError } from '../../utils/ErrorHandler.js';
import { MCPResponse } from './ElementActivationStrategy.js';
import { getPermissionHookStatus } from '../../utils/permissionHooks.js';

/**
 * Base class with shared utilities for activation strategies
 */
export abstract class BaseActivationStrategy {
  /**
   * Find an element by name, supporting both exact display name and filename (slug) matching
   * @param name - The name or filename to search for
   * @param elementList - List of elements to search through
   * @returns The found element or undefined
   */
  protected async findElementFlexibly(name: string, elementList: any[]): Promise<any> {
    return findHelper(name, elementList);
  }

  /**
   * Create a standard error response
   * @param message - The error message
   * @returns MCP-formatted error response
   */
  protected createErrorResponse(message: string): MCPResponse {
    return {
      content: [{
        type: "text",
        text: message
      }]
    };
  }

  /**
   * Create a standard success response
   * @param message - The success message
   * @returns MCP-formatted success response
   */
  protected createSuccessResponse(message: string): MCPResponse {
    return {
      content: [{
        type: "text",
        text: message
      }]
    };
  }

  /**
   * Throw an ElementNotFoundError for missing elements.
   *
   * This replaces the previous createNotFoundResponse which returned a success
   * response with error text. Now we throw to ensure MCP-AQL returns success=false.
   *
   * @param name - The name of the element that wasn't found
   * @param type - The type of element (for error message)
   * @throws {ElementNotFoundError} Always throws
   * @see Issue #275 - Handlers return success=true for missing elements
   */
  protected throwNotFoundError(name: string, type: string): never {
    throw new ElementNotFoundError(type, name);
  }

  /**
   * @deprecated Use throwNotFoundError instead to ensure proper error handling.
   * This method returns a success response which causes MCP-AQL to return success=true.
   * @see Issue #275 - Handlers return success=true for missing elements
   */
  protected createNotFoundResponse(name: string, type: string): MCPResponse {
    // Keep for backward compatibility but strategies should migrate to throwNotFoundError
    return this.createErrorResponse(`❌ ${type} '${name}' not found`);
  }

  /**
   * Format a fail-safe warning for elements with CLI external restrictions.
   * Appended to activation text so users are aware of restrictions even when
   * permission_prompt is not available (non-Claude-Code clients).
   *
   * @param metadata - Element metadata (may contain gatekeeper.externalRestrictions)
   * @returns Warning text or empty string if no restrictions
   * @see Issue #642 — Fail-safe enforcement for externalRestrictions
   */
  protected formatRestrictionWarning(metadata: Record<string, unknown>): string {
    const gatekeeper = metadata?.gatekeeper as Record<string, unknown> | undefined;
    const restrictions = gatekeeper?.externalRestrictions as Record<string, unknown> | undefined;
    if (!restrictions) return '';

    const hookStatus = getPermissionHookStatus();
    const parts: string[] = [hookStatus.installed
      ? '\n---\n**CLI Policies Loaded:**'
      : '\n---\n**CLI Policies Loaded (Hook Not Detected):**'];
    if (restrictions.description) {
      parts.push(`> ${restrictions.description}`);
    }
    const denyPatterns = restrictions.denyPatterns as string[] | undefined;
    if (denyPatterns?.length) {
      const shown = denyPatterns.slice(0, 5).join(', ');
      parts.push(`> Denied: ${shown}${denyPatterns.length > 5 ? '...' : ''}`);
    }
    const allowPatterns = restrictions.allowPatterns as string[] | undefined;
    if (allowPatterns?.length) {
      const shown = allowPatterns.slice(0, 5).join(', ');
      parts.push(`> Allowed only: ${shown}${allowPatterns.length > 5 ? '...' : ''}`);
    }
    const approvalPolicy = restrictions.approvalPolicy as Record<string, unknown> | undefined;
    const requireApproval = approvalPolicy?.requireApproval as string[] | undefined;
    if (requireApproval?.length) {
      parts.push(`> Requires approval for: ${requireApproval.join(', ')} risk tools`);
    }
    parts.push('> Use `get_effective_cli_policies` to see combined policy state.');
    if (hookStatus.installed) {
      parts.push(`> Permission hook detected for ${hookStatus.host ?? 'this client'}. Enforcement depends on using that client configuration.`);
    } else {
      parts.push('> No permission hook detected. These policies are not automatically enforced unless the CLI is launched with `--permission-prompt-tool`.');
      parts.push('> Run `open_setup` and reinstall to wire automatic enforcement.');
    }
    return parts.join('\n');
  }
}
