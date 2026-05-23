import { logger } from '../../utils/logger.js';

/**
 * Validate and extract a required string parameter from params.
 * Throws a user-friendly error if the parameter is missing or not a string.
 */
export function validateRequiredString(
  params: Record<string, unknown>,
  paramName: string,
  description: string
): string {
  const value = params[paramName];
  if (value === undefined || value === null || typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Missing required parameter '${paramName}'. Expected: string (${description})`
    );
  }
  return value;
}

export const EXECUTION_OPERATION_NAMES: Record<string, string> = {
  execute: 'execute_agent',
  getState: 'get_execution_state',
  updateState: 'record_execution_step',
  complete: 'complete_execution',
  continue: 'continue_execution',
  abort: 'abort_execution',
  getGatheredData: 'get_gathered_data',
  prepareHandoff: 'prepare_handoff',
  resumeFromHandoff: 'resume_from_handoff',
};

export function validateExecutionElementName(
  method: string,
  params: Record<string, unknown>
): string {
  const value = params.element_name;
  if (value !== undefined && value !== null && typeof value === 'string' && value.trim() !== '') {
    return value;
  }

  const operationName = EXECUTION_OPERATION_NAMES[method] || 'execution lifecycle operation';

  if (method === 'getState') {
    throw new Error(
      `Missing required parameter 'element_name'. Expected: string ` +
      `(the name of the agent/executable element whose execution state you want to inspect). ` +
      `Use the same element_name you passed to execute_agent. ` +
      `Retry with: { operation: "get_execution_state", params: { element_name: "code-reviewer", includeDecisionHistory: true } }. ` +
      `If you're unsure which name to use, call introspect for "get_execution_state" or list active agents first.`
    );
  }

  throw new Error(
    `Missing required parameter 'element_name'. Expected: string ` +
    `(the name of the agent/executable element for ${operationName}). ` +
    `If this is part of an existing execution lifecycle, reuse the same element_name you passed to execute_agent. ` +
    `If you're unsure which name to use, call introspect for "${operationName}" or list active agents first.`
  );
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined;
}

/**
 * Normalize flat pagination params into a { page, pageSize } object.
 *
 * Priority: nested pagination > limit/offset > flat page/pageSize > defaults.
 */
export function normalizePaginationParams(
  params: {
    pagination?: { page?: number; pageSize?: number };
    page?: number;
    pageSize?: number;
    limit?: number;
    offset?: number;
    [key: string]: unknown;
  }
): { page: number; pageSize: number } {
  const nested = params.pagination;
  if (nested && typeof nested === 'object') {
    return {
      page: positiveNumber(nested.page) ?? 1,
      pageSize: positiveNumber(nested.pageSize) ?? 20,
    };
  }

  const limit = positiveNumber(params.limit);
  const offset = typeof params.offset === 'number' && params.offset >= 0 ? params.offset : undefined;
  const limitPage = limit && offset !== undefined ? Math.floor(offset / limit) + 1 : 1;

  return {
    page: positiveNumber(params.page) ?? limitPage,
    pageSize: positiveNumber(params.pageSize) ?? limit ?? 20,
  };
}

export function warnIgnoredNonStringFields(fieldsParam: unknown[]): string[] {
  const stringFields = fieldsParam.filter((field): field is string => typeof field === 'string');
  const nonStringCount = fieldsParam.length - stringFields.length;
  if (nonStringCount > 0) {
    logger.warn(
      `Field selection: ${nonStringCount} non-string element(s) in fields array ignored`
    );
  }
  return stringFields;
}

export interface ExportPackage {
  exportVersion: string;
  exportedAt: string;
  elementType: string;
  elementName?: string;
  format: 'json' | 'yaml';
  data: string;
}

export interface RecentGatekeeperBlock {
  operation: string;
  elementType?: string;
  reason: string;
  level: string;
  timestamp: string;
  reported: boolean;
}

export interface ExecutingAgentEntry {
  name: string;
  metadata: Record<string, unknown>;
  startedAt: number;
  continuationCount: number;
  retryCount: number;
  originalParameters?: Record<string, unknown>;
  resiliencePolicy?: import('../../elements/agents/types.js').AgentResiliencePolicy;
  recentBlocks: RecentGatekeeperBlock[];
}
