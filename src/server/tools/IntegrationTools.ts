import type { ToolDefinition, ToolHandler } from '../../handlers/types/ToolTypes.js';
import {
  IntegrationRequestError,
  type IntegrationRequestGateway,
} from '../../web-console/modules/integrations/IntegrationRequestGateway.js';
import type { IntegrationRequestPolicyEnforcer } from '../../web-console/modules/integrations/IntegrationRequestPolicy.js';
import { IntegrationPolicyUnavailableError } from '../../web-console/modules/integrations/IntegrationRequestPolicy.js';

export function getIntegrationTools(
  gateway: IntegrationRequestGateway,
  policyEnforcer?: IntegrationRequestPolicyEnforcer | null,
): Array<{ tool: ToolDefinition; handler: ToolHandler }> {
  return [{
    tool: {
      name: 'integration_request',
      description: 'Call a connected REST integration through the server-side credential gateway. Credentials are injected server-side and never returned.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: {
            type: 'string',
            description: 'Integration provider id.',
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
}

function readArgs(args: unknown) {
  const input = args && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  return {
    provider: readRequiredString(input.provider, 'provider'),
    method: readRequiredString(input.method, 'method'),
    path: readRequiredString(input.path, 'path'),
    query: readOptionalRecord(input.query),
    body: input.body,
  };
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

function textResponse(value: unknown) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(value, null, 2),
    }],
  };
}
