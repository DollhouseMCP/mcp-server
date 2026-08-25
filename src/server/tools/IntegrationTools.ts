import type { ToolDefinition, ToolHandler } from '../../handlers/types/ToolTypes.js';
import {
  IntegrationRequestError,
  type IntegrationRequestGateway,
} from '../../web-console/modules/integrations/IntegrationRequestGateway.js';
import type { IntegrationRequestPolicyEnforcer } from '../../web-console/modules/integrations/IntegrationRequestPolicy.js';
import { IntegrationPolicyUnavailableError } from '../../web-console/modules/integrations/IntegrationRequestPolicy.js';
import {
  IntegrationOperationCatalogError,
  type IntegrationOperationCatalog,
  type IntegrationOperationDetails,
} from '../../web-console/modules/integrations/IntegrationOperationCatalog.js';
import {
  IntegrationRemoteMcpBridgeError,
  type IntegrationRemoteMcpBridge,
  type RemoteMcpTool,
} from '../../web-console/modules/integrations/IntegrationRemoteMcpBridge.js';

const PROVIDER_DESCRIPTION = 'Integration provider id.';

export function getIntegrationTools(
  gateway: IntegrationRequestGateway,
  policyEnforcer?: IntegrationRequestPolicyEnforcer | null,
  operationCatalog?: IntegrationOperationCatalog | null,
): Array<{ tool: ToolDefinition; handler: ToolHandler }> {
  const tools: Array<{ tool: ToolDefinition; handler: ToolHandler }> = [{
    tool: {
      name: 'integration_request',
      description: 'Call a connected REST integration through the server-side credential gateway. Credentials are injected server-side and never returned.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description: PROVIDER_DESCRIPTION,
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
            description: 'HTTPS method to call.',
          },
          path: {
            type: 'string',
            description: 'Absolute API path, optionally including query string.',
          },
          query: {
            type: 'object',
            description: 'Optional primitive query parameters.',
          },
          body: {
            description: 'Optional JSON body for POST, PUT, and PATCH.',
          },
        },
        required: ['provider', 'method', 'path'],
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    handler: async (args: unknown) => {
      try {
        const request = readArgs(args);
        if (!policyEnforcer) return integrationPolicyUnavailableResponse();
        const policy = await policyEnforcer.authorize(request);
        if (!policy.allowed) {
          return textResponse({
            ok: false,
            error: policy.error,
            approvalRequest: policy.approvalRequest,
            policyContext: policy.policyContext,
          });
        }
        const result = await gateway.request(request);
        return textResponse({
          ok: true,
          result,
          approvalContext: policy.approvalContext,
        });
      } catch (error) {
        if (error instanceof IntegrationPolicyUnavailableError) {
          return textResponse({
            ok: false,
            error: {
              code: 'integration_request_policy_unavailable',
              message: error.message,
              status: 503,
            },
          });
        }
        if (error instanceof IntegrationRequestError) {
          return textResponse({
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              status: error.status,
            },
          });
        }
        throw error;
      }
    },
  }];
  if (operationCatalog) {
    tools.push(...getIntegrationOperationTools(operationCatalog, policyEnforcer));
  }
  return tools;
}

export async function getPromotedIntegrationTools(
  gateway: IntegrationRequestGateway,
  operationCatalog: IntegrationOperationCatalog,
  policyEnforcer?: IntegrationRequestPolicyEnforcer | null,
  reservedToolNames: ReadonlySet<string> = new Set(),
): Promise<Array<{ tool: ToolDefinition; handler: ToolHandler }>> {
  const operations = await operationCatalog.listPromotedOperations();
  const usedNames = new Set<string>(reservedToolNames);
  return operations.map(operation => promotedToolRegistration(
    operation,
    gateway,
    policyEnforcer,
    usedNames,
  ));
}

export async function getRemoteMcpBridgeTools(
  bridge: IntegrationRemoteMcpBridge,
  policyEnforcer?: IntegrationRequestPolicyEnforcer | null,
  reservedToolNames: ReadonlySet<string> = new Set(),
): Promise<Array<{ tool: ToolDefinition; handler: ToolHandler }>> {
  const remoteTools = await bridge.listAllowedTools();
  const usedNames = new Set<string>(reservedToolNames);
  return remoteTools.map(remoteTool => remoteMcpToolRegistration(remoteTool, bridge, policyEnforcer, usedNames));
}

