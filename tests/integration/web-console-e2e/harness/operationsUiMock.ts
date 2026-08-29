import type { Page, Route } from '@playwright/test';

import { mutationProtocolProblem, preconditionProblem } from './requestProtocolMock.js';

export const OPERATIONAL_SESSION_ID = '77777777-7777-4777-8777-777777777777';
export const SECOND_OPERATIONAL_SESSION_ID = '66666666-6666-4666-8666-666666666666';
export const OPERATIONS_PRIVATE_MARKER = 'private-prompt-must-not-render';

const COMMAND_ID = '88888888-8888-4888-8888-888888888888';
const SECOND_COMMAND_ID = '55555555-5555-4555-8555-555555555555';
const CONFIG_KEY = 'enhanced_index.enabled';
const SIBLING_CONFIG_KEY = 'enhanced_index.max_cache_entries';
const REPLICA_ID = 'replica-browser';

interface MockResponse {
  readonly status: number;
  readonly body: unknown;
  readonly etag?: string;
}

interface ConfigState {
  enabled: { value: boolean; version: number };
  maxCacheEntries: { value: number; version: number };
}

type CommandOutcome = 'terminated' | 'already_absent' | 'failed';

interface OperationsUiMockOptions {
  readonly configListDelayMs?: number;
  readonly conflictOnFirstConfigWrite?: boolean;
  readonly commandOutcome?: CommandOutcome;
  readonly detailUnavailable?: boolean;
  readonly includeSecondSession?: boolean;
}

interface RuntimeState {
  readonly options: Required<OperationsUiMockOptions>;
  readonly commandReads: Map<string, number>;
  readonly terminatedSessionIds: Set<string>;
}

export interface OperationsUiMockState {
  configReads: number;
  configPutAttempts: number;
  configWrites: number;
  commandReads: number;
  terminated: boolean;
  configValue: boolean;
  maxCacheEntries: number;
  healthReads: number;
  logReads: number;
  metricsReads: number;
  systemMetricsReads: number;
  sessionReads: number;
  detailReads: number;
  failNextLogRead: boolean;
  failNextMetricsRead: boolean;
  failNextSessionRead: boolean;
}

export async function installOperationsUiMock(
  page: Page,
  options: OperationsUiMockOptions = {},
): Promise<OperationsUiMockState> {
  const state: OperationsUiMockState = {
    configReads: 0,
    configPutAttempts: 0,
    configWrites: 0,
    commandReads: 0,
    terminated: false,
    configValue: true,
    maxCacheEntries: 1000,
    healthReads: 0,
    logReads: 0,
    metricsReads: 0,
    systemMetricsReads: 0,
    sessionReads: 0,
    detailReads: 0,
    failNextLogRead: false,
    failNextMetricsRead: false,
    failNextSessionRead: false,
  };
  const config: ConfigState = {
    enabled: { value: true, version: 1 },
    maxCacheEntries: { value: 1000, version: 1 },
  };
  const runtime: RuntimeState = {
    options: {
      configListDelayMs: options.configListDelayMs ?? 0,
      conflictOnFirstConfigWrite: options.conflictOnFirstConfigWrite ?? true,
      commandOutcome: options.commandOutcome ?? 'terminated',
      detailUnavailable: options.detailUnavailable ?? false,
      includeSecondSession: options.includeSecondSession ?? false,
    },
    commandReads: new Map(),
    terminatedSessionIds: new Set(),
  };

  await page.route('**/api/v1/admin/operate/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const response = responseFor(request.method(), path, request.postDataJSON(), request.headers(), state, config, runtime);
    const delayedConfigRead = request.method() === 'GET'
      && path === '/api/v1/admin/operate/config'
      && state.configReads === 1
      && runtime.options.configListDelayMs > 0;
    if (delayedConfigRead) await delay(runtime.options.configListDelayMs);
    try {
      await fulfill(route, response);
    } catch (error) {
      if (!delayedConfigRead) throw error;
      // The lifecycle regression intentionally navigates away while this request is pending.
    }
  });
  return state;
}

function responseFor(
  method: string,
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>>,
  state: OperationsUiMockState,
  config: ConfigState,
  runtime: RuntimeState,
): MockResponse {
  if (method === 'GET') return getResponse(path, state, config, runtime);
  const protocolProblem = mutationProtocolProblem(headers);
  if (protocolProblem) return protocolProblem;
  if (method === 'PUT') return putConfig(path, body, headers, state, config, runtime);
  if (method === 'DELETE') return terminateSession(path, runtime);
  return missing('Operator route was not found.');
}

