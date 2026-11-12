import { createHash, randomUUID } from 'node:crypto';

import { and, eq, inArray, like, lt, sql } from 'drizzle-orm';

import { withSystemContext } from '../../database/admin.js';
import type { DatabaseInstance } from '../../database/connection.js';
import { getErrorCode } from '../../database/db-utils.js';
import { CANARY_USER_UUID } from '../../database/internalUsers.js';
import { agentStates, elements, sessions } from '../../database/schema/index.js';
import { runtimeSessionPresence } from '../../database/schema/webConsole.js';
import { GatekeeperSession } from '../../handlers/mcp-aql/GatekeeperSession.js';
import type { IConfirmationStore } from '../../state/IConfirmationStore.js';
import { DatabaseAgentStateStore } from '../../storage/DatabaseAgentStateStore.js';
import { createApprovalModule } from '../modules/approvals/ApprovalModule.js';
import type { SessionApprovalStore } from '../modules/approvals/ApprovalStore.js';
import { createExecutionModule } from '../modules/executions/ExecutionModule.js';
import type { SessionExecutionReader, SessionGatekeeperReader } from '../modules/executions/ExecutionStore.js';
import type { ConsoleModuleDescriptor, ConsoleRequest } from '../platform/ConsolePlatformTypes.js';
import type { IRuntimeSessionControlStore } from '../services/runtime/IRuntimeSessionControlStore.js';
import type { WebConsoleSetupCheckResult, WebConsoleSetupCheckState } from '../setup/WebConsoleSetupStatus.js';
import { CanaryUserStateError, ensureCanaryUser, type CanaryUser } from './CanaryUser.js';

const CHECK_ID = 'approval_execution_projection';

/** Everything the canary creates carries these, so anything seen in passing is recognisable. */
export const CANARY_SESSION_PREFIX = 'canary-';
export const CANARY_CLIENT_NAME = 'dollhouse-canary';
export const CANARY_TOOL_NAME = 'dollhouse_canary_check';
export const CANARY_AGENT_PREFIX = 'dollhouse-canary-agent-';

const CANARY_RISK_LEVEL = 'low';
const CANARY_GOAL_DESCRIPTION = 'Canary check: not a real execution.';
const SESSION_LEASE_MS = 60_000;
export const DEFAULT_CANARY_TIMEOUT_MS = 15_000;
/** Canary records older than this were left by a run that did not finish. */
export const CANARY_LEFTOVER_AGE_MS = 5 * 60_000;

export type CanaryCode =
  | 'canary_passed'
  | 'canary_user_not_inert'
  | 'canary_could_not_run'
  | 'canary_timed_out'
  | 'canary_approval_not_readable'
  | 'canary_execution_not_readable'
  | 'canary_privacy_projection_failed';

export interface CanaryResult extends WebConsoleSetupCheckResult {
  readonly id: typeof CHECK_ID;
  readonly state: Exclude<WebConsoleSetupCheckState, 'not_applicable'>;
  /** Stable code for surfaces that show codes, not prose. */
  readonly code: CanaryCode;
  readonly detail: string;
}

