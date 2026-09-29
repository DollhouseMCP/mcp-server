import { env } from '../../config/env.js';
import { describeIntegrationInvocation, describeIntegrationSkillStatus, integrationDescribeToolDescription, integrationCallGuidance, formatIntegrationGuidance } from './IntegrationInvocation.js';
import { hasIntegrationRequestKeys } from '../../security/IntegrationRequestEnvelope.js';
import type { OperationRegistry } from '../../handlers/mcp-aql/OperationRegistry.js';
import { INTEGRATION_MANAGEMENT_OPERATIONS, type IntegrationManagementOperation } from '../../handlers/mcp-aql/IntegrationManagementOperations.js';
import type { ToolDefinition, ToolHandler } from '../../handlers/types/ToolTypes.js';
import { IntegrationRequestError } from '../../web-console/modules/integrations/IntegrationRequestGateway.js';
import {
  IntegrationOperationCatalogError,
  type IntegrationOperationDetails,
} from '../../web-console/modules/integrations/IntegrationOperationCatalog.js';
import {
  IntegrationRemoteMcpBridgeError,
  type RemoteMcpTool,
} from '../../web-console/modules/integrations/IntegrationRemoteMcpBridge.js';
import { normalizeIntegrationToolName } from '../../web-console/modules/integrations/IntegrationToolName.js';
import type {
  AuthorizedIntegrationGateway,
  AuthorizedIntegrationOperationCatalog,
  AuthorizedIntegrationRemoteMcpBridge,
  IntegrationPolicyDenial,
} from '../../web-console/modules/integrations/AuthorizedIntegrationGateway.js';

const PROVIDER_DESCRIPTION = 'Integration provider id.';
const MAX_REMOTE_SCHEMA_DEPTH = 12;
const MAX_REMOTE_SCHEMA_NODES = 1_024;
const MAX_REMOTE_SCHEMA_KEYS = 128;
const MAX_REMOTE_SCHEMA_STRING_LENGTH = 2_048;
const MAX_REMOTE_SCHEMA_BYTES = 64 * 1_024;
const REMOTE_SCHEMA_ANNOTATION_KEYS = new Set([
  '$comment',
  'default',
  'description',
  'example',
  'examples',
  'title',
]);