function getResponse(path: string, state: OperationsUiMockState, config: ConfigState, runtime: RuntimeState): MockResponse {
  const staticResponse = staticGetResponse(path, state, config);
  if (staticResponse) return staticResponse;
  return sessionGetResponse(path, state, runtime);
}

function staticGetResponse(path: string, state: OperationsUiMockState, config: ConfigState): MockResponse | null {
  if (path === '/api/v1/admin/operate/health') {
    state.healthReads += 1;
    return { status: 503, body: health() };
  }
  if (path === '/api/v1/admin/operate/config') {
    state.configReads += 1;
    return ok({ items: configItems(config) });
  }
  if (path === `/api/v1/admin/operate/config/${CONFIG_KEY}`) return configResponse(CONFIG_KEY, config);
  if (path === `/api/v1/admin/operate/config/${SIBLING_CONFIG_KEY}`) return configResponse(SIBLING_CONFIG_KEY, config);
  if (path === '/api/v1/admin/operate/logs') {
    state.logReads += 1;
    if (state.failNextLogRead) {
      state.failNextLogRead = false;
      return unavailable('Operational logs are temporarily unavailable.');
    }
    return ok(logPage());
  }
  if (path === '/api/v1/admin/operate/metrics') {
    state.metricsReads += 1;
    if (state.failNextMetricsRead) {
      state.failNextMetricsRead = false;
      return unavailable('Operational metrics are temporarily unavailable.');
    }
    return ok(operationalMetrics());
  }
  if (path === '/api/v1/admin/operate/metrics/system') {
    state.systemMetricsReads += 1;
    return ok(systemMetrics());
  }
  return null;
}

function sessionGetResponse(path: string, state: OperationsUiMockState, runtime: RuntimeState): MockResponse {
  if (path === '/api/v1/admin/operate/sessions') return sessionListResponse(state, runtime);
  const sessionId = sessionIdFromDetailPath(path);
  if (sessionId) return sessionDetailResponse(sessionId, state, runtime);
  const commandId = commandIdFromPath(path);
  if (commandId) return commandResponse(commandId, state, runtime);
  return missing('Operator resource was not found.');
}

function sessionListResponse(state: OperationsUiMockState, runtime: RuntimeState): MockResponse {
  state.sessionReads += 1;
  if (state.failNextSessionRead) {
    state.failNextSessionRead = false;
    return unavailable('Runtime sessions are temporarily unavailable.');
  }
  const sessionIds = runtime.options.includeSecondSession
    ? [OPERATIONAL_SESSION_ID, SECOND_OPERATIONAL_SESSION_ID]
    : [OPERATIONAL_SESSION_ID];
  const items = sessionIds
    .filter(sessionId => !runtime.terminatedSessionIds.has(sessionId))
    .map(runtimeSession);
  return ok({ items, page: pageEnvelope() });
}

function sessionDetailResponse(sessionId: string, state: OperationsUiMockState, runtime: RuntimeState): MockResponse {
  state.detailReads += 1;
  if (runtime.options.detailUnavailable || runtime.terminatedSessionIds.has(sessionId)) {
    return missing('This session belongs to another account.');
  }
  return ok(runtimeSession(sessionId));
}

function commandResponse(commandId: string, state: OperationsUiMockState, runtime: RuntimeState): MockResponse {
  state.commandReads += 1;
  const reads = (runtime.commandReads.get(commandId) ?? 0) + 1;
  runtime.commandReads.set(commandId, reads);
  const status = reads === 1 ? 'pending' : runtime.options.commandOutcome;
  const targetSessionId = sessionIdForCommand(commandId);
  if (status === 'terminated' || status === 'already_absent') {
    runtime.terminatedSessionIds.add(targetSessionId);
    if (targetSessionId === OPERATIONAL_SESSION_ID) state.terminated = true;
  }
  return ok(commandStatus(commandId, status));
}