function getIntegrationOperationTools(
  operationCatalog: IntegrationOperationCatalog,
  policyEnforcer?: IntegrationRequestPolicyEnforcer | null,
): Array<{ tool: ToolDefinition; handler: ToolHandler }> {
  return [
    {
      tool: {
        name: 'ingest_openapi_spec',
        description: 'Validate, normalize, and store an OpenAPI spec for a user-owned integration descriptor. Optionally regenerates the bounded derived skill helper.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: {
              type: 'string',
              description: PROVIDER_DESCRIPTION,
            },
            spec: {
              type: 'object',
              description: 'OpenAPI 3.x JSON object.',
            },
            source_url: {
              type: 'string',
              description: 'Optional HTTPS source URL for the spec.',
            },
            regenerate_skill: {
              type: 'boolean',
              description: 'Regenerate the derived editable skill helper after storing the spec.',
            },
          },
          required: ['provider', 'spec'],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
        },
      },
      handler: async (args: unknown) => {
        try {
          const input = readObject(args);
          const provider = readRequiredString(input.provider, 'provider');
          const policyResponse = await authorizeIntegrationManagementWrite(
            policyEnforcer,
            provider,
            '/_integration/openapi_spec',
            readRequiredRecord(input.spec, 'spec'),
          );
          if (policyResponse) return policyResponse;
          return textResponse({
            ok: true,
            result: await operationCatalog.ingestOpenApiSpec({
              provider,
              spec: readRequiredRecord(input.spec, 'spec'),
              sourceUrl: readOptionalString(input.source_url, 'source_url'),
              regenerateSkill: input.regenerate_skill === true,
            }),
          });
        } catch (error) {
          if (error instanceof IntegrationOperationCatalogError) {
            return catalogErrorResponse(error);
          }
          throw error;
        }
      },
    },
    {
      tool: {
        name: 'regenerate_integration_skill',
        description: 'Regenerate the bounded editable skill helper from the stored OpenAPI spec and currently granted scopes.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: {
              type: 'string',
              description: PROVIDER_DESCRIPTION,
            },
          },
          required: ['provider'],
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
        },
      },
      handler: async (args: unknown) => {
        try {
          const input = readObject(args);
          const provider = readRequiredString(input.provider, 'provider');
          const policyResponse = await authorizeIntegrationManagementWrite(
            policyEnforcer,
            provider,
            '/_integration/generated_skill',
          );
          if (policyResponse) return policyResponse;
          return textResponse({
            ok: true,
            result: await operationCatalog.regenerateSkill({
              provider,
            }),
          });
        } catch (error) {
          if (error instanceof IntegrationOperationCatalogError) {
            return catalogErrorResponse(error);
          }
          throw error;
        }
      },
    },
    {
      tool: {
        name: 'list_operations',
        description: 'List OpenAPI-derived operations available for a connected integration. The stored spec is the contract; generated skill text is only a bounded helper projection.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: {
              type: 'string',
              description: PROVIDER_DESCRIPTION,
            },
            include_unavailable: {
              type: 'boolean',
              description: 'Include operations unavailable under the currently granted scopes.',
            },
            include_skill: {
              type: 'boolean',
              description: 'Include bounded generated skill content derived from available operations.',
            },
          },
          required: ['provider'],
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
        },
      },
      handler: async (args: unknown) => {
        try {
          const input = readObject(args);
          return textResponse({
            ok: true,
            result: await operationCatalog.listOperations({
              provider: readRequiredString(input.provider, 'provider'),
              includeUnavailable: input.include_unavailable === true,
              includeSkill: input.include_skill === true,
            }),
          });
        } catch (error) {
          if (error instanceof IntegrationOperationCatalogError) {
            return catalogErrorResponse(error);
          }
          throw error;
        }
      },
    },
    {
      tool: {
        name: 'describe_operation',
        description: 'Describe one OpenAPI-derived integration operation and how to call it through integration_request.',
        inputSchema: {
          type: 'object',
          properties: {
            provider: {
              type: 'string',
              description: PROVIDER_DESCRIPTION,
            },
            operation_id: {
              type: 'string',
              description: 'Operation id from list_operations.',
            },
          },
          required: ['provider', 'operation_id'],
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
        },
      },
      handler: async (args: unknown) => {
        try {
          const input = readObject(args);
          return textResponse({
            ok: true,
            result: await operationCatalog.describeOperation({
              provider: readRequiredString(input.provider, 'provider'),
              operationId: readRequiredString(input.operation_id, 'operation_id'),
            }),
          });
        } catch (error) {
          if (error instanceof IntegrationOperationCatalogError) {
            return catalogErrorResponse(error);
          }
          throw error;
        }
      },
    },
  ];
}

