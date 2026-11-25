/**
 * BaseActivationStrategy - Shared functionality for all activation strategies
 *
 * Provides common helper methods used by multiple strategy implementations:
 * - Text response building (success and error responses share one builder)
 * - Collection-report rendering with its incomplete-collection notice
 * - Not-found refusals and gatekeeper/restriction warnings
 */

import { ElementNotFoundError } from '../../utils/ErrorHandler.js';
import { MCPResponse } from './ElementActivationStrategy.js';
import { getPermissionHookStatus } from '../../utils/permissionHooks.js';
import { getGatekeeperDiagnostics } from '../mcp-aql/policies/ElementPolicies.js';
import { collectionReportNotice, type CollectionReport } from '../../elements/base/CollectionReport.js';

/**
 * Base class with shared utilities for activation strategies
 */
export abstract class BaseActivationStrategy {
  protected async renderCollectionReport<T>(report: CollectionReport<T>, render: (items: T[]) => MCPResponse | Promise<MCPResponse>): Promise<MCPResponse> {
    const response = !report.complete && report.items.length === 0 ? { content: [] } : await render(report.items);
    if (report.complete) return response;
    return { ...response, content: [...response.content, {
      type: 'text', text: collectionReportNotice(report),
    }] };
  }
  /**
   * Create a standard error response
   * @param message - The error message
   * @returns MCP-formatted error response
   */
  protected createErrorResponse(message: string): MCPResponse {
    return this.textResponse(message);
  }

  /**
   * Create a standard success response
   * @param message - The success message
   * @returns MCP-formatted success response
   */
  protected createSuccessResponse(message: string): MCPResponse {
    return this.textResponse(message);
  }

  /** The one text response both builders return; MCP-AQL success comes from not throwing. */
  private textResponse(message: string): MCPResponse {
    return {
      content: [{
        type: "text",
        text: message
      }]
    };
  }

  /**
   * Throw an ElementNotFoundError for missing elements, so MCP-AQL returns success=false.
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
    if (typeof restrictions.description === 'string' && restrictions.description) {
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
      parts.push(
        '> No permission hook detected. These policies are not automatically enforced unless the CLI is launched with `--permission-prompt-tool`.',
        '> Run `open_setup` and reinstall to wire automatic enforcement.',
      );
    }
    return parts.join('\n');
  }

  protected formatGatekeeperValidityWarning(metadata: Record<string, unknown>): string {
    const diagnostics = getGatekeeperDiagnostics(metadata);
    if (!diagnostics) {
      return '';
    }

    return [
      '\n---',
      '**Gatekeeper Policy Warning:**',
      `> ${diagnostics.message}`,
      '> This element can still activate and do its normal work, but its malformed gatekeeper policy is not being enforced.',
      '> Fix the policy structure and reactivate if you want permission rules to apply.',
    ].join('\n');
  }
}
