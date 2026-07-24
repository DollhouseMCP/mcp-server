import type { Page, Route } from '@playwright/test';

export const SESSION_UI_ID = '11111111-1111-4111-8111-111111111111';
const GOAL_ID = 'goal-session-ui';
const APPROVE_APPROVAL_ID = 'cli-22222222-2222-4222-8222-222222222222';
const DENY_APPROVAL_ID = 'cli-44444444-4444-4444-8444-444444444444';

type CommandOutcome = 'terminated' | 'failed';

export interface SessionUiMockState {
  approvalReads: number;
  commandReads: number;
  detailUnavailable: boolean;
  setActivations(names: readonly string[]): void;
}

export async function installSessionUiMock(
  page: Page,
  options: {
    detailUnavailable?: boolean;
    commandOutcome?: CommandOutcome;
    bulkRequestFails?: boolean;
  } = {},
): Promise<SessionUiMockState> {
  let activations = [activation('alpha-persona')];
  const state: SessionUiMockState = {
    approvalReads: 0,
    commandReads: 0,
    detailUnavailable: options.detailUnavailable ?? false,
    setActivations: names => { activations = names.map(name => activation(name)); },
  };
  const approvalStatuses = new Map([
    [APPROVE_APPROVAL_ID, 'pending'],
    [DENY_APPROVAL_ID, 'pending'],
  ]);
  await page.route('**/api/v1/me/sessions**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const reply = responseFor(method, path, state, {
      approvalStatuses,
      activations,
      commandOutcome: options.commandOutcome ?? 'terminated',
      bulkRequestFails: options.bulkRequestFails ?? false,
      setApprovalStatus: (approvalId, value) => { approvalStatuses.set(approvalId, value); },
      setActivations: value => { activations = value; },
    });
    await fulfill(route, reply.status, reply.body);
  });
  return state;
}

interface MutableMockData {
  approvalStatuses: ReadonlyMap<string, string>;
  activations: Array<Record<string, unknown>>;
  commandOutcome: CommandOutcome;
  bulkRequestFails: boolean;
  setApprovalStatus(approvalId: string, value: string): void;
  setActivations(value: Array<Record<string, unknown>>): void;
}

function responseFor(method: string, path: string, state: SessionUiMockState, data: MutableMockData) {
  const base = `/api/v1/me/sessions/${SESSION_UI_ID}`;
  if (state.detailUnavailable && path.startsWith(base)) return missing();
  if (method === 'GET') return getResponse(path, base, state, data);
  if (method === 'POST') return postResponse(path, base, data);
  if (method === 'DELETE') return deleteResponse(path, base, data);
  return missing();
}

function getResponse(path: string, base: string, state: SessionUiMockState, data: MutableMockData) {
  if (path === '/api/v1/me/sessions') return ok({ sessions: [session()] });
  if (path === base) return ok(session());
  if (path === `${base}/activations`) return ok({ activations: data.activations });
  if (path === `${base}/approvals`) {
    state.approvalReads += 1;
    return ok({ approvals: [
      approval(APPROVE_APPROVAL_ID, data.approvalStatuses.get(APPROVE_APPROVAL_ID) ?? 'pending', 'install_collection_content'),
      approval(DENY_APPROVAL_ID, data.approvalStatuses.get(DENY_APPROVAL_ID) ?? 'pending', 'delete_element'),
    ] });
  }
  if (path === `${base}/executions`) return ok({ executions: [execution()] });
  if (path === `${base}/executions/${GOAL_ID}`) return ok(executionDetail());
  if (path === `${base}/gatekeeper`) return ok(gatekeeper());
  if (path === `${base}/logs`) return ok({ items: [activity()] });
  if (path === `${base}/metrics`) return ok({ checked_at: new Date().toISOString(), metrics: [metric()] });
  if (path.includes('/commands/')) {
    state.commandReads += 1;
    return ok(commandStatus(state.commandReads > 1 ? data.commandOutcome : 'pending'));
  }
  return missing();
}