export interface CanaryRunDependencies {
  readonly db: DatabaseInstance;
  readonly runtimeStore: IRuntimeSessionControlStore;
  readonly approvalStore: SessionApprovalStore;
  readonly executionReader: SessionExecutionReader;
  readonly gatekeeperReader: SessionGatekeeperReader;
  /** The store a live session's Gatekeeper writes approvals through, for one user and session. */
  readonly createConfirmationStore: (userId: string, sessionId: string) => IConfirmationStore;
  /** The key approval requests are bound with. A live session needs one too. */
  readonly auditHmacResolver: ConstructorParameters<typeof GatekeeperSession>[5];
  readonly replicaId: string;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

function result(state: CanaryResult['state'], code: CanaryCode, detail: string): CanaryResult {
  return { id: CHECK_ID, state, code, detail };
}

/** A fault the canary found in what the console would show. */
class CanaryFinding extends Error {
  constructor(readonly code: CanaryCode, message: string) {
    super(message);
  }
}

/**
 * Checks that approvals and executions can be read through the console, using
 * the canary user and nobody else's data.
 *
 * It opens a session for the canary, makes one real approval request and one
 * real execution record with the classes a live session uses, reads both back
 * through the console's own route handlers and privacy projectors, and removes
 * everything it made. It never approves or denies its request.
 *
 * It does not go over the network. The canary holds no credential, so there is
 * no token to open an MCP connection with; the HTTP transport, the MCP
 * handshake and the console's HTTP authentication are outside this check.
 */
export async function runCanary(deps: CanaryRunDependencies): Promise<CanaryResult> {
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CANARY_TIMEOUT_MS;
  const sessionId = `${CANARY_SESSION_PREFIX}${randomUUID()}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<CanaryResult>(resolve => {
    timer = setTimeout(
      () => resolve(result('pending', 'canary_timed_out', `The canary did not finish within ${timeoutMs / 1000} seconds, so nothing is verified.`)),
      timeoutMs,
    );
    timer.unref?.();
  });
  const attempt = (async () => {
    try {
      await sweepCanaryLeftovers(deps.db, now());
      const canary = await ensureCanaryUser(deps.db, now);
      await exercise(deps, canary, sessionId, now);
      return result('passed', 'canary_passed',
        'A canary approval request and a canary execution were created, read back through the console and removed.');
    } catch (error) {
      return describeFailure(error);
    }
  })();
  // Whatever happens, nothing the run made is left behind. Clean-up waits for
  // the run to stop touching the database, so it cannot race what it removes.
  const cleaned = attempt.then(() => removeCanarySession(deps.db, sessionId)).catch(() => undefined);
  const outcome = await Promise.race([attempt, deadline]);
  clearTimeout(timer);
  // A run that finished is cleaned up before its result is returned. One that
  // overran is not waited for: it is cleaned up when it stops, and the sweep
  // at the start of the next run covers a server that goes down first.
  if (outcome.code !== 'canary_timed_out') await cleaned;
  return outcome;
}

function describeFailure(error: unknown): CanaryResult {
  if (error instanceof CanaryFinding) return result('failed', error.code, error.message);
  if (error instanceof CanaryUserStateError) {
    return result('failed', 'canary_user_not_inert', `${error.message} The canary will not run until it is put right.`);
  }
  // The driver's message can carry connection details; only the error code is used.
  const code = getErrorCode(error);
  const reason = code ? `error ${code}` : 'an unexpected error';
  return result('pending', 'canary_could_not_run', `The canary could not complete its run (${reason}), so nothing is verified.`);
}

async function exercise(
  deps: CanaryRunDependencies,
  canary: CanaryUser,
  sessionId: string,
  now: () => Date,
): Promise<void> {
  const startedAt = now();
  await deps.runtimeStore.registerPresence({
    sessionId,
    userId: canary.userId,
    accountCorrelationId: canary.accountCorrelationId,
    replicaId: deps.replicaId,
    transport: 'streamable-http',
    startedAt,
    lastActiveAt: startedAt,
    leaseUntil: new Date(startedAt.getTime() + SESSION_LEASE_MS),
    clientInfo: { name: CANARY_CLIENT_NAME, version: 'canary' },
  });

  const approvalId = await createApprovalRequest(deps, canary.userId, sessionId);
  const goalId = await createExecution(deps.db, canary.userId, sessionId, startedAt);
  const request = canaryRequest(canary.userId, sessionId, startedAt);

  await readApprovalBack(deps, request, approvalId, now);
  await readExecutionBack(deps, request, goalId, now);
}

/** A real approval request, written through the store a live session's Gatekeeper uses. */
async function createApprovalRequest(deps: CanaryRunDependencies, userId: string, sessionId: string): Promise<string> {
  const store = deps.createConfirmationStore(userId, sessionId);
  const session = new GatekeeperSession(
    { name: CANARY_CLIENT_NAME, version: 'canary' }, undefined, undefined, store, sessionId, deps.auditHmacResolver,
  );
  await session.initialize();
  const requestId = await session.createCliApprovalRequest({
    toolName: CANARY_TOOL_NAME,
    toolInput: { canary: true },
    riskLevel: CANARY_RISK_LEVEL,
    riskScore: 0,
    irreversible: false,
    denyReason: 'Canary check: not a real request.',
    policySource: 'canary',
    ttlMs: SESSION_LEASE_MS,
  });
  // The session saves in the background. Wait, so the read-back sees it.
  await store.persist();
  return requestId;
}

/** A real execution record: one agent goal, saved through the agent state store. */
async function createExecution(db: DatabaseInstance, userId: string, sessionId: string, at: Date): Promise<string> {
  const agentId = randomUUID();
  const goalId = `canary-goal-${randomUUID().slice(0, 8)}`;
  const raw = `---\nname: ${CANARY_AGENT_PREFIX}${goalId}\ntype: agents\n---\nCanary agent. Not a real agent.`;
  await withSystemContext(db, tx => tx.insert(elements).values({
    id: agentId,
    userId,
    rawContent: raw,
    contentHash: createHash('sha256').update(raw).digest('hex'),
    byteSize: Buffer.byteLength(raw),
    elementType: 'agents',
    name: `${CANARY_AGENT_PREFIX}${goalId}`,
    metadata: {},
    visibility: 'private',
    createdAt: at,
    updatedAt: at,
  }));
  const iso = at.toISOString();
  await new DatabaseAgentStateStore(db, () => userId, () => sessionId).saveState(agentId, {
    goals: [{ id: goalId, description: CANARY_GOAL_DESCRIPTION, status: 'completed', createdAt: iso, updatedAt: iso, completedAt: iso }],
    decisions: [{ goalId, timestamp: iso, decision: 'canary step', reasoning: 'canary', outcome: 'ok' }],
    context: {},
    stateVersion: 0,
  }, 0);
  return goalId;
}

/**
 * The request a console route handler would be given for the canary. It is
 * built here and never comes from the network: the canary has no sign-in
 * identity and no console session, which is the point.
 */
function canaryRequest(userId: string, sessionId: string, receivedAt: Date): ConsoleRequest {
  return {
    params: { session_id: sessionId },
    query: {},
    body: {},
    ip: '127.0.0.1',
    get: () => undefined,
    consoleContext: { correlationId: randomUUID(), receivedAt },
    consoleAuthentication: {
      sessionIdHash: Buffer.alloc(32),
      userId,
      authSub: CANARY_CLIENT_NAME,
      authzVersion: 0,
      grantedCapabilities: ['console:self'],
      elevation: null,
    },
  } as unknown as ConsoleRequest;
}

/** Runs one of the console's own GET routes, handler then privacy projector, as the secured router would. */
async function readThroughConsole(module: ConsoleModuleDescriptor, path: string, request: ConsoleRequest): Promise<unknown> {
  const route = module.routes.find(candidate => candidate.method === 'GET' && candidate.path === path);
  if (!route) throw new Error(`console route ${path} is not registered`);
  const handled = await route.handler(request);
  if (handled.status !== 200) throw new CanaryFinding('canary_could_not_run', `The console answered ${handled.status} for ${path}.`);
  return route.privacyProjector ? route.privacyProjector(handled.body) : handled.body;
}

async function readApprovalBack(deps: CanaryRunDependencies, request: ConsoleRequest, approvalId: string, now: () => Date): Promise<void> {
  const module = createApprovalModule({ runtimeStore: deps.runtimeStore, approvalStore: deps.approvalStore, eventSink: null, now });
  let body: unknown;
  try {
    body = await readThroughConsole(module, '/api/v1/me/sessions/:session_id/approvals', request);
  } catch (error) {
    if (error instanceof CanaryFinding) throw new CanaryFinding('canary_approval_not_readable', `The canary's approval request could not be read through the console. ${error.message}`);
    throw error;
  }
  const approvals = (body as { approvals?: Record<string, unknown>[] }).approvals ?? [];
  const found = approvals.find(approval => approval.approval_id === approvalId);
  if (!found) {
    throw new CanaryFinding('canary_approval_not_readable',
      'The canary made an approval request, but the console did not list it. Pending approvals may not be displaying.');
  }
  if (found.status !== 'pending' || found.tool_name !== CANARY_TOOL_NAME || found.risk_level !== CANARY_RISK_LEVEL) {
    throw new CanaryFinding('canary_approval_not_readable',
      'The console listed the canary\'s approval request with a different status, tool or risk than it was made with.');
  }
  // What the privacy projector exists to keep out of the console.
  const leaked = ['toolInputHash', 'tool_input_hash', 'consumed', 'ttlMs', 'ttl_ms'].filter(field => field in found);
  if (leaked.length > 0) {
    throw new CanaryFinding('canary_privacy_projection_failed',
      `The console's approval listing included internal fields it should strip: ${leaked.join(', ')}.`);
  }
}

