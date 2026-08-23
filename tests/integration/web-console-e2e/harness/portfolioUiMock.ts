import type { Page, Route } from '@playwright/test';

import { mutationProtocolProblem, preconditionProblem } from './requestProtocolMock.js';

const CREATE_PATH_PATTERN = /^\/api\/v1\/me\/portfolio\/elements\/([^/]+)$/u;
const ELEMENT_PATH_PATTERN = /^\/api\/v1\/me\/portfolio\/elements\/([^/]+)\/([^/]+)$/u;
const VALIDATE_PATH_PATTERN = /^\/api\/v1\/me\/portfolio\/elements\/([^/]+)\/[^/]+\/validate$/u;

interface MockResponse {
  readonly status: number;
  readonly body: unknown;
  readonly etag?: string;
}

interface PortfolioElement {
  type: string;
  name: string;
  display_name: string | null;
  version: number;
  updated_at: string;
  validation_status: string;
  tags: string[];
  metadata: Record<string, unknown>;
  content: string;
}

interface PortfolioUiMockOptions {
  readonly conflictOnFirstPatch?: boolean;
  readonly includeCollection?: boolean;
  readonly omitEtagAfterConflict?: boolean;
  readonly syncOutcome?: 'succeeded' | 'failed';
}

export interface PortfolioUiMockState {
  collectionReads: number;
  patchAttempts: number;
  deletes: number;
  syncReads: number;
  elements: PortfolioElement[];
}

export async function installPortfolioUiMock(
  page: Page,
  options: PortfolioUiMockOptions = {},
): Promise<PortfolioUiMockState> {
  const state: PortfolioUiMockState = {
    collectionReads: 0,
    patchAttempts: 0,
    deletes: 0,
    syncReads: 0,
    elements: [element('personas', 'alpha-persona', 'Original portfolio content.')],
  };
  if (options.includeCollection) {
    await page.route('**/api/v1/collection/elements**', async route => {
      const pageNumber = Number(new URL(route.request().url()).searchParams.get('page') ?? '1');
      state.collectionReads += 1;
      await fulfill(route, 200, collectionPage(pageNumber));
    });
  }
  await page.route('**/api/v1/me/portfolio**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const response = responseFor(method, path, request.postDataJSON(), request.headers(), state, options);
    await fulfill(route, response.status, response.body, response.etag);
  });
  return state;
}

function responseFor(
  method: string,
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>>,
  state: PortfolioUiMockState,
  options: PortfolioUiMockOptions,
): MockResponse {
  if (method === 'GET') {
    return getResponse(
      path,
      state,
      options.syncOutcome ?? 'succeeded',
      options.omitEtagAfterConflict ?? false,
    );
  }
  const protocolProblem = mutationProtocolProblem(headers);
  if (protocolProblem) return protocolProblem;
  if (method === 'POST') return postResponse(path, body, state);
  if (method === 'PATCH') return patchResponse(path, body, headers, state, options.conflictOnFirstPatch ?? false);
  if (method === 'DELETE') return deleteResponse(path, headers, state);
  return missing();
}

function getResponse(
  path: string,
  state: PortfolioUiMockState,
  syncOutcome: 'succeeded' | 'failed',
  omitEtagAfterConflict: boolean,
): MockResponse {
  if (path === '/api/v1/me/portfolio') {
    return ok({ total_elements: state.elements.length, counts_by_type: counts(state.elements), updated_at: new Date().toISOString() });
  }
  if (path === '/api/v1/me/portfolio/elements') {
    return ok({ elements: state.elements.map(summary) });
  }
  if (path.startsWith('/api/v1/me/portfolio/sync/')) {
    state.syncReads += 1;
    const running = state.syncReads < 2;
    return ok(syncJob(running ? 'running' : syncOutcome));
  }
  const found = findElement(path, state.elements);
  if (!found) return missing();
  return omitEtagAfterConflict && state.patchAttempts > 0
    ? ok(found)
    : { ...ok(found), etag: etag(found) };
}

function postResponse(path: string, body: unknown, state: PortfolioUiMockState): MockResponse {
  if (path === '/api/v1/me/portfolio/sync') return { status: 202, body: syncJob('queued') };
  if (path.endsWith('/validate')) {
    const candidate = asRecord(body);
    return ok(mockValidation(path, candidate));
  }
  if (path.endsWith('/render')) {
    const candidate = asRecord(body);
    return ok({ type: 'personas', name: 'alpha-persona', preview: candidate.content ?? '' });
  }
  const createMatch = CREATE_PATH_PATTERN.exec(path);
  if (!createMatch) return missing();
  const candidate = asRecord(body);
  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const content = typeof candidate.content === 'string' ? candidate.content : '';
  const type = decodeURIComponent(createMatch[1]);
  if (state.elements.some(item => item.type === type && item.name === name)) {
    return {
      status: 409,
      body: { code: 'portfolio_element_exists', detail: 'An element with this type and name already exists.' },
    };
  }
  const created = element(type, name, content);
  created.display_name = typeof candidate.display_name === 'string' ? candidate.display_name : null;
  created.metadata = asRecord(candidate.metadata);
  created.tags = Array.isArray(candidate.tags) ? candidate.tags.map(String) : [];
  state.elements.push(created);
  return { status: 201, body: created, etag: etag(created) };
}

