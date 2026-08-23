/**
 * Browser harness for the audit workspace.
 *
 * Models the two backend properties the UI is built around: cursor-only
 * pagination with no filter parameters, and a stricter elevation tier on the
 * detail and export routes than on the lists. `detailStatus` / `exportStatus`
 * let a test reproduce the case where a list loads but a drill-in does not.
 */

import type { Page, Route } from '@playwright/test';

export interface MockAdminAuditEvent {
  id: string;
  occurred_at: string;
  actor_sub: string;
  actor_user_id: string;
  actor_capability_role: string;
  capability: string;
  operation: string;
  endpoint: string;
  result: string;
  error_code: string | null;
  target_user_id: string | null;
  resource_kind: string | null;
  resource_id: string | null;
  correlation_id: string;
  client_ip: string | null;
  args_redacted: Record<string, unknown>;
  result_detail_redacted: Record<string, unknown> | null;
  integrity: { status: string; reason: string | null };
}

export interface AuditUiMockState {
  adminEvents: MockAdminAuditEvent[];
  approvalEvents: Array<Record<string, unknown>>;
  authenticationEvents: Array<Record<string, unknown>>;
  /** Records the export stream emits before its terminal `end` frame. */
  exportRecords: number;
  /**
   * When false the stream stops without its terminal frame, the way a connection
   * dropped mid-export would. The run stays open, which is what makes cancelling
   * an in-progress export testable.
   */
  exportTerminates: boolean;
  /** Set to 401 to model an elevation that satisfies the lists but not the detail. */
  detailStatus: number;
  /** Set to 401 to model the list itself being refused. */
  listStatus: number;
  /** Set to 401 to model the same for the export. */
  exportStatus: number;
  listReads: number;
  detailReads: number;
  exportReads: number;
}

export async function installAuditUiMock(page: Page): Promise<AuditUiMockState> {
  const state: AuditUiMockState = {
    adminEvents: Array.from({ length: 75 }, (_, index) => adminEvent(index)),
    approvalEvents: [approvalEvent('verified'), approvalEvent('not_available')],
    authenticationEvents: [authenticationEvent()],
    exportRecords: 3,
    exportTerminates: true,
    detailStatus: 200,
    listStatus: 200,
    exportStatus: 200,
    listReads: 0,
    detailReads: 0,
    exportReads: 0,
  };
  await page.route('**/api/v1/admin/audit/**', route => handleRoute(route, state));
  return state;
}

function handleRoute(route: Route, state: AuditUiMockState): Promise<void> {
  const url = new URL(route.request().url());
  const path = url.pathname.replace('/api/v1/admin/audit', '');

  if (path === '/admin/export') {
    state.exportReads += 1;
    if (state.exportStatus !== 200) return problem(route, state.exportStatus, 'step_up_required');
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: exportBody(state),
    });
  }

  const detail = /^\/(admin|approvals)\/(.+)$/.exec(path);
  if (detail) {
    state.detailReads += 1;
    if (state.detailStatus !== 200) return problem(route, state.detailStatus, 'step_up_required');
    const pool = detail[1] === 'admin' ? state.adminEvents : state.approvalEvents;
    const record = pool.find(item => (item as { id: string }).id === detail[2]);
    if (!record) return problem(route, 404, 'not_found');
    return route.fulfill({ status: 200, json: record as Record<string, unknown> });
  }

  state.listReads += 1;
  if (state.listStatus !== 200) return problem(route, state.listStatus, 'step_up_required');
  return route.fulfill({ status: 200, json: page_(listPool(path, state), url) as unknown as Record<string, unknown> });
}

function listPool(path: string, state: AuditUiMockState): Array<Record<string, unknown>> {
  if (path === '/approvals') return state.approvalEvents;
  if (path === '/authentication') return state.authenticationEvents;
  return state.adminEvents;
}

/** Cursor is an opaque offset here, mirroring the server's opaque cursor contract. */
function page_(pool: Array<Record<string, unknown>>, url: URL) {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 100);
  const cursor = url.searchParams.get('cursor');
  const offset = cursor ? Number(cursor) || 0 : 0;
  const items = pool.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    items,
    page: {
      limit,
      cursor,
      next_cursor: nextOffset < pool.length ? String(nextOffset) : null,
    },
  };
}

function exportBody(state: AuditUiMockState): string {
  const frames = [
    frame('init', {
      stream_id: 'admin.audit.admin.export',
      stream_type: 'admin_audit_export',
      resume_supported: false,
      cursor: null,
      batch_size: 100,
    }),
    ...Array.from({ length: state.exportRecords }, (_, index) => frame('update', adminEvent(index))),
    ...(state.exportTerminates ? [frame('end', { status: 'complete' })] : []),
  ];
  return frames.join('');
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function problem(route: Route, status: number, code: string): Promise<void> {
  return route.fulfill({
    status,
    json: { type: `https://dollhousemcp.com/errors/${code}`, code, title: 'Error', status, detail: 'Elevation required.' },
  });
}

function adminEvent(index: number): MockAdminAuditEvent {
  // Alternate integrity so the list always shows both a verified and an
  // unverifiable record without a test having to construct one.
  const broken = index % 3 === 2;
  return {
    id: `admin-audit-${index}`,
    occurred_at: new Date(Date.UTC(2026, 6, 20, 12, 0, index % 60)).toISOString(),
    actor_sub: 'e2e_admin',
    actor_user_id: 'user-admin',
    actor_capability_role: 'account_admin',
    capability: 'console:admin:accounts',
    operation: index % 2 === 0 ? 'accounts.users.list' : 'accounts.roles.grant',
    endpoint: 'GET /api/v1/admin/accounts/users',
    result: 'approved',
    error_code: null,
    target_user_id: null,
    resource_kind: null,
    resource_id: null,
    correlation_id: `corr-${index}`,
    client_ip: '127.0.0.1',
    args_redacted: { role: '[redacted]' },
    result_detail_redacted: null,
    integrity: broken
      ? { status: 'failed', reason: 'chain_hmac_mismatch' }
      : { status: 'verified', reason: null },
  };
}

function approvalEvent(integrityStatus: string): Record<string, unknown> {
  return {
    id: `approval-audit-${integrityStatus}`,
    occurred_at: '2026-07-20T12:05:00.000Z',
    account_correlation_id: 'corr-account',
    session_id: 'session-1',
    tool_name: 'mcp_aql_read',
    operation: 'read',
    result: 'approved',
    decision_source: 'console',
    correlation_id: 'corr-approval',
    integrity: integrityStatus === 'verified'
      ? { status: 'verified', chain_key_id: 'key-1', chain_prev: null, chain_hmac: 'abc' }
      : { status: 'not_available', chain_key_id: null, chain_prev: null, chain_hmac: null },
  };
}

function authenticationEvent(): Record<string, unknown> {
  return {
    id: 'auth-audit-1',
    occurred_at: '2026-07-20T12:10:00.000Z',
    event: 'login',
    actor_user_id: 'user-admin',
    actor_sub: 'e2e_admin',
    capability: null,
    elevation_acr: null,
    elevation_amr: [],
    result: 'success',
    error_code: null,
    correlation_id: 'corr-auth',
    client_ip: '127.0.0.1',
    user_agent: 'e2e',
  };
}