function putConfig(
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>>,
  state: OperationsUiMockState,
  config: ConfigState,
  runtime: RuntimeState,
): MockResponse {
  const key = decodeConfigKey(path);
  if (!key) return missing('Configuration key was not found.');
  state.configPutAttempts += 1;
  const target = configTarget(key, config);
  if (state.configPutAttempts === 1 && runtime.options.conflictOnFirstConfigWrite) target.version += 1;
  const concurrencyProblem = preconditionProblem(headers, configEtag(key, config));
  if (concurrencyProblem) return concurrencyProblem;
  const candidate = asRecord(body);
  if (key === CONFIG_KEY && typeof candidate.value === 'boolean') {
    config.enabled.value = candidate.value;
    state.configValue = candidate.value;
  } else if (key === SIBLING_CONFIG_KEY && typeof candidate.value === 'number') {
    config.maxCacheEntries.value = candidate.value;
    state.maxCacheEntries = candidate.value;
  } else {
    return { status: 422, body: { code: 'invalid_config_value', detail: 'Value does not match the setting schema.' } };
  }
  target.version += 1;
  state.configWrites += 1;
  return configResponse(key, config);
}

function terminateSession(path: string, runtime: RuntimeState): MockResponse {
  const sessionId = sessionIdFromDetailPath(path);
  if (!sessionId || runtime.terminatedSessionIds.has(sessionId)) {
    return missing('Runtime session was not found.');
  }
  const commandId = commandIdForSession(sessionId);
  return {
    status: 202,
    body: {
      session_id: sessionId,
      command_id: commandId,
      target_replica_id: REPLICA_ID,
      reason: 'operator_terminated',
      status: 'accepted',
    },
  };
}

function health() {
  const checkedAt = new Date().toISOString();
  return {
    status: 'degraded',
    checked_at: checkedAt,
    components: [
      { component: 'database', status: 'ok', checked_at: checkedAt, failure_codes: [] },
      { component: 'runtime_control', status: 'degraded', checked_at: checkedAt, failure_codes: ['runtime_ack_delayed'] },
    ],
  };
}

function configItems(config: ConfigState) {
  return [
    configSetting(CONFIG_KEY, config),
    configSetting(SIBLING_CONFIG_KEY, config),
    {
      key: 'license.key',
      schema_version: 1,
      sensitivity: 'secret_write_only',
      mutability: 'restart_required',
      value_schema: { type: 'string', min_length: 1, max_length: 4096 },
      effective_at: null,
      pending_restart: true,
      configured: true,
      etag: '"license-key-v1"',
    },
    {
      key: 'private.feature_enabled',
      schema_version: 1,
      sensitivity: 'secret_write_only',
      mutability: 'dynamic',
      value_schema: { type: 'boolean' },
      effective_at: null,
      pending_restart: false,
      configured: true,
      value: true,
      etag: '"private-feature-v1"',
    },
    {
      key: 'private.provider_options',
      schema_version: 1,
      sensitivity: 'secret_write_only',
      mutability: 'dynamic',
      value_schema: { type: 'object' },
      effective_at: null,
      pending_restart: false,
      configured: true,
      value: { token: OPERATIONS_PRIVATE_MARKER },
      etag: '"private-provider-v1"',
    },
  ];
}

function configSetting(key: string, config: ConfigState) {
  const enabled = key === CONFIG_KEY;
  const target = configTarget(key, config);
  return {
    key,
    schema_version: 1,
    sensitivity: 'public_admin',
    mutability: 'dynamic',
    value_schema: enabled
      ? { type: 'boolean' }
      : { type: 'integer', minimum: 0, maximum: 100000 },
    effective_at: new Date().toISOString(),
    pending_restart: false,
    value: target.value,
    etag: configEtag(key, config),
  };
}

function configResponse(key: string, config: ConfigState): MockResponse {
  const setting = configSetting(key, config);
  return { status: 200, body: setting, etag: setting.etag };
}

function configEtag(key: string, config: ConfigState) {
  return `"operator-config-${key}-v${configTarget(key, config).version}"`;
}

function configTarget(key: string, config: ConfigState) {
  return key === CONFIG_KEY ? config.enabled : config.maxCacheEntries;
}

function decodeConfigKey(path: string): string | null {
  const prefix = '/api/v1/admin/operate/config/';
  if (!path.startsWith(prefix)) return null;
  const key = decodeURIComponent(path.slice(prefix.length));
  return key === CONFIG_KEY || key === SIBLING_CONFIG_KEY ? key : null;
}

