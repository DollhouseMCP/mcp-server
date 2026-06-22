import { describe, expect, it } from '@jest/globals';

import type {
  IActivationStateStore,
  PersistedActivation,
  PersistedActivationStateSnapshot,
} from '../../../../src/state/IActivationStateStore.js';
import { SessionActivationRegistry } from '../../../../src/state/SessionActivationState.js';
import {
  ConsoleModuleRegistry,
  InMemoryPortfolioElementStore,
  InMemoryRuntimeSessionControlStore,
  InMemorySessionActivationEventSink,
  InMemorySessionActivationStateAdapter,
  RegistrySessionActivationStateAdapter,
  createActivationModule,
  projectSessionActivation,
  projectSessionActivationList,
  projectSessionDeactivation,
  type ConsoleRequest,
  type ConsoleRouteDefinition,
} from '../../../../src/web-console/index.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const SECOND_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const SESSION_ID = 'mcp-session-1';
const SECOND_SESSION_ID = 'mcp-session-2';
const ACTIVATION_LIST_PATH = '/api/v1/me/sessions/:session_id/activations';
const ACTIVATION_MEMBER_PATH = '/api/v1/me/sessions/:session_id/activations/:type/:name';
const SKILL_TYPE = 'skills';
const SKILL_NAME = 'Code Reviewer';
const SKILL_CANONICAL_NAME = 'code reviewer';
const AGENT_TYPE = 'agents';
const AGENT_NAME = 'agent-one';
const NOW = new Date('2026-05-29T14:00:00.000Z');
const FIVE_MINUTES = new Date('2026-05-29T14:05:00.000Z');

async function fixture() {
  const runtimeStore = new InMemoryRuntimeSessionControlStore();
  await runtimeStore.registerPresence({
    sessionId: SESSION_ID,
    userId: USER_ID,
    accountCorrelationId: '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8',
    replicaId: 'replica-a',
    transport: 'streamable-http',
    startedAt: NOW,
    lastActiveAt: NOW,
    leaseUntil: FIVE_MINUTES,
  });
  await runtimeStore.registerPresence({
    sessionId: SECOND_SESSION_ID,
    userId: SECOND_USER_ID,
    accountCorrelationId: '8d0e5e89-52d0-4f88-a7bc-8f2f65a708b9',
    replicaId: 'replica-b',
    transport: 'streamable-http',
    startedAt: NOW,
    lastActiveAt: NOW,
    leaseUntil: FIVE_MINUTES,
  });
  const portfolioStore = new InMemoryPortfolioElementStore();
  await portfolioStore.create({
    userId: USER_ID,
    type: SKILL_TYPE,
    name: SKILL_NAME,
    displayName: SKILL_NAME,
    metadata: { category: 'review' },
    content: 'Review code carefully.',
    tags: ['review'],
    now: NOW,
  });
  await portfolioStore.create({
    userId: SECOND_USER_ID,
    type: SKILL_TYPE,
    name: 'Other Skill',
    displayName: null,
    metadata: {},
    content: 'Other content.',
    tags: [],
    now: NOW,
  });
  const activationState = new InMemorySessionActivationStateAdapter();
  const eventSink = new InMemorySessionActivationEventSink();
  const module = createActivationModule({
    runtimeStore,
    portfolioStore,
    activationState,
    eventSink,
    now: () => NOW,
  });
  return { module, portfolioStore, activationState, eventSink };
}

