import type { Page, Route } from '@playwright/test';

import { mutationProtocolProblem } from './requestProtocolMock.js';

const BASE = '/api/v1/me/integrations';
const DESCRIPTORS = `${BASE}/descriptors`;

interface MockDescriptor {
  id: string;
  provider: string;
  ownership: 'curated' | 'byo';
  display_name: string;
  category: string;
  auth_strategy: 'oauth2_authorization_code' | 'static_api_key';
  api_hosts: string[];
  oauth: Record<string, unknown> | null;
  static_api_key: {
    injection: { location: 'header' | 'query' | 'basic'; name: string; value_prefix: string | null };
  } | null;
  has_client_secret: boolean;
  operation_promotion: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface MockOperation {
  operation_id: string;
  method: string;
  path: string;
  read_write_class: string;
  summary: string | null;
  description: string | null;
  required_scopes: string[];
}

export interface IntegrationsUiMockState {
  descriptors: MockDescriptor[];
  /** Operations the stored spec resolves to. Override before importing to model a larger API. */
  operations: MockOperation[];
  connectedProviders: Set<string>;
  staticConnects: number;
  descriptorWrites: number;
  specWrites: number;
  receivedApiKey: boolean;
  receivedBasicCredential: boolean;
  receivedClientSecret: boolean;
  clientSecretWrites: number;
}

export async function installIntegrationsUiMock(page: Page): Promise<IntegrationsUiMockState> {
  const state: IntegrationsUiMockState = {
    descriptors: [curatedDescriptor(), staticDescriptor(), basicDescriptor()],
    operations: [{
      operation_id: 'listTasks',
      method: 'GET',
      path: '/tasks',
      read_write_class: 'read',
      summary: 'List tasks',
      description: null,
      required_scopes: [],
    }],
    connectedProviders: new Set(),
    staticConnects: 0,
    descriptorWrites: 0,
    specWrites: 0,
    receivedApiKey: false,
    receivedBasicCredential: false,
    receivedClientSecret: false,
    clientSecretWrites: 0,
  };
  await page.route('**/api/v1/me/integrations**', route => handleRoute(route, state));
  return state;
}

async function handleRoute(route: Route, state: IntegrationsUiMockState): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const method = request.method();
  if (method !== 'GET') {
    const problem = mutationProtocolProblem(request.headers());
    if (problem) {
      await fulfill(route, problem.status, problem.body);
      return;
    }
  }
  const response = responseFor(method, path, request.postDataJSON(), state);
  await fulfill(route, response.status, response.body);
}

function responseFor(
  method: string,
  path: string,
  body: unknown,
  state: IntegrationsUiMockState,
): { status: number; body: unknown } {
  if (path === BASE && method === 'GET') {
    return {
      status: 200,
      body: {
        integrations: [
          providerStatus('github', 'GitHub', 'Source control', false),
          providerStatus('curated-oauth', 'Curated OAuth', 'Productivity', false),
        ],
      },
    };
  }
  if (path === DESCRIPTORS && method === 'GET') {
    return { status: 200, body: { descriptors: state.descriptors, next_cursor: null } };
  }
  if (path === DESCRIPTORS && method === 'POST') return createDescriptor(body, state);

  const specMatch = /^\/api\/v1\/me\/integrations\/descriptors\/([^/]+)\/spec(?:\/operations)?$/.exec(path);
  if (specMatch) return specResponse(method, path, decodeURIComponent(specMatch[1]), body, state);

  const descriptorMatch = /^\/api\/v1\/me\/integrations\/descriptors\/([^/]+)$/.exec(path);
  if (descriptorMatch) {
    return descriptorResponse(method, decodeURIComponent(descriptorMatch[1]), body, state);
  }

  const connectMatch = /^\/api\/v1\/me\/integrations\/([^/]+)\/connect$/.exec(path);
  if (connectMatch && method === 'POST') {
    return connectResponse(decodeURIComponent(connectMatch[1]), body, state);
  }
  const providerMatch = /^\/api\/v1\/me\/integrations\/([^/]+)$/.exec(path);
  if (providerMatch) {
    const provider = decodeURIComponent(providerMatch[1]);
    if (method === 'DELETE') state.connectedProviders.delete(provider);
    const descriptor = state.descriptors.find(item => item.provider === provider);
    return {
      status: 200,
      body: providerStatus(
        provider,
        descriptor?.display_name ?? provider,
        descriptor?.category ?? 'Integration',
        state.connectedProviders.has(provider),
      ),
    };
  }
  return { status: 404, body: { detail: 'Not found' } };
}