async function readExecutionBack(deps: CanaryRunDependencies, request: ConsoleRequest, goalId: string, now: () => Date): Promise<void> {
  const module = createExecutionModule({
    runtimeStore: deps.runtimeStore, executionReader: deps.executionReader, gatekeeperReader: deps.gatekeeperReader, now,
  });
  let listed: unknown;
  let detail: unknown;
  try {
    listed = await readThroughConsole(module, '/api/v1/me/sessions/:session_id/executions', request);
    detail = await readThroughConsole(module, '/api/v1/me/sessions/:session_id/executions/:goal_id',
      { ...request, params: { ...request.params, goal_id: goalId } } as unknown as ConsoleRequest);
  } catch (error) {
    if (error instanceof CanaryFinding) throw new CanaryFinding('canary_execution_not_readable', `The canary's execution could not be read through the console. ${error.message}`);
    throw error;
  }
  if (!JSON.stringify(listed).includes(goalId)) {
    throw new CanaryFinding('canary_execution_not_readable',
      'The canary recorded an execution, but the console did not list it. Executions may not be displaying.');
  }
  if (!JSON.stringify(detail).includes(goalId)) {
    throw new CanaryFinding('canary_execution_not_readable',
      'The console listed the canary\'s execution but could not show its detail.');
  }
}