function findRoute(
  routes: readonly ConsoleRouteDefinition[],
  method: ConsoleRouteDefinition['method'],
  path: string,
): ConsoleRouteDefinition {
  const route = routes.find(candidate => candidate.method === method && candidate.path === path);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

function request(overrides: Partial<ConsoleRequest> = {}): ConsoleRequest {
  return {
    params: {},
    query: {},
    body: {},
    ip: '127.0.0.1',
    get: (name: string) => name.toLowerCase() === 'user-agent' ? 'jest' : undefined,
    consoleContext: {
      correlationId: '94017d3c-7b7a-4e28-a3c2-701e0ea5471d',
      receivedAt: NOW,
    },
    consoleAuthentication: {
      sessionIdHash: Buffer.alloc(32, 7),
      userId: USER_ID,
      authSub: 'sub-user',
      authzVersion: 1,
      grantedCapabilities: ['console:self'],
      elevation: null,
    },
    ...overrides,
  } as ConsoleRequest;
}

describe('ActivationModule', () => {
  it('registers descriptor-driven self activation routes with expected policies', async () => {
    const registry = new ConsoleModuleRegistry();
    registry.register((await fixture()).module);

    expect(registry.createRouteManifest().routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        moduleId: 'activations',
        method: 'GET',
        path: ACTIVATION_LIST_PATH,
        requiredCapability: 'console:self',
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
      }),
      expect.objectContaining({
        method: 'POST',
        path: ACTIVATION_LIST_PATH,
        idempotency: 'required',
      }),
      expect.objectContaining({
        method: 'DELETE',
        path: ACTIVATION_MEMBER_PATH,
        idempotency: 'required',
      }),
    ]));
  });

  it('activates, lists, and idempotently deactivates only within the owned runtime session', async () => {
    const { module, activationState, eventSink } = await fixture();
    const activateRoute = findRoute(module.routes, 'POST', ACTIVATION_LIST_PATH);
    const listRoute = findRoute(module.routes, 'GET', ACTIVATION_LIST_PATH);
    const deleteRoute = findRoute(module.routes, 'DELETE', ACTIVATION_MEMBER_PATH);

    await expect(activateRoute.handler(request({
      params: { session_id: SECOND_SESSION_ID },
      body: { type: SKILL_TYPE, name: SKILL_NAME },
    }))).resolves.toMatchObject({ status: 404 });

    const activated = await activateRoute.handler(request({
      params: { session_id: SESSION_ID },
      body: { type: SKILL_TYPE, name: SKILL_NAME },
    }));
    expect(activated).toMatchObject({
      status: 200,
      body: {
        type: SKILL_TYPE,
        name: SKILL_CANONICAL_NAME,
        display_name: SKILL_NAME,
      },
    });
    const activatedAt = (activated.body as { readonly activated_at: string }).activated_at;

    await expect(activateRoute.handler(request({
      params: { session_id: SESSION_ID },
      body: { type: SKILL_TYPE, name: SKILL_NAME },
    }))).resolves.toMatchObject({
      status: 200,
      body: {
        type: SKILL_TYPE,
        name: SKILL_CANONICAL_NAME,
        activated_at: activatedAt,
      },
    });

    await expect(listRoute.handler(request({ params: { session_id: SESSION_ID } })))
      .resolves.toMatchObject({
        status: 200,
        body: {
          activations: [expect.objectContaining({
            type: SKILL_TYPE,
            name: SKILL_CANONICAL_NAME,
          })],
        },
      });
    await expect(activationState.list(SECOND_SESSION_ID)).resolves.toEqual([]);

    await expect(deleteRoute.handler(request({
      params: { session_id: SESSION_ID, type: SKILL_TYPE, name: SKILL_NAME },
    }))).resolves.toMatchObject({
      status: 200,
      body: {
        deactivated: true,
        type: SKILL_TYPE,
        name: SKILL_CANONICAL_NAME,
      },
    });
    await expect(deleteRoute.handler(request({
      params: { session_id: SESSION_ID, type: SKILL_TYPE, name: SKILL_NAME },
    }))).resolves.toMatchObject({ status: 200 });
    await expect(listRoute.handler(request({ params: { session_id: SESSION_ID } })))
      .resolves.toEqual({ status: 200, body: { activations: [] } });
    expect(eventSink.listEvents()).toEqual([
      expect.objectContaining({
        userId: USER_ID,
        sessionId: SESSION_ID,
        elementType: SKILL_TYPE,
        elementName: SKILL_CANONICAL_NAME,
        action: 'activated',
      }),
      expect.objectContaining({
        userId: USER_ID,
        sessionId: SESSION_ID,
        elementType: SKILL_TYPE,
        elementName: SKILL_CANONICAL_NAME,
        action: 'deactivated',
      }),
    ]);
  });

  it('returns 404 for non-owned sessions on list and delete without leaking existence', async () => {
    const { module } = await fixture();
    const listRoute = findRoute(module.routes, 'GET', ACTIVATION_LIST_PATH);
    const deleteRoute = findRoute(module.routes, 'DELETE', ACTIVATION_MEMBER_PATH);

    await expect(listRoute.handler(request({ params: { session_id: SECOND_SESSION_ID } })))
      .resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
    await expect(deleteRoute.handler(request({
      params: { session_id: SECOND_SESSION_ID, type: SKILL_TYPE, name: SKILL_NAME },
    }))).resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
  });

  it('requires an owned portfolio element on activation without mutating portfolio content', async () => {
    const { module, portfolioStore } = await fixture();
    const activateRoute = findRoute(module.routes, 'POST', ACTIVATION_LIST_PATH);

    await expect(activateRoute.handler(request({
      params: { session_id: SESSION_ID },
      body: { type: SKILL_TYPE, name: 'Other Skill' },
    }))).resolves.toMatchObject({ status: 404 });
    await expect(activateRoute.handler(request({
      params: { session_id: SESSION_ID },
      body: { type: 'tools', name: SKILL_NAME },
    }))).resolves.toMatchObject({ status: 422, body: { code: 'validation_failed' } });
    await expect(activateRoute.handler(request({
      params: { session_id: SESSION_ID },
      body: { type: 'templates', name: 'Prompt Template' },
    }))).resolves.toMatchObject({ status: 422, body: { code: 'validation_failed' } });
    await expect(activateRoute.handler(request({
      params: { session_id: SESSION_ID },
      body: null,
    }))).resolves.toMatchObject({ status: 422, body: { code: 'validation_failed' } });
    await expect(activateRoute.handler(request({
      params: { session_id: SESSION_ID },
      body: 'not-an-object',
    }))).resolves.toMatchObject({ status: 422, body: { code: 'validation_failed' } });

    await expect(portfolioStore.findByName(USER_ID, SKILL_TYPE, SKILL_CANONICAL_NAME))
      .resolves.toMatchObject({
        content: 'Review code carefully.',
        version: 1,
      });
  });

  it('rejects invalid delete types and names after owned-session validation', async () => {
    const { module } = await fixture();
    const deleteRoute = findRoute(module.routes, 'DELETE', ACTIVATION_MEMBER_PATH);

    await expect(deleteRoute.handler(request({
      params: { session_id: SESSION_ID, type: 'templates', name: 'Prompt Template' },
    }))).resolves.toMatchObject({ status: 422, body: { code: 'validation_failed' } });
    await expect(deleteRoute.handler(request({
      params: { session_id: SESSION_ID, type: SKILL_TYPE, name: '.md' },
    }))).resolves.toMatchObject({ status: 422, body: { code: 'validation_failed' } });
  });

  it('privacy projectors strip activation fields outside the self-private DTO', () => {
    expect(projectSessionActivation({
      type: SKILL_TYPE,
      name: SKILL_CANONICAL_NAME,
      display_name: SKILL_NAME,
      activated_at: NOW.toISOString(),
      user_id: USER_ID,
      content: 'strip',
    })).toEqual({
      type: SKILL_TYPE,
      name: SKILL_CANONICAL_NAME,
      display_name: SKILL_NAME,
      activated_at: NOW.toISOString(),
    });
    expect(projectSessionActivationList({
      activations: [{
        type: SKILL_TYPE,
        name: SKILL_CANONICAL_NAME,
        display_name: null,
        activated_at: NOW.toISOString(),
        token: 'strip',
      }],
    })).toEqual({
      activations: [{
        type: SKILL_TYPE,
        name: SKILL_CANONICAL_NAME,
        display_name: null,
        activated_at: NOW.toISOString(),
      }],
    });
    expect(projectSessionDeactivation({
      deactivated: true,
      type: SKILL_TYPE,
      name: SKILL_CANONICAL_NAME,
      deactivated_at: NOW.toISOString(),
      session_state: 'strip',
    })).toEqual({
      deactivated: true,
      type: SKILL_TYPE,
      name: SKILL_CANONICAL_NAME,
      deactivated_at: NOW.toISOString(),
    });
  });
});

