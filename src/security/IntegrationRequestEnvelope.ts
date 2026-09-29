import { isDollhouseMcpServerName } from '../config/mcpServerNames.js';
/** Shared validation for server dispatch, host classification, and approval summaries. */
const REQUEST_KEYS = new Set(['provider', 'method', 'path', 'query', 'body', 'fields']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isIntegrationRequestEnvelope(value: unknown): boolean {
  return isRecord(value) && (value.operation === 'integration_request' || value.tool === 'integration_request');
}

export function hasIntegrationRequestKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every(key => REQUEST_KEYS.has(key));
}

/** Reject ambiguity before legacy normalization can discard fields. */
export function integrationRequestParams(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  let params: unknown;
  let allowedKeys: string[];
  if (value.operation === 'integration_request') {
    allowedKeys = ['operation', 'params'];
    params = value.params;
  } else if (value.tool === 'integration_request') {
    const key = Object.hasOwn(value, 'args') ? 'args' : 'params';
    allowedKeys = ['tool', key];
    params = value[key];
  } else return null;
  if (Object.keys(value).some(key => !allowedKeys.includes(key))) return null;
  if (!isRecord(params) || !hasIntegrationRequestKeys(params)) return null;
  if (['provider', 'method', 'path'].some(key => typeof params[key] !== 'string' || params[key].trim() === '')) return null;
  return params;
}

export function normalizeMcpToolName(name: string): string {
  if (!name.startsWith('mcp__')) return name;
  const separator = name.lastIndexOf('__');
  if (separator <= 3 || !isDollhouseMcpServerName(name.slice(5, separator))) return name;
  return name.slice(separator + 2);
}