/** Removes what one run made. Scoped to the canary user and one canary session, so it can match nothing else. */
export async function removeCanarySession(db: DatabaseInstance, sessionId: string): Promise<void> {
  if (!sessionId.startsWith(CANARY_SESSION_PREFIX)) throw new Error('not a canary session');
  await withSystemContext(db, async tx => {
    const agents = await tx.delete(agentStates)
      .where(and(eq(agentStates.userId, CANARY_USER_UUID), eq(agentStates.sessionId, sessionId)))
      .returning({ agentId: agentStates.agentId });
    if (agents.length > 0) {
      await tx.delete(elements)
        .where(and(inArray(elements.id, agents.map(agent => agent.agentId)), eq(elements.userId, CANARY_USER_UUID)));
    }
    await tx.delete(sessions).where(and(eq(sessions.userId, CANARY_USER_UUID), eq(sessions.sessionId, sessionId)));
    await tx.delete(runtimeSessionPresence)
      .where(and(eq(runtimeSessionPresence.userId, CANARY_USER_UUID), eq(runtimeSessionPresence.sessionId, sessionId)));
  });
}

/**
 * Removes canary records a run left behind, for instance because the server
 * stopped mid-run. Only records old enough that no run can still be using
 * them, on this replica or another, and only the canary user's.
 */
export async function sweepCanaryLeftovers(db: DatabaseInstance, now: Date): Promise<number> {
  const before = new Date(now.getTime() - CANARY_LEFTOVER_AGE_MS);
  return withSystemContext(db, async tx => {
    const stale = await tx.delete(runtimeSessionPresence)
      .where(and(
        eq(runtimeSessionPresence.userId, CANARY_USER_UUID),
        like(runtimeSessionPresence.sessionId, `${CANARY_SESSION_PREFIX}%`),
        lt(runtimeSessionPresence.startedAt, before),
      ))
      .returning({ sessionId: runtimeSessionPresence.sessionId });
    await tx.delete(sessions).where(and(
      eq(sessions.userId, CANARY_USER_UUID),
      like(sessions.sessionId, `${CANARY_SESSION_PREFIX}%`),
      sql`NOT EXISTS (SELECT 1 FROM runtime_session_presence p WHERE p.session_id = ${sessions.sessionId})`,
    ));
    await tx.delete(agentStates).where(and(
      eq(agentStates.userId, CANARY_USER_UUID),
      sql`NOT EXISTS (SELECT 1 FROM runtime_session_presence p WHERE p.session_id = ${agentStates.sessionId})`,
    ));
    await tx.delete(elements).where(and(
      eq(elements.userId, CANARY_USER_UUID),
      like(elements.name, `${CANARY_AGENT_PREFIX}%`),
      lt(elements.createdAt, before),
      sql`NOT EXISTS (SELECT 1 FROM agent_states a WHERE a.agent_id = ${elements.id})`,
    ));
    return stale.length;
  });
}