function connectResponse(provider: string, body: unknown, state: IntegrationsUiMockState) {
  const input = record(body);
  const descriptor = state.descriptors.find(item => item.provider === provider);
  if (descriptor?.auth_strategy === 'static_api_key') {
    state.staticConnects += 1;
    if (descriptor.static_api_key?.injection.location === 'basic') {
      state.receivedBasicCredential = typeof input.username === 'string'
        && input.username.length > 0
        && typeof input.password === 'string'
        && input.password.length > 0;
    } else {
      state.receivedApiKey = typeof input.api_key === 'string' && input.api_key.length > 0;
    }
    state.connectedProviders.add(provider);
    return {
      status: 200,
      body: providerStatus(provider, descriptor.display_name, descriptor.category, true),
    };
  }
  return { status: 200, body: { authorize_url: 'https://provider.example/authorize' } };
}

function createDescriptor(body: unknown, state: IntegrationsUiMockState) {
  const input = record(body);
  const descriptor = descriptorFromInput(`byo-${state.descriptorWrites + 2}`, input);
  state.receivedClientSecret = typeof record(input.oauth).client_secret === 'string';
  if (state.receivedClientSecret) state.clientSecretWrites += 1;
  descriptor.has_client_secret = state.receivedClientSecret;
  state.descriptors.push(descriptor);
  state.descriptorWrites += 1;
  return { status: 201, body: descriptor };
}

function descriptorResponse(method: string, id: string, body: unknown, state: IntegrationsUiMockState) {
  const index = state.descriptors.findIndex(item => item.id === id);
  if (index < 0) return { status: 404, body: { detail: 'Not found' } };
  if (method === 'PATCH') {
    const input = record(body);
    const includesClientSecret = typeof record(input.oauth).client_secret === 'string';
    state.receivedClientSecret ||= includesClientSecret;
    if (includesClientSecret) state.clientSecretWrites += 1;
    state.descriptors[index] = {
      ...state.descriptors[index],
      ...descriptorFromInput(id, input, state.descriptors[index]),
      has_client_secret: state.descriptors[index].has_client_secret || state.receivedClientSecret,
    };
    state.descriptorWrites += 1;
    return { status: 200, body: state.descriptors[index] };
  }
  if (method === 'DELETE') {
    state.descriptors.splice(index, 1);
    return { status: 204, body: null };
  }
  return { status: 200, body: state.descriptors[index] };
}