export function getIntegrationTools(
  gateway: AuthorizedIntegrationGateway,
  operationCatalog?: AuthorizedIntegrationOperationCatalog | null,
  includeCatalogTools = true,
): Array<{ tool: ToolDefinition; handler: ToolHandler }> {
  const tools: Array<{ tool: ToolDefinition; handler: ToolHandler }> = [{
    tool: {
      name: 'integration_request',
      description: `Call a connected REST integration through ${integrationCallGuidance('integration_request')}${env.MCP_INTERFACE_MODE === 'discrete' ? '' : ' with operation and nested params'}. Writes require exact-input approval by default. Credentials are injected server-side and never returned.`,
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
    handler: async (args: unknown, context) => {
      try {
        const request = readArgs(args);
        const outcome = await gateway.request(request, context);
        if (!outcome.ok) return policyDenialResponse(outcome);
        return textResponse({
          ok: true,
          result: outcome.result,
          approvalContext: outcome.approvalContext,
        });
      } catch (error) {
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
    if (includeCatalogTools) tools.push(...getIntegrationOperationTools(operationCatalog), ...getIntegrationReadTools(operationCatalog));
  }
  return tools;
}

/** Internal operation registrations, never standalone tools. */
export function getIntegrationManagementTools(catalog: AuthorizedIntegrationOperationCatalog, operations: OperationRegistry): Array<{ tool: ToolDefinition; handler: ToolHandler }> {
  return (Object.keys(INTEGRATION_MANAGEMENT_OPERATIONS) as IntegrationManagementOperation[]).map(name => {
    const definition = INTEGRATION_MANAGEMENT_OPERATIONS[name];
    const spec = definition.resource === 'openapi_spec';
    const update = definition.action === 'update';
    const specMethod = update ? 'updateSpec' : 'createSpec';
    const skillMethod = update ? 'updateSkill' : 'createSkill';
    const properties: Record<string, object> = { provider: { type: 'string', description: PROVIDER_DESCRIPTION } };
    if (spec) {
      properties.spec = { type: 'object', description: 'OpenAPI 3.x JSON object. Spec writes never persist a skill.' };
      properties.source_url = { type: 'string', description: 'Optional HTTPS source URL.' };
      if (update) properties.expected_spec_hash = { type: 'string', description: formatIntegrationGuidance('Optional current specHash from list_integration_operations; mismatches fail without writes.') };
    } else {
      properties.skill_name = { type: 'string', description: 'Exact target skill name; defaults to the generated name. For a new revision use create_integration_skill with a different name.' };
      if (update) properties.expected_content_hash = { type: 'string', description: 'Optional content_hash from a successful skill write or current_content_hash from a conflict response; mismatches fail without writes.' };
    }
    return {
      tool: { name, description: `${update ? 'Update an existing' : 'Create a missing'} integration ${spec ? 'specification' : 'generated skill'} using ${integrationCallGuidance(name)}. Requires provider${spec ? ' and spec' : '; optional skill_name'}. ${update ? 'Never creates a missing resource or revision; preserves edited skills.' : 'Fails on collision; never overwrites or chooses another name.'} Call individually; batches are rejected.`,
        inputSchema: { type: 'object', properties, required: spec ? ['provider', 'spec'] : ['provider'] },
        annotations: { readOnlyHint: false, destructiveHint: update } },
      handler: async (args: unknown) => {
        try {
          const input = readObject(args);
          validateManagementInput(input, name, properties);
          const provider = readRequiredString(input.provider, 'provider');
          const outcome = spec
            ? await catalog[specMethod]({ provider,
              spec: readRequiredRecord(input.spec, 'spec'), sourceUrl: readOptionalString(input.source_url, 'source_url'),
              ...(input.expected_spec_hash === undefined ? {} : { expectedSpecHash: input.expected_spec_hash as string }),
            }, operations)
            : await catalog[skillMethod]({ provider,
              skillName: readOptionalString(input.skill_name, 'skill_name') ?? undefined,
              ...(input.expected_content_hash === undefined ? {} : { expectedContentHash: input.expected_content_hash as string }),
            }, operations);
          if (!outcome.ok) return policyDenialResponse(outcome, integrationCallGuidance(name));
          return textResponse({ ok: true, result: outcome.result, approvalContext: outcome.approvalContext });
        } catch (error) {
          if (error instanceof IntegrationOperationCatalogError) return catalogErrorResponse(error);
          throw error;
        }
      },
    };
  });
}

function validateManagementInput(input: Record<string, unknown>, operation: IntegrationManagementOperation, properties: Record<string, unknown>): void {
  const definition = INTEGRATION_MANAGEMENT_OPERATIONS[operation];
  if (Object.hasOwn(input, 'regenerate_skill')) {
    throw new IntegrationOperationCatalogError('integration_separate_skill_write_required',
      `Spec and skill writes are separate. Use mcp_aql_${definition.action} / ${definition.action}_integration_skill with provider and optional skill_name.`, 400);
  }
  const unknown = Object.keys(input).find(key => key !== 'fields' && !Object.hasOwn(properties, key));
  if (unknown) throw new IntegrationOperationCatalogError('integration_management_invalid_input',
    `Unsupported parameter ${unknown}. Use mcp_aql_${definition.action} / ${operation} with ${Object.keys(properties).join(', ')}; no upsert, overwrite or force behavior is supported.`, 400);
  if (input.expected_spec_hash !== undefined && (typeof input.expected_spec_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expected_spec_hash))) {
    throw new IntegrationOperationCatalogError('integration_spec_invalid_hash', 'Use mcp_aql_update / update_integration_spec with provider, spec and expected_spec_hash from mcp_aql_read / list_integration_operations.', 400);
  }
  if (input.expected_content_hash !== undefined && (typeof input.expected_content_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expected_content_hash))) {
    throw new IntegrationOperationCatalogError('integration_skill_invalid_hash', 'Use mcp_aql_update / update_integration_skill with provider, skill_name and a lowercase SHA-256 expected_content_hash from content_hash in a successful skill write or current_content_hash in a conflict response.', 400);
  }
}

export async function getPromotedIntegrationTools(
  gateway: AuthorizedIntegrationGateway,
  operationCatalog: AuthorizedIntegrationOperationCatalog,
  reservedToolNames: ReadonlySet<string> = new Set(),
  invalidateTool: (toolName: string) => void = () => {},
): Promise<Array<{ tool: ToolDefinition; handler: ToolHandler }>> {
  const operations = await operationCatalog.listPromotedOperations();
  const usedNames = new Set<string>(reservedToolNames);
  return operations.map(operation => promotedToolRegistration(
    operation,
    gateway,
    operationCatalog,
    usedNames,
    invalidateTool,
  ));
}

export async function getRemoteMcpBridgeTools(
  bridge: AuthorizedIntegrationRemoteMcpBridge,
  reservedToolNames: ReadonlySet<string> = new Set(),
): Promise<Array<{ tool: ToolDefinition; handler: ToolHandler }>> {
  const remoteTools = await bridge.listAllowedTools();
  const usedNames = new Set<string>(reservedToolNames);
  return remoteTools.map(remoteTool => remoteMcpToolRegistration(remoteTool, bridge, usedNames));
}

function getIntegrationOperationTools(
  operationCatalog: AuthorizedIntegrationOperationCatalog,
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
          const outcome = await operationCatalog.ingestOpenApiSpec({
            provider: readRequiredString(input.provider, 'provider'),
            spec: readRequiredRecord(input.spec, 'spec'),
            sourceUrl: readOptionalString(input.source_url, 'source_url'),
            regenerateSkill: input.regenerate_skill === true,
          });
          if (!outcome.ok) return policyDenialResponse(outcome, 'ingest_openapi_spec');
          return textResponse({
            ok: true,
            result: outcome.result,
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
          const outcome = await operationCatalog.regenerateSkill({
            provider: readRequiredString(input.provider, 'provider'),
          });
          if (!outcome.ok) return policyDenialResponse(outcome, 'regenerate_integration_skill');
          return textResponse({
            ok: true,
            result: outcome.result,
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

/** Shared READ adapters for discrete tools and configured MCP-AQL operations. */
export function getIntegrationReadTools(
  operationCatalog: AuthorizedIntegrationOperationCatalog,
): Array<{ tool: ToolDefinition; handler: ToolHandler }> {
  return [
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
            result: describeIntegrationSkillStatus(await operationCatalog.listOperations({
              provider: readRequiredString(input.provider, 'provider'),
              includeUnavailable: input.include_unavailable === true,
              includeSkill: input.include_skill === true,
            })),
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
        description: integrationDescribeToolDescription(),
        inputSchema: {
          type: 'object',
          properties: {
            provider: {
              type: 'string',
              description: PROVIDER_DESCRIPTION,
            },
            operation_id: {
              type: 'string',
              description: `Operation id from ${integrationCallGuidance('list_integration_operations')}.`,
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
            result: describeIntegrationInvocation(await operationCatalog.describeOperation({
              provider: readRequiredString(input.provider, 'provider'),
              operationId: readRequiredString(input.operation_id, 'operation_id'),
            })),
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
  if (!hasIntegrationRequestKeys(input)) throw new IntegrationRequestError('integration_request_invalid', 'Unknown integration request parameter.', 400);
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
  gateway: AuthorizedIntegrationGateway,
  operationCatalog: AuthorizedIntegrationOperationCatalog,
  usedNames: Set<string>,
  invalidateTool: (toolName: string) => void,
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
        const current = (await operationCatalog.listPromotedOperations({
          provider: operation.gatewayRequest.provider,
        })).find(candidate => candidate.operationId === operation.operationId);
        if (current?.specContract.descriptorId !== operation.specContract.descriptorId
            || current.specContract.specHash !== operation.specContract.specHash
            || current.gatewayRequest.method !== operation.gatewayRequest.method
            || current.gatewayRequest.pathTemplate !== operation.gatewayRequest.pathTemplate) {
          // Remove the stale per-session registration and emit ToolRegistry's
          // normal list-changed notification. The attempted call fails closed;
          // it never rebinds an old tool name to a mutated descriptor/spec.
          invalidateTool(toolName);
          return textResponse({
            ok: false,
            error: {
              code: 'integration_promoted_tool_stale',
              message: 'This promoted integration tool changed; refresh the tool list before retrying.',
              status: 409,
            },
          });
        }
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
        const outcome = await gateway.request(request, { entry_point: 'promoted_tool' });
        if (!outcome.ok) {
          return textResponse({
            ok: false,
            error: approvalRetryError(outcome, toolName),
            approvalRequest: outcome.approvalRequest,
            policyContext: outcome.policyContext,
            promotedTool: {
              operationId: operation.operationId,
              provider: operation.gatewayRequest.provider,
            },
          });
        }
        return textResponse({
          ok: true,
          result: outcome.result,
          approvalContext: outcome.approvalContext,
          promotedTool: {
            operationId: operation.operationId,
            provider: operation.gatewayRequest.provider,
            specContract: operation.specContract,
          },
        });
      } catch (error) {
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
  bridge: AuthorizedIntegrationRemoteMcpBridge,
  usedNames: Set<string>,
): { tool: ToolDefinition; handler: ToolHandler } {
  const toolName = uniqueToolName(remoteTool.localName, usedNames);
  const inputSchema = sanitizeRemoteInputSchema(remoteTool.inputSchema);
  return {
    tool: {
      name: toolName,
      description: `Allowlisted remote MCP tool ${remoteTool.remoteName} for ${remoteTool.provider}. Proxies through the server-side remote MCP bridge; responses are untrusted third-party data.`,
      inputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    handler: async (args: unknown) => {
      try {
        const outcome = await bridge.callTool({
          provider: remoteTool.provider,
          remoteName: remoteTool.remoteName,
          arguments: args,
        });
        if (!outcome.ok) return policyDenialResponse(outcome, toolName);
        return textResponse({
          ok: true,
          result: outcome.result,
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

function sanitizeRemoteInputSchema(value: unknown): ToolDefinition['inputSchema'] {
  const budget = { nodes: 0 };
  const sanitized = sanitizeRemoteSchemaValue(value, 0, budget);
  if (!isPlainRecord(sanitized) || sanitized.type !== 'object') {
    return { type: 'object', properties: {} };
  }
  if (Buffer.byteLength(JSON.stringify(sanitized), 'utf8') > MAX_REMOTE_SCHEMA_BYTES) {
    return { type: 'object', properties: {} };
  }
  return sanitized as ToolDefinition['inputSchema'];
}

function sanitizeRemoteSchemaValue(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): unknown {
  budget.nodes += 1;
  if (depth > MAX_REMOTE_SCHEMA_DEPTH || budget.nodes > MAX_REMOTE_SCHEMA_NODES) return undefined;
  if (typeof value === 'string') return boundedRemoteSchemaString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return sanitizeRemoteSchemaArray(value, depth, budget);
  if (!isPlainRecord(value)) return undefined;
  return sanitizeRemoteSchemaRecord(value, depth, budget);
}

function boundedRemoteSchemaString(value: string): string | undefined {
  return value.length <= MAX_REMOTE_SCHEMA_STRING_LENGTH ? value : undefined;
}

function sanitizeRemoteSchemaArray(
  value: readonly unknown[],
  depth: number,
  budget: { nodes: number },
): unknown[] | undefined {
  if (value.length > MAX_REMOTE_SCHEMA_KEYS) return undefined;
  const output: unknown[] = [];
  for (const entry of value) {
    const sanitized = sanitizeRemoteSchemaValue(entry, depth + 1, budget);
    if (sanitized === undefined) return undefined;
    output.push(sanitized);
  }
  return output;
}

function sanitizeRemoteSchemaRecord(
  value: Readonly<Record<string, unknown>>,
  depth: number,
  budget: { nodes: number },
): Record<string, unknown> | undefined {
  const entries = Object.entries(value);
  if (entries.length > MAX_REMOTE_SCHEMA_KEYS) return undefined;
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of entries) {
    if (REMOTE_SCHEMA_ANNOTATION_KEYS.has(key)) continue;
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
    if (key.length > MAX_REMOTE_SCHEMA_STRING_LENGTH) return undefined;
    const sanitized = sanitizeRemoteSchemaValue(entry, depth + 1, budget);
    if (sanitized === undefined) return undefined;
    output[key] = sanitized;
  }
  return output;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  return normalizeIntegrationToolName(value, 'operation');
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
  let output = '';
  let cursor = 0;
  while (cursor < pathTemplate.length) {
    const open = pathTemplate.indexOf('{', cursor);
    if (open === -1) {
      output += pathTemplate.slice(cursor);
      break;
    }
    const close = pathTemplate.indexOf('}', open + 1);
    if (close === -1) {
      output += pathTemplate.slice(cursor);
      break;
    }
    output += pathTemplate.slice(cursor, open);
    const name = pathTemplate.slice(open + 1, close);
    if (name === '') {
      output += '{}';
      cursor = close + 1;
      continue;
    }
    const value = pathParams?.[name];
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new IntegrationRequestError(
        'invalid_integration_request',
        `Missing required path_params.${name} for promoted integration operation.`,
        400,
      );
    }
    output += encodeURIComponent(String(value));
    cursor = close + 1;
  }
  return output;
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
  return value.trim();
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

function approvalRetryError(denial: IntegrationPolicyDenial, retryCall: string) {
  if (!denial.approvalRequest) return denial.error;
  const nesting = retryCall.startsWith('mcp_aql') ? ' nested in params' : '';
  return { ...denial.error,
    message: `${denial.error.message} After approval, retry ${retryCall} with the same arguments${nesting}.`,
  };
}

function policyDenialResponse(denial: IntegrationPolicyDenial, retryCall = integrationCallGuidance('integration_request')) {
  return textResponse({
    ok: false,
    error: approvalRetryError(denial, retryCall),
    approvalRequest: denial.approvalRequest,
    policyContext: denial.policyContext,
  });
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
      message: formatIntegrationGuidance(error.message),
      status: error.status,
    },
  });
}
