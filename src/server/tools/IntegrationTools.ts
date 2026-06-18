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
} from '../../web-console/modules/integrations/IntegrationOperationCatalog.js';

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
        const policy = policyEnforcer ? await policyEnforcer.authorize(request) : { allowed: true };
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