describe('RegistrySessionActivationStateAdapter', () => {
  it('lists from an enabled activation store instead of fabricating set timestamps', async () => {
    const registry = new SessionActivationRegistry('default-session');
    const state = registry.getOrCreate(SESSION_ID);
    state.skills.add(SKILL_CANONICAL_NAME);
    const store = new FixtureActivationStateStore(SESSION_ID);
    store.recordActivation(SKILL_TYPE, 'store-only-skill');
    state.activationStore = store;
    const adapter = new RegistrySessionActivationStateAdapter(registry);

    await expect(adapter.list(SESSION_ID)).resolves.toEqual([{
      type: SKILL_TYPE,
      name: 'store-only-skill',
      activatedAt: NOW,
    }]);
  });

  it('merges registry sets with fallback records when no store is enabled', async () => {
    const registry = new SessionActivationRegistry('default-session');
    registry.getOrCreate(SESSION_ID).skills.add(SKILL_CANONICAL_NAME);
    const adapter = new RegistrySessionActivationStateAdapter(registry);

    await adapter.activate(SESSION_ID, AGENT_TYPE, AGENT_NAME);

    await expect(adapter.list(SESSION_ID)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: SKILL_TYPE, name: SKILL_CANONICAL_NAME }),
      expect.objectContaining({ type: AGENT_TYPE, name: AGENT_NAME }),
    ]));
  });

  it('dual-writes activations to the registry set and store while keeping re-activate idempotent', async () => {
    const registry = new SessionActivationRegistry('default-session');
    const state = registry.getOrCreate(SESSION_ID);
    const store = new FixtureActivationStateStore(SESSION_ID);
    state.activationStore = store;
    const adapter = new RegistrySessionActivationStateAdapter(registry);

    const first = await adapter.activate(SESSION_ID, SKILL_TYPE, SKILL_CANONICAL_NAME);
    const second = await adapter.activate(SESSION_ID, SKILL_TYPE, SKILL_CANONICAL_NAME);

    expect(first).toEqual({
      changed: true,
      record: {
        type: SKILL_TYPE,
        name: SKILL_CANONICAL_NAME,
        activatedAt: NOW,
      },
    });
    expect(second).toEqual({
      changed: false,
      record: first.record,
    });
    expect(state.skills.has(SKILL_CANONICAL_NAME)).toBe(true);
    expect(store.getActivations(SKILL_TYPE)).toEqual([{
      name: SKILL_CANONICAL_NAME,
      activatedAt: NOW.toISOString(),
    }]);
  });

  it('deactivates records that exist only in the store', async () => {
    const registry = new SessionActivationRegistry('default-session');
    const state = registry.getOrCreate(SESSION_ID);
    const store = new FixtureActivationStateStore(SESSION_ID);
    store.recordActivation(SKILL_TYPE, SKILL_CANONICAL_NAME);
    state.activationStore = store;
    const adapter = new RegistrySessionActivationStateAdapter(registry);

    await expect(adapter.deactivate(SESSION_ID, SKILL_TYPE, SKILL_CANONICAL_NAME)).resolves.toBe(true);
    await expect(adapter.deactivate(SESSION_ID, SKILL_TYPE, SKILL_CANONICAL_NAME)).resolves.toBe(false);
    expect(store.getActivations(SKILL_TYPE)).toEqual([]);
  });
});

class FixtureActivationStateStore implements IActivationStateStore {
  private readonly activations = new Map<string, PersistedActivation[]>();

  constructor(private readonly sessionId: string) {}

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  recordActivation(elementType: string, name: string, filename?: string): void {
    const existing = this.activations.get(elementType) ?? [];
    if (existing.some(activation => activation.name === name)) return;
    this.activations.set(elementType, [
      ...existing,
      {
        name,
        ...(filename ? { filename } : {}),
        activatedAt: NOW.toISOString(),
      },
    ]);
  }

  recordDeactivation(elementType: string, name: string): void {
    this.activations.set(
      elementType,
      (this.activations.get(elementType) ?? []).filter(activation => activation.name !== name),
    );
  }

  removeStaleActivation(elementType: string, name: string): void {
    this.recordDeactivation(elementType, name);
  }

  getActivations(elementType: string): PersistedActivation[] {
    return [...this.activations.get(elementType) ?? []];
  }

  clearAll(): void {
    this.activations.clear();
  }

  getSessionId(): string {
    return this.sessionId;
  }

  isEnabled(): boolean {
    return true;
  }

  listPersistedActivationStates(): Promise<PersistedActivationStateSnapshot[]> {
    return Promise.resolve([]);
  }
}