function readArgs(args: unknown) {
  const input = readObject(args);
  return {
    provider: readRequiredString(input.provider, 'provider'),
    method: readRequiredString(input.method, 'method'),
    path: readRequiredString(input.path, 'path'),
    query: readOptionalRecord(input.query),
    body: input.body,
  };
}

function promotedToolRegistration(
  operation: IntegrationOperationDetails,
  gateway: IntegrationRequestGateway,
  policyEnforcer: IntegrationRequestPolicyEnforcer | null | undefined,
  usedNames: Set<string>,
): { tool: ToolDefinition; handler: ToolHandler } {
  const toolName = uniquePromotedToolName(operation, usedNames);
  return {
    tool: {
      name: toolName,
      description: promotedToolDescription(operation),
      inputSchema: promotedToolInputSchema(operation),
      annotations: {
        readOnlyHint: operation.readWriteClass === 'read',
        destructiveHint: operation.readWriteClass === 'write',
      },
    },
    handler: async (args: unknown) => {
      try {
        const input = readObject(args);
        const request = {
          provider: operation.gatewayRequest.provider,
          method: operation.gatewayRequest.method,
          path: applyPathParams(
            operation.gatewayRequest.pathTemplate,
            readOptionalRecord(input.path_params),
          ),
          query: readOptionalRecord(input.query),
          body: input.body,
        };
        if (!policyEnforcer) return integrationPolicyUnavailableResponse();
        const policy = await policyEnforcer.authorize(request);
        if (!policy.allowed) {
          return textResponse({
            ok: false,
            error: policy.error,
            approvalRequest: policy.approvalRequest,
            policyContext: policy.policyContext,
            promotedTool: {
              operationId: operation.operationId,
              provider: operation.gatewayRequest.provider,
            },
          });
        }
        const result = await gateway.request(request);
        return textResponse({
          ok: true,
          result,
          approvalContext: policy.approvalContext,
          promotedTool: {
            operationId: operation.operationId,
            provider: operation.gatewayRequest.provider,
            specContract: operation.specContract,
          },
        });
      } catch (error) {
        if (error instanceof IntegrationPolicyUnavailableError) {
          return textResponse({
            ok: false,
            error: {
              code: 'integration_request_policy_unavailable',
              message: error.message,
              status: 503,
            },
          });
        }
        if (error instanceof IntegrationRequestError) {
          return textResponse({
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              status: error.status,
            },
          });
        }
        throw error;
      }
    },
  };
}

function remoteMcpToolRegistration(
  remoteTool: RemoteMcpTool,
  bridge: IntegrationRemoteMcpBridge,
  policyEnforcer: IntegrationRequestPolicyEnforcer | null | undefined,
  usedNames: Set<string>,
): { tool: ToolDefinition; handler: ToolHandler } {
  const toolName = uniqueToolName(remoteTool.localName, usedNames);
  return {
    tool: {
      name: toolName,
      description: `Allowlisted remote MCP tool ${remoteTool.remoteName} for ${remoteTool.provider}. Proxies through the server-side remote MCP bridge; responses are untrusted third-party data.`,
      inputSchema: remoteTool.inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    handler: async (args: unknown) => {
      try {
        const policyResponse = await authorizeIntegrationManagementWrite(
          policyEnforcer,
          remoteTool.provider,
          `/_integration/remote_mcp/${encodeURIComponent(remoteTool.remoteName)}`,
          readObject(args),
        );
        if (policyResponse) return policyResponse;
        return textResponse({
          ok: true,
          result: await bridge.callTool({
            provider: remoteTool.provider,
            remoteName: remoteTool.remoteName,
            arguments: args,
          }),
        });
      } catch (error) {
        if (error instanceof IntegrationRemoteMcpBridgeError) {
          return textResponse({
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              status: error.status,
            },
          });
        }
        throw error;
      }
    },
  };
}