function specResponse(method: string, path: string, id: string, body: unknown, state: IntegrationsUiMockState) {
  const descriptor = state.descriptors.find(item => item.id === id);
  if (!descriptor) return { status: 404, body: { detail: 'Not found' } };
  if (path.endsWith('/operations')) {
    if (state.specWrites === 0) return { status: 404, body: { detail: 'No spec' } };
    return {
      status: 200,
      body: { descriptor_id: id, spec_hash: 'abcdef1234567890', operations: state.operations },
    };
  }
  if (method === 'PUT') {
    const input = record(body);
    // Accept any recognisable definition, not just OpenAPI 3 — gating on `openapi` alone made a
    // successful PUT of a Swagger 2.0 document look like no spec had ever been stored.
    const spec = record(input.spec);
    if (spec.openapi || spec.swagger) state.specWrites += 1;
  }
  if (state.specWrites === 0) return { status: 404, body: { detail: 'No spec' } };
  return {
    status: method === 'PUT' ? 201 : 200,
    body: {
      descriptor_id: id,
      provider: descriptor.provider,
      spec_hash: 'abcdef1234567890',
      source_url: null,
      operation_count: state.operations.length,
      spec_bytes: 180,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  };
}

// Mirrors the real authoring service: a PATCH that omits a field preserves the stored value rather
// than clearing it, so partial updates (for example promoting operations) can't wipe the rest.
function descriptorFromInput(id: string, input: Record<string, unknown>, existing?: MockDescriptor): MockDescriptor {
  const now = new Date().toISOString();
  const strategy = resolveStrategy(input.auth_strategy, existing);
  return {
    id,
    provider: stringField(input.provider) || existing?.provider || 'custom-provider',
    ownership: 'byo',
    display_name: stringField(input.display_name) || existing?.display_name || 'Custom provider',
    category: stringField(input.category) || existing?.category || 'Integration',
    auth_strategy: strategy,
    api_hosts: input.api_hosts === undefined ? (existing?.api_hosts ?? []) : stringArray(input.api_hosts),
    oauth: strategy === 'oauth2_authorization_code'
      ? publicOauth(record(input.oauth), existing?.oauth)
      : null,
    static_api_key: staticApiKeyFromInput(strategy, input, existing),
    has_client_secret: existing?.has_client_secret ?? false,
    operation_promotion: input.operation_promotion === undefined
      ? (existing?.operation_promotion ?? {})
      : record(input.operation_promotion),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

function resolveStrategy(value: unknown, existing?: MockDescriptor): MockDescriptor['auth_strategy'] {
  if (value === undefined) return existing?.auth_strategy ?? 'oauth2_authorization_code';
  return value === 'static_api_key' ? 'static_api_key' : 'oauth2_authorization_code';
}

function staticApiKeyFromInput(
  strategy: MockDescriptor['auth_strategy'],
  input: Record<string, unknown>,
  existing?: MockDescriptor,
): MockDescriptor['static_api_key'] {
  if (strategy !== 'static_api_key') return null;
  if (input.static_api_key === undefined) return existing?.static_api_key ?? null;
  return record(input.static_api_key) as MockDescriptor['static_api_key'];
}

function publicOauth(input: Record<string, unknown>, existing: Record<string, unknown> | null | undefined) {
  return {
    client_id: stringField(input.client_id) || stringField(existing?.client_id),
    authorization_url: stringField(input.authorization_url) || stringField(existing?.authorization_url),
    token_url: stringField(input.token_url) || stringField(existing?.token_url),
    scopes: stringArray(input.scopes),
    pkce: stringField(input.pkce) || 'required',
    refresh: stringField(input.refresh) || 'none',
    token_exchange: {},
    account_label: {},
  };
}

function staticDescriptor(): MockDescriptor {
  return {
    id: 'byo-1',
    provider: 'acme-tasks',
    ownership: 'byo',
    display_name: 'Acme Tasks',
    category: 'Project management',
    auth_strategy: 'static_api_key',
    api_hosts: ['api.acme.test'],
    oauth: null,
    static_api_key: {
      injection: { location: 'header', name: 'X-API-Key', value_prefix: null },
    },
    has_client_secret: false,
    operation_promotion: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function basicDescriptor(): MockDescriptor {
  return {
    id: 'byo-basic',
    provider: 'legacy-reports',
    ownership: 'byo',
    display_name: 'Legacy Reports',
    category: 'Reporting',
    auth_strategy: 'static_api_key',
    api_hosts: ['reports.legacy.test'],
    oauth: null,
    static_api_key: {
      injection: { location: 'basic', name: 'Authorization', value_prefix: null },
    },
    has_client_secret: false,
    operation_promotion: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function curatedDescriptor(): MockDescriptor {
  return {
    id: 'curated-1',
    provider: 'curated-oauth',
    ownership: 'curated',
    display_name: 'Curated OAuth',
    category: 'Productivity',
    auth_strategy: 'oauth2_authorization_code',
    api_hosts: ['api.curated.test'],
    oauth: {
      client_id: 'public-client',
      authorization_url: 'https://auth.curated.test/authorize',
      token_url: 'https://auth.curated.test/token',
      scopes: ['read'],
      pkce: 'required',
      refresh: 'rotating',
      token_exchange: {},
      account_label: {},
    },
    static_api_key: null,
    has_client_secret: true,
    operation_promotion: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function providerStatus(provider: string, displayName: string, category: string, connected: boolean) {
  return {
    provider,
    display_name: displayName,
    category,
    status: connected ? 'connected' : 'disconnected',
    account_label: connected ? `${provider} account` : null,
    scopes: [],
    error_reason: null,
    connected_at: connected ? new Date().toISOString() : null,
    last_sync_at: null,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

async function fulfill(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: body === null ? '' : JSON.stringify(body),
  });
}
