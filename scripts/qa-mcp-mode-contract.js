/**
 * Shared black-box QA contract for every supported MCP tool interface.
 *
 * The discrete list deliberately pins the 42 core tools. Additional dynamic
 * integration tools are allowed, but a missing core tool or a tool from the
 * wrong interface mode is a hard failure.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DISCRETE_CORE_TOOLS = Object.freeze([
  'import_persona',
  'list_elements',
  'activate_element',
  'get_active_elements',
  'deactivate_element',
  'get_element_details',
  'reload_elements',
  'render_template',
  'execute_agent',
  'create_element',
  'edit_element',
  'validate_element',
  'delete_element',
  'record_agent_step',
  'complete_agent_goal',
  'get_agent_state',
  'continue_agent_execution',
  'browse_collection',
  'search_collection',
  'search_collection_enhanced',
  'get_collection_content',
  'install_collection_content',
  'submit_collection_content',
  'get_collection_cache_health',
  'portfolio_status',
  'init_portfolio',
  'portfolio_config',
  'sync_portfolio',
  'search_portfolio',
  'search_all',
  'setup_github_auth',
  'check_github_auth',
  'clear_github_auth',
  'configure_oauth',
  'oauth_helper_status',
  'dollhouse_config',
  'portfolio_element_manager',
  'find_similar_elements',
  'get_element_relationships',
  'search_by_verb',
  'get_relationship_stats',
  'get_build_info',
]);

export const MCP_AQL_CRUDE_TOOLS = Object.freeze([
  'mcp_aql_create',
  'mcp_aql_read',
  'mcp_aql_update',
  'mcp_aql_delete',
  'mcp_aql_execute',
]);

const ALL_MCP_AQL_TOOLS = Object.freeze([...MCP_AQL_CRUDE_TOOLS, 'mcp_aql']);

export const QA_MODE_CONTRACTS = Object.freeze([
  Object.freeze({
    id: 'discrete',
    label: 'Discrete tools (42 core tools)',
    environment: Object.freeze({
      MCP_INTERFACE_MODE: 'discrete',
      MCP_AQL_ENDPOINT_MODE: 'crude',
    }),
    requiredTools: DISCRETE_CORE_TOOLS,
    forbiddenTools: ALL_MCP_AQL_TOOLS,
    calls: Object.freeze([
      Object.freeze({
        label: 'list local personas',
        tool: 'list_elements',
        arguments: Object.freeze({ type: 'personas' }),
      }),
      Object.freeze({
        label: 'read build information',
        tool: 'get_build_info',
        arguments: Object.freeze({}),
      }),
    ]),
  }),
  Object.freeze({
    id: 'mcpaql-crude',
    label: 'MCP-AQL CRUDE endpoints',
    environment: Object.freeze({
      MCP_INTERFACE_MODE: 'mcpaql',
      MCP_AQL_ENDPOINT_MODE: 'crude',
    }),
    requiredTools: MCP_AQL_CRUDE_TOOLS,
    forbiddenTools: Object.freeze([...DISCRETE_CORE_TOOLS, 'mcp_aql']),
    calls: Object.freeze([
      Object.freeze({
        label: 'read build information',
        tool: 'mcp_aql_read',
        arguments: Object.freeze({ operation: 'get_build_info' }),
      }),
      Object.freeze({
        label: 'introspect operations',
        tool: 'mcp_aql_read',
        arguments: Object.freeze({ operation: 'introspect' }),
      }),
    ]),
  }),
  Object.freeze({
    id: 'mcpaql-single',
    label: 'MCP-AQL unified endpoint',
    environment: Object.freeze({
      MCP_INTERFACE_MODE: 'mcpaql',
      MCP_AQL_ENDPOINT_MODE: 'single',
    }),
    requiredTools: Object.freeze(['mcp_aql']),
    forbiddenTools: Object.freeze([...DISCRETE_CORE_TOOLS, ...MCP_AQL_CRUDE_TOOLS]),
    calls: Object.freeze([
      Object.freeze({
        label: 'read build information',
        tool: 'mcp_aql',
        arguments: Object.freeze({ operation: 'get_build_info' }),
      }),
      Object.freeze({
        label: 'introspect operations',
        tool: 'mcp_aql',
        arguments: Object.freeze({ operation: 'introspect' }),
      }),
    ]),
  }),
]);

const PORTFOLIO_ELEMENT_DIRECTORIES = Object.freeze([
  'personas',
  'skills',
  'templates',
  'agents',
  'memories',
  'ensembles',
]);

const SENSITIVE_ENVIRONMENT_OVERRIDES = Object.freeze({
  GITHUB_TOKEN: '',
  GITHUB_TEST_TOKEN: '',
  TEST_GITHUB_TOKEN: '',
  GH_TOKEN: '',
  DOLLHOUSE_DATABASE_URL: '',
  DOLLHOUSE_DATABASE_ADMIN_URL: '',
  DOLLHOUSE_MASTER_ENCRYPTION_KEY: '',
  DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY: '',
  DOLLHOUSE_WEB_CONSOLE_PROTECTED_CORRELATION_HMAC_KEY: '',
});

/**
 * Build a string-only child-process environment with QA safety overrides.
 */