function mockValidation(path: string, candidate: Record<string, unknown>): unknown {
  const match = VALIDATE_PATH_PATTERN.exec(path);
  const type = match ? decodeURIComponent(match[1]) : '';
  const content = typeof candidate.content === 'string' ? candidate.content.trim() : '';
  const metadata = asRecord(candidate.metadata);
  const instructions = typeof metadata.instructions === 'string' ? metadata.instructions.trim() : '';
  const requiresContent = type === 'templates' || type === 'memories';
  const requiresInstructionsOrContent = type === 'personas' || type === 'skills';
  const hasAgentDefinition = type === 'agents' && metadata.goal !== undefined;
  const hasEnsembleDefinition = type === 'ensembles' && Array.isArray(metadata.elements) && metadata.elements.length > 0;
  const valid = Boolean(content)
    || requiresInstructionsOrContent && Boolean(instructions)
    || !requiresContent && !requiresInstructionsOrContent && (
      Boolean(instructions) || hasAgentDefinition || hasEnsembleDefinition
    );
  return valid
    ? { valid: true, issues: [] }
    : { valid: false, issues: [{ path: 'content', code: 'required', message: validationMessage(requiresContent) }] };
}

function validationMessage(requiresContent: boolean): string {
  return requiresContent ? 'content is required.' : 'content or metadata.instructions is required.';
}

function patchResponse(
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>>,
  state: PortfolioUiMockState,
  conflictOnFirstPatch: boolean,
): MockResponse {
  state.patchAttempts += 1;
  const current = findElement(path, state.elements);
  if (!current) return missing();
  if (conflictOnFirstPatch && state.patchAttempts === 1) {
    current.content = 'Latest server content.';
    current.version += 1;
  }
  const concurrencyProblem = preconditionProblem(headers, etag(current));
  if (concurrencyProblem) return concurrencyProblem;
  const candidate = asRecord(body);
  current.content = typeof candidate.content === 'string' ? candidate.content : current.content;
  current.display_name = typeof candidate.display_name === 'string' ? candidate.display_name : null;
  current.metadata = asRecord(candidate.metadata);
  current.tags = Array.isArray(candidate.tags) ? candidate.tags.map(String) : [];
  current.version += 1;
  return { status: 200, body: current, etag: etag(current) };
}

function deleteResponse(
  path: string,
  headers: Readonly<Record<string, string>>,
  state: PortfolioUiMockState,
): MockResponse {
  const current = findElement(path, state.elements);
  if (!current) return missing();
  const concurrencyProblem = preconditionProblem(headers, etag(current));
  if (concurrencyProblem) return concurrencyProblem;
  state.deletes += 1;
  state.elements = state.elements.filter(item => item !== current);
  return ok({ deleted: true, type: current.type, name: current.name, version: current.version, deleted_at: new Date().toISOString() });
}

function findElement(path: string, elements: PortfolioElement[]): PortfolioElement | null {
  const match = ELEMENT_PATH_PATTERN.exec(path);
  if (!match) return null;
  const type = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);
  return elements.find(item => item.type === type && item.name === name) ?? null;
}

function element(type: string, name: string, content: string): PortfolioElement {
  return {
    type,
    name,
    display_name: null,
    version: 1,
    updated_at: new Date().toISOString(),
    validation_status: 'valid',
    tags: ['e2e'],
    metadata: { description: 'Portfolio browser acceptance fixture.' },
    content,
  };
}

function summary(item: PortfolioElement) {
  const { metadata: _metadata, content: _content, ...value } = item;
  return value;
}

function counts(elements: PortfolioElement[]) {
  const result = Object.fromEntries(['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'].map(type => [type, 0]));
  for (const item of elements) result[item.type] += 1;
  return result;
}

function collectionPage(page: number) {
  const fixtures = [
    {
      type: 'skills',
      name: 'collection-skill',
      display_name: 'Collection Skill',
      description: 'A skill from the community collection.',
      version: '1.0.0',
      author: 'DollhouseMCP',
      tags: ['collection', 'skill'],
      path: 'library/skills/collection-skill.md',
      source: 'collection',
    },
    {
      type: 'templates',
      name: 'collection-template',
      display_name: 'Collection Template',
      description: 'A template from the community collection.',
      version: '1.0.0',
      author: 'DollhouseMCP',
      tags: ['collection', 'template'],
      path: 'library/templates/collection-template.md',
      source: 'collection',
    },
  ];
  const index = Math.max(0, page - 1);
  return {
    elements: index < fixtures.length ? [fixtures[index]] : [],
    total: fixtures.length,
    page,
    page_size: 1,
    has_more: page < fixtures.length,
    source_status: 'ok',
    source_detail: null,
    install_enabled: false,
  };
}

function syncJob(status: string) {
  return {
    job_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status,
    direction: 'pull',
    conflict_policy: 'fail',
    status_url: '/api/v1/me/portfolio/sync/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    created_at: new Date().toISOString(),
    started_at: status === 'queued' ? null : new Date().toISOString(),
    completed_at: ['succeeded', 'failed'].includes(status) ? new Date().toISOString() : null,
    result_summary: status === 'succeeded' ? { pulled: 1 } : null,
    error_code: status === 'failed' ? 'github_sync_failed' : null,
  };
}

function etag(item: PortfolioElement) {
  return `"mock-${item.type}-${item.name}-v${item.version}"`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function fulfill(route: Route, status: number, body: unknown, etagValue?: string) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: etagValue ? { etag: etagValue } : undefined,
    body: JSON.stringify(body),
  });
}

function ok(body: unknown): MockResponse {
  return { status: 200, body };
}

function missing(): MockResponse {
  return { status: 404, body: { code: 'portfolio_element_not_found', detail: 'Element was not found.' } };
}
