import { env } from '../config/env.js';
/** Attribution is server-owned metadata, never part of an approved request hash. */
export const INTEGRATION_ENTRY_POINTS = ['discrete_tool', 'mcp_aql_execute', 'mcp_aql', 'promoted_tool', 'legacy_tool_args'] as const;
export type IntegrationEntryPoint = typeof INTEGRATION_ENTRY_POINTS[number];
export interface IntegrationInvocationContext {
  readonly entry_point: IntegrationEntryPoint;
}
export function isIntegrationEntryPoint(value: unknown): value is IntegrationEntryPoint {
  return typeof value === 'string' && (INTEGRATION_ENTRY_POINTS as readonly string[]).includes(value);
}

export function integrationInvocationContext(input: unknown, fallback: IntegrationEntryPoint): IntegrationInvocationContext {
  return { entry_point: input && typeof input === 'object' && 'tool' in input ? 'legacy_tool_args' : fallback };
}


/** Retry attribution follows the originating interface, even if the current mode differs. */
export function integrationRetryGuidance(entryPoint?: IntegrationEntryPoint): string {
  switch (entryPoint) {
    case 'promoted_tool': return 'Retry the original promoted tool with the same arguments.';
    case 'legacy_tool_args': return 'Retry the original endpoint with {tool: "integration_request", args: <same arguments>}.';
    case 'discrete_tool': return 'Retry integration_request with the same arguments.';
    case 'mcp_aql': return 'Retry mcp_aql with operation integration_request and the same params.';
    case 'mcp_aql_execute': return 'Retry mcp_aql_execute with operation integration_request and the same params.';
    default:
      if (env.MCP_INTERFACE_MODE === 'discrete') return integrationRetryGuidance('discrete_tool');
      return integrationRetryGuidance(env.MCP_AQL_ENDPOINT_MODE === 'single' ? 'mcp_aql' : 'mcp_aql_execute');
  }
}