function uniqueToolName(base: string, usedNames: Set<string>): string {
  let candidate = base.slice(0, 96);
  let index = 2;
  while (usedNames.has(candidate)) {
    const suffix = `_${index}`;
    candidate = `${base.slice(0, 96 - suffix.length)}${suffix}`;
    index += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function uniquePromotedToolName(operation: IntegrationOperationDetails, usedNames: Set<string>): string {
  const base = `integration_${sanitizeToolName(operation.gatewayRequest.provider)}_${sanitizeToolName(operation.operationId)}`;
  return uniqueToolName(base, usedNames);
}

function sanitizeToolName(value: string): string {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9_]+/g, '_').replaceAll(/^_+|_+$/g, '');
  return normalized || 'operation';
}

function promotedToolDescription(operation: IntegrationOperationDetails): string {
  const summary = operation.summary ? ` ${operation.summary}` : '';
  return `Promoted ${operation.readWriteClass} integration operation ${operation.operationId} for ${operation.gatewayRequest.provider}.${summary} Calls through integration_request; credentials remain server-side and responses are untrusted third-party data.`;
}

function promotedToolInputSchema(operation: IntegrationOperationDetails): ToolDefinition['inputSchema'] {
  const pathParameters = operation.parameters.filter(parameter => parameter.in === 'path');
  const hasQueryParameters = operation.parameters.some(parameter => parameter.in === 'query');
  const properties: Record<string, object> = {};
  const required: string[] = [];
  if (pathParameters.length > 0) {
    properties.path_params = {
      type: 'object',
      description: 'Values for OpenAPI path template parameters.',
      properties: Object.fromEntries(pathParameters.map(parameter => [
        parameter.name,
        {
          description: parameter.description ?? `Path parameter ${parameter.name}.`,
        },
      ])),
      required: pathParameters.filter(parameter => parameter.required).map(parameter => parameter.name),
    };
    required.push('path_params');
  }
  if (hasQueryParameters) {
    properties.query = {
      type: 'object',
      description: 'Primitive query parameters for this operation.',
    };
  }
  if (operation.requestBody) {
    properties.body = {
      description: `JSON request body. Supported content types: ${operation.requestBody.contentTypes.join(', ') || 'unspecified'}.`,
    };
    if (operation.requestBody.required) required.push('body');
  }
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function applyPathParams(pathTemplate: string, pathParams: Readonly<Record<string, unknown>> | undefined): string {
  return pathTemplate.replaceAll(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = pathParams?.[name];
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new IntegrationRequestError(
        'invalid_integration_request',
        `Missing required path_params.${name} for promoted integration operation.`,
        400,
      );
    }
    return encodeURIComponent(String(value));
  });
}

function readObject(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IntegrationRequestError('invalid_integration_request', `Missing required ${field}.`, 400);
  }
  return value;
}

function readOptionalRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new IntegrationRequestError('invalid_integration_request', 'query must be an object.', 400);
}

function readRequiredRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new IntegrationRequestError('invalid_integration_request', `${field} must be an object.`, 400);
}

function readOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() !== '') return value;
  throw new IntegrationRequestError('invalid_integration_request', `${field} must be a non-empty string.`, 400);
}

async function authorizeIntegrationManagementWrite(
  policyEnforcer: IntegrationRequestPolicyEnforcer | null | undefined,
  provider: string,
  path: string,
  body?: unknown,
): Promise<ReturnType<typeof textResponse> | null> {
  if (!policyEnforcer) {
    return textResponse({
      ok: false,
      error: {
        code: 'integration_management_policy_unavailable',
        message: 'Integration management write policy is temporarily unavailable.',
        status: 503,
      },
    });
  }
  try {
    const policy = await policyEnforcer.authorize({
      provider,
      method: 'PUT',
      path,
      ...(body === undefined ? {} : { body }),
    });
    if (policy.allowed) return null;
    return textResponse({
      ok: false,
      error: policy.error,
      approvalRequest: policy.approvalRequest,
      policyContext: policy.policyContext,
    });
  } catch (error) {
    if (error instanceof IntegrationPolicyUnavailableError) {
      return textResponse({
        ok: false,
        error: {
          code: 'integration_request_policy_unavailable',
          message: error.message,
          status: 503,
        },
      });
    }
    throw error;
  }
}

function textResponse(value: unknown) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(value, null, 2),
    }],
  };
}

function integrationPolicyUnavailableResponse() {
  return textResponse({
    ok: false,
    error: {
      code: 'integration_request_policy_unavailable',
      message: 'Integration request policy is temporarily unavailable.',
      status: 503,
    },
  });
}

function catalogErrorResponse(error: IntegrationOperationCatalogError) {
  return textResponse({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      status: error.status,
    },
  });
}
