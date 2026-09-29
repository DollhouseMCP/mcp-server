import { env } from '../../config/env.js';
import type { IntegrationOperationDetails, IntegrationOperationCatalogResult } from '../../web-console/modules/integrations/IntegrationOperationCatalog.js';

export type IntegrationInvocation =
  | { readonly endpoint: 'mcp_aql_execute' | 'mcp_aql'; readonly operation: 'integration_request'; readonly params: Record<string, unknown> }
  | { readonly tool: 'integration_request'; readonly args: Record<string, unknown> };

/** Decorate only the transient tool response; the catalog and stored skills stay mode-neutral. */
export function describeIntegrationInvocation(details: IntegrationOperationDetails): IntegrationOperationDetails & {
  readonly gatewayRequest: IntegrationOperationDetails['gatewayRequest'] & { readonly invocation: IntegrationInvocation };
} {
  const request = details.gatewayRequest;
  const params = { provider: request.provider, method: request.method, path: request.pathTemplate };
  const invocation: IntegrationInvocation = env.MCP_INTERFACE_MODE === 'discrete'
    ? { tool: 'integration_request', args: params }
    : { endpoint: env.MCP_AQL_ENDPOINT_MODE === 'single' ? 'mcp_aql' : 'mcp_aql_execute', operation: 'integration_request', params };
  return { ...details, gatewayRequest: { ...request, invocation } };
}

export function integrationCallGuidance(operation: string): string {
  if (env.MCP_INTERFACE_MODE === 'discrete') {
    if (operation === 'list_integration_operations') return 'list_operations';
    if (operation === 'describe_integration_operation') return 'describe_operation';
    if (operation === 'integration_request') return 'integration_request';
    if (operation === 'create_integration_skill' || operation === 'update_integration_skill') return 'regenerate_integration_skill';
    if (operation === 'create_integration_spec' || operation === 'update_integration_spec') return 'ingest_openapi_spec';
    return operation;
  }
  let action = 'read';
  if (operation === 'integration_request') action = 'execute';
  else if (operation.startsWith('create_')) action = 'create';
  else if (operation.startsWith('update_')) action = 'update';
  const endpoint = env.MCP_AQL_ENDPOINT_MODE === 'single' ? 'mcp_aql' : `mcp_aql_${action}`;
  return `${endpoint} / ${operation}`;
}

export function formatIntegrationGuidance(message: string): string {
  if (env.MCP_INTERFACE_MODE === 'discrete') {
    message = message.replaceAll(/Use (?:mcp_aql_create \/ )?create_integration_skill with a new skill_name\./gu,
      'Resolve the conflicting portfolio skill, then retry regenerate_integration_skill with provider.');
  }
  return message.replaceAll(/(?:mcp_aql_(?:read|create|update|execute) \/ )?\b(integration_request|(?:create|update)_integration_(?:skill|spec)|(?:list|describe)_integration_operations?|get_element)\b/gu,
    (_match, operation: string) => integrationCallGuidance(operation));
}


export function integrationDescribeToolDescription(): string {
  const prefix = 'Describe one OpenAPI-derived integration operation and call';
  if (env.MCP_INTERFACE_MODE === 'discrete') {
    return `${prefix} integration_request with provider, method, path and optional query/body.`;
  }
  const endpoint = env.MCP_AQL_ENDPOINT_MODE === 'single' ? 'mcp_aql' : 'mcp_aql_execute';
  return `${prefix} ${endpoint} with operation integration_request and params containing provider, method, path and optional query/body.`;
}

export function describeIntegrationSkillStatus(result: IntegrationOperationCatalogResult): IntegrationOperationCatalogResult {
  if (!result.skillStatus) return result;
  return { ...result, skillStatus: result.skillStatus.map(skill => {
    if (!skill.guidance) return skill;
    if (env.MCP_INTERFACE_MODE !== 'discrete') return { ...skill, guidance: formatIntegrationGuidance(skill.guidance) };
    const guidance = {
      current: undefined,
      unreadable: skill.guidance,
      outdated: 'Use regenerate_integration_skill with provider to refresh generated content.',
      edited: 'Use regenerate_integration_skill with provider to create a separate revision preserving this edited skill.',
      legacy: 'This legacy skill is preserved. Use list_operations and describe_operation for current operations; regenerate_integration_skill with provider refreshes after a spec or scope change.',
    }[skill.status];
    return { ...skill, guidance };
  }) };
}