export function buildQaChildEnvironment(modeEnvironment, directoryEnvironment) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry) => entry[1] !== undefined),
  );

  return {
    ...inherited,
    ...SENSITIVE_ENVIRONMENT_OVERRIDES,
    NODE_ENV: 'test',
    TEST_MODE: 'true',
    DOLLHOUSE_TRANSPORT: 'stdio',
    DOLLHOUSE_STORAGE_BACKEND: 'file',
    DOLLHOUSE_AUTH_STORAGE_BACKEND: 'filesystem',
    DOLLHOUSE_ACTIVATION_PERSISTENCE: 'false',
    DOLLHOUSE_SHARED_POOL_ENABLED: 'false',
    DOLLHOUSE_WEB_CONSOLE: 'false',
    DOLLHOUSE_HTTP_WEB_CONSOLE: 'false',
    DOLLHOUSE_PERMISSION_SERVER: 'false',
    ...directoryEnvironment,
    ...modeEnvironment,
  };
}

/**
 * Create a disposable filesystem layout so QA never reads or writes a user's
 * real DollhouseMCP portfolio, credentials, cache, state, or logs.
 */
export async function createIsolatedQaEnvironment(contract, runnerName) {
  const root = await mkdtemp(path.join(os.tmpdir(), `dollhouse-${runnerName}-${contract.id}-`));
  const directories = {
    home: path.join(root, 'home'),
    portfolio: path.join(root, 'portfolio'),
    cache: path.join(root, 'cache'),
    state: path.join(root, 'state'),
    run: path.join(root, 'run'),
    logs: path.join(root, 'logs'),
    shared: path.join(root, 'shared'),
    provenance: path.join(root, 'provenance'),
  };

  await Promise.all([
    ...Object.values(directories).map((directory) => mkdir(directory, { recursive: true })),
    ...PORTFOLIO_ELEMENT_DIRECTORIES.map((directory) =>
      mkdir(path.join(directories.portfolio, directory), { recursive: true })),
  ]);

  const directoryEnvironment = {
    DOLLHOUSE_HOME_DIR: directories.home,
    DOLLHOUSE_PORTFOLIO_DIR: directories.portfolio,
    DOLLHOUSE_CACHE_DIR: directories.cache,
    DOLLHOUSE_STATE_DIR: directories.state,
    DOLLHOUSE_RUN_DIR: directories.run,
    DOLLHOUSE_LOG_DIR: directories.logs,
    DOLLHOUSE_SHARED_POOL_DIR: directories.shared,
    DOLLHOUSE_SHARED_PROVENANCE_DIR: directories.provenance,
    DOLLHOUSE_SESSION_ID: `qa-${runnerName}-${contract.id}`,
  };

  return {
    root,
    environment: buildQaChildEnvironment(contract.environment, directoryEnvironment),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Validate the advertised tool surface without making the total-count check
 * brittle when optional integration tools are added.
 */
export function validateToolSurface(contract, tools) {
  if (!Array.isArray(tools)) {
    return { success: false, names: [], errors: ['tools/list did not return a tools array'] };
  }

  const names = tools.map((tool) => tool?.name).filter((name) => typeof name === 'string');
  const nameSet = new Set(names);
  const errors = [];
  const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
  const missingTools = contract.requiredTools.filter((name) => !nameSet.has(name));
  const forbiddenTools = contract.forbiddenTools.filter((name) => nameSet.has(name));
  const malformedTools = tools.filter((tool) =>
    typeof tool?.name !== 'string' || tool?.inputSchema?.type !== 'object');

  if (duplicateNames.length > 0) {
    errors.push(`duplicate tool names: ${[...new Set(duplicateNames)].join(', ')}`);
  }
  if (missingTools.length > 0) {
    errors.push(`missing required tools: ${missingTools.join(', ')}`);
  }
  if (forbiddenTools.length > 0) {
    errors.push(`tools from the wrong interface mode are present: ${forbiddenTools.join(', ')}`);
  }
  if (malformedTools.length > 0) {
    errors.push(`${malformedTools.length} tool definition(s) lack a name or object input schema`);
  }

  return { success: errors.length === 0, names, errors };
}

function parseJsonTextContent(result) {
  const textContent = result.content?.find((entry) =>
    entry?.type === 'text' && typeof entry.text === 'string');
  if (!textContent) return null;
  try {
    return JSON.parse(textContent.text);
  } catch {
    return null;
  }
}

/**
 * Treat transport-level errors and MCP-AQL operation failures as failures.
 */
export function validateToolCallResult(result) {
  if (!result || typeof result !== 'object') {
    return { success: false, error: 'tools/call returned no result object' };
  }
  if (result.isError === true) {
    return { success: false, error: 'tools/call returned isError=true' };
  }
  if (!Array.isArray(result.content) || result.content.length === 0) {
    return { success: false, error: 'tools/call returned no content' };
  }

  const parsed = parseJsonTextContent(result);
  if (parsed?.success === false) {
    return { success: false, error: parsed.error || 'operation returned success=false' };
  }
  if (parsed?.ok === false) {
    return { success: false, error: parsed.error?.message || parsed.error || 'operation returned ok=false' };
  }
  if (parsed?.data?.isError === true) {
    return { success: false, error: parsed.data.error || 'operation data returned isError=true' };
  }

  return { success: true, error: null };
}

export async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function timestampForFilename(date = new Date()) {
  return date.toISOString().replaceAll(/[:.]/g, '-');
}