function postResponse(path: string, base: string, data: MutableMockData) {
  if (path === '/api/v1/me/sessions/revoke-all') {
    if (data.bulkRequestFails) {
      return { status: 503, body: { code: 'service_unavailable' } };
    }
    return {
      status: 202,
      body: {
        requested: 1,
        commands: [{
          session_id: SESSION_UI_ID,
          command_id: '33333333-3333-4333-8333-333333333333',
          status: 'accepted',
        }],
      },
    };
  }
  if (path === `${base}/activations`) {
    const updated = [activation('beta-skill', 'skills')];
    data.setActivations(updated);
    return ok(updated[0]);
  }
  const approvalPath = `${base}/approvals/`;
  if (path.startsWith(approvalPath)) {
    const [approvalId, decision] = path.slice(approvalPath.length).split('/');
    if (approvalId && decision === 'approve') {
      data.setApprovalStatus(approvalId, 'approved');
      return ok(approval(approvalId, 'approved', approvalToolName(approvalId)));
    }
    if (approvalId && decision === 'deny') {
      data.setApprovalStatus(approvalId, 'denied');
      return ok(approval(approvalId, 'denied', approvalToolName(approvalId)));
    }
  }
  return missing();
}

function deleteResponse(path: string, base: string, data: MutableMockData) {
  if (path === base) {
    return { status: 202, body: { command_id: '33333333-3333-4333-8333-333333333333', status: 'accepted' } };
  }
  if (path.startsWith(`${base}/activations/`)) {
    data.setActivations([]);
    return ok({ deactivated: true });
  }
  return missing();
}

async function fulfill(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

function ok(body: unknown) {
  return { status: 200, body };
}

function missing() {
  return { status: 404, body: { code: 'not_found', detail: 'Runtime session was not found.' } };
}

function session() {
  const now = new Date().toISOString();
  return {
    session_id: SESSION_UI_ID,
    transport: 'streamable-http',
    client_info: { name: 'Claude Code', version: '1.2.3' },
    created_at: now,
    last_active_at: now,
    request_count: 12,
    error_count: 1,
    status: 'active',
  };
}

function activation(name: string, type = 'personas') {
  return { type, name, display_name: name, activated_at: new Date().toISOString() };
}

function approval(approvalId: string, status: string, toolName: string) {
  const now = new Date();
  return {
    approval_id: approvalId,
    session_id: SESSION_UI_ID,
    status,
    tool_name: toolName,
    tool_input_digest: { collection_path: 'library/skills/example' },
    tool_input_detail: null,
    risk_level: 'medium',
    risk_score: 45,
    irreversible: false,
    reason: 'Installing portfolio content requires confirmation.',
    policy_source: 'session_policy',
    scope: 'once',
    requested_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 300_000).toISOString(),
    decided_at: status === 'pending' ? null : now.toISOString(),
  };
}

function approvalToolName(approvalId: string) {
  return approvalId === DENY_APPROVAL_ID ? 'delete_element' : 'install_collection_content';
}

function execution() {
  const now = new Date().toISOString();
  return {
    goal_id: GOAL_ID,
    session_id: SESSION_UI_ID,
    agent_name: 'release-helper',
    status: 'running',
    progress: 50,
    started_at: now,
    updated_at: now,
    completed_at: null,
    current_step: 'Validate package',
    stable_error_code: null,
  };
}

function executionDetail() {
  return {
    ...execution(),
    output: [{ kind: 'progress', message: 'Package validation started.', occurred_at: new Date().toISOString() }],
  };
}

function gatekeeper() {
  return {
    session_id: SESSION_UI_ID,
    permission_prompt_active: true,
    confirmation_count: 1,
    pending_approval_count: 1,
    retained_approval_count: 0,
    client: { name: 'Claude Code', version: '1.2.3' },
    confirmations: [{ operation: 'read', element_type: 'skills', scope: 'session', confirmed_at: new Date().toISOString(), use_count: 2 }],
    pending_approvals: [],
  };
}

function activity() {
  return {
    ts: new Date().toISOString(),
    session_id: SESSION_UI_ID,
    level: 'info',
    subsystem: 'runtime',
    event: 'request.completed',
    message: 'Request completed.',
    correlation_id: null,
    stable_error_code: null,
  };
}

function metric() {
  return { name: 'requests.total', kind: 'counter', value: 12, unit: 'requests', dimensions: {} };
}

function commandStatus(status: 'pending' | CommandOutcome) {
  return {
    command_id: '33333333-3333-4333-8333-333333333333',
    status,
    acknowledged_at: status === 'pending' ? null : new Date().toISOString(),
    replica_id: status === 'terminated' ? 'replica-e2e' : null,
    error_code: status === 'failed' ? 'session_disconnect_failed' : null,
  };
}