function logPage() {
  return {
    items: [{
      ts: new Date().toISOString(),
      level: 'warn',
      subsystem: 'runtime',
      event: 'runtime.command.delayed',
      correlation_id: 'correlation-browser',
      account_correlation_id: '99999999-9999-4999-8999-999999999999',
      session_id: OPERATIONAL_SESSION_ID,
      replica: REPLICA_ID,
      duration_ms: 125,
      status_code: 202,
      error_code: null,
      message: OPERATIONS_PRIVATE_MARKER,
    }],
    page: pageEnvelope(),
  };
}

function operationalMetrics() {
  return {
    checked_at: new Date().toISOString(),
    metrics: [{
      name: 'runtime.commands.pending',
      kind: 'gauge',
      value: 1,
      unit: 'commands',
      dimensions: { subsystem: 'runtime', replica: REPLICA_ID },
    }],
  };
}

function systemMetrics() {
  const timestamp = new Date().toISOString();
  return {
    items: [{
      id: 'browser-snapshot',
      timestamp,
      duration_ms: 3,
      metrics: [{ name: 'cache.hits', source: 'enhanced-index', unit: 'count', type: 'counter', value: 42 }],
      errors: [],
    }],
    page: { limit: 50, cursor: null, next_cursor: null },
    oldest_available: timestamp,
    newest_available: timestamp,
  };
}

function runtimeSession(sessionId: string) {
  const now = new Date();
  const second = sessionId === SECOND_OPERATIONAL_SESSION_ID;
  return {
    session_id: sessionId,
    transport: 'streamable-http',
    client_info: { name: second ? 'Second Browser Client' : 'Browser MCP Client', version: '4.2.0' },
    created_at: new Date(now.getTime() - 60_000).toISOString(),
    last_active_at: now.toISOString(),
    status: 'active',
    account_correlation_id: '99999999-9999-4999-8999-999999999999',
    replica_id: REPLICA_ID,
    request_count: 12,
    error_count: 1,
    lease_until: new Date(now.getTime() + 300_000).toISOString(),
    private_prompt: OPERATIONS_PRIVATE_MARKER,
  };
}

function commandStatus(commandId: string, status: 'pending' | CommandOutcome) {
  return {
    command_id: commandId,
    status,
    acknowledged_at: status === 'pending' ? null : new Date().toISOString(),
    replica_id: status === 'pending' ? null : REPLICA_ID,
    error_code: status === 'failed' ? 'session_termination_failed' : null,
  };
}

function sessionIdFromDetailPath(path: string): string | null {
  const prefix = '/api/v1/admin/operate/sessions/';
  if (!path.startsWith(prefix) || path.includes('/commands/')) return null;
  const sessionId = decodeURIComponent(path.slice(prefix.length));
  return sessionId === OPERATIONAL_SESSION_ID || sessionId === SECOND_OPERATIONAL_SESSION_ID ? sessionId : null;
}

function commandIdFromPath(path: string): string | null {
  const prefix = '/api/v1/admin/operate/sessions/commands/';
  if (!path.startsWith(prefix)) return null;
  const commandId = decodeURIComponent(path.slice(prefix.length));
  return commandId === COMMAND_ID || commandId === SECOND_COMMAND_ID ? commandId : null;
}

function commandIdForSession(sessionId: string): string {
  return sessionId === OPERATIONAL_SESSION_ID ? COMMAND_ID : SECOND_COMMAND_ID;
}

function sessionIdForCommand(commandId: string): string {
  return commandId === COMMAND_ID ? OPERATIONAL_SESSION_ID : SECOND_OPERATIONAL_SESSION_ID;
}

function pageEnvelope() {
  return { limit: 50, cursor: null, next_cursor: null };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function fulfill(route: Route, response: MockResponse): Promise<void> {
  await route.fulfill({
    status: response.status,
    contentType: 'application/json',
    headers: response.etag ? { etag: response.etag } : undefined,
    body: JSON.stringify(response.body),
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
}

function ok(body: unknown): MockResponse {
  return { status: 200, body };
}

function missing(detail: string): MockResponse {
  return { status: 404, body: { code: 'not_found', detail } };
}

function unavailable(detail: string): MockResponse {
  return { status: 503, body: { code: 'temporarily_unavailable', detail } };
}
