/**
 * Browser harness for security administration.
 *
 * Models the parts of the contract the UI has to respect: mutations sit on a
 * stricter elevation tier than reads, the auth policy is ETag-guarded with only
 * one editable field, and deleting a key is refused while it is inside its
 * hard-delete grace unless the request explicitly forces it.
 */

import type { Page, Route } from '@playwright/test';

export interface SecurityAdminUiMockState {
  /** Set to 401 to model an elevation that satisfies reads but not mutations. */
  mutationStatus: number;
  /** Set to 412 to model the policy changing under the operator. */
  policyPutStatus: number;
  policy: {
    max_admin_elevation_seconds: number;
    updated_at: string;
    etag: string;
  };
  /** Refuse the un-forced delete once, the way a key inside grace would. */
  deleteRefusesWithoutForce: boolean;
  rotateCalls: number;
  retireCalls: number;
  deleteCalls: Array<{ forced: boolean }>;
  policyPuts: Array<{ ifMatch: string | null; seconds: number }>;
}

export async function installSecurityAdminUiMock(page: Page): Promise<SecurityAdminUiMockState> {
  const state: SecurityAdminUiMockState = {
    mutationStatus: 200,
    policyPutStatus: 200,
    policy: {
      max_admin_elevation_seconds: 1800,
      updated_at: '2026-07-20T10:00:00.000Z',
      etag: 'W/"security-auth-policy:1:1800"',
    },
    deleteRefusesWithoutForce: true,
    rotateCalls: 0,
    retireCalls: 0,
    deleteCalls: [],
    policyPuts: [],
  };
  await page.route('**/api/v1/admin/security/**', route => handleRoute(route, state));
  return state;
}

function handleRoute(route: Route, state: SecurityAdminUiMockState): Promise<void> {
  const request = route.request();
  const method = request.method();
  const path = new URL(request.url()).pathname.replace('/api/v1/admin/security', '');

  if (path === '/auth-policy') {
    if (method === 'GET') return route.fulfill({ status: 200, json: policyDto(state) });
    return putPolicy(route, state);
  }

  if (path === '/signing-keys' && method === 'GET') {
    return route.fulfill({ status: 200, json: keyList(state) });
  }
  return signingKeyMutation(route, state, method, path);
}

function signingKeyMutation(
  route: Route,
  state: SecurityAdminUiMockState,
  method: string,
  path: string,
): Promise<void> {
  const isMutation = (method === 'POST' && (path.endsWith('/rotate') || path.endsWith('/retire')))
    || method === 'DELETE';
  if (!isMutation) return route.fulfill({ status: 404, json: problemBody('not_found', 'Not found.') });
  if (state.mutationStatus !== 200) return stepUp(route, state.mutationStatus);

  if (path.endsWith('/rotate')) {
    state.rotateCalls += 1;
    return route.fulfill({ status: 200, json: receipt('rotate', null, 'jwks-key-new') });
  }
  if (path.endsWith('/retire')) {
    state.retireCalls += 1;
    return route.fulfill({ status: 200, json: receipt('retire', 'jwks-key-old', null) });
  }

  const forced = requestForces(route.request().postData());
  state.deleteCalls.push({ forced });
  if (!forced && state.deleteRefusesWithoutForce) {
    return route.fulfill({
      status: 409,
      json: problemBody('conflict', 'Signing key is still within hard-delete grace.'),
    });
  }
  return route.fulfill({ status: 200, json: receipt('delete', 'jwks-key-old', null) });
}

async function putPolicy(route: Route, state: SecurityAdminUiMockState): Promise<void> {
  if (state.mutationStatus !== 200) return stepUp(route, state.mutationStatus);
  const ifMatch = route.request().headers()['if-match'] ?? null;
  const body = JSON.parse(route.request().postData() ?? '{}') as { max_admin_elevation_seconds?: number };
  state.policyPuts.push({ ifMatch, seconds: Number(body.max_admin_elevation_seconds) });

  if (!ifMatch) {
    return route.fulfill({ status: 428, json: problemBody('precondition_required', 'Missing If-Match header.') });
  }
  if (state.policyPutStatus === 412 || ifMatch !== state.policy.etag) {
    return route.fulfill({ status: 412, json: problemBody('precondition_failed', 'Auth policy changed before this request.') });
  }
  state.policy = {
    max_admin_elevation_seconds: Number(body.max_admin_elevation_seconds),
    updated_at: '2026-07-21T09:00:00.000Z',
    etag: `W/"security-auth-policy:2:${body.max_admin_elevation_seconds}"`,
  };
  return route.fulfill({ status: 200, json: policyDto(state) });
}

/** The service accepts either flag, so the harness has to treat both as forcing. */
function requestForces(postData: string | null): boolean {
  if (!postData) return false;
  try {
    const body = JSON.parse(postData) as Record<string, unknown>;
    return body.force === true || body.emergency === true;
  } catch {
    return false;
  }
}

function policyDto(state: SecurityAdminUiMockState): Record<string, unknown> {
  return {
    require_admin_totp: true,
    csrf_protection: true,
    bff_session_security: true,
    step_up_required: true,
    privacy_boundaries_enforced: true,
    ...state.policy,
  };
}

function keyList(state: SecurityAdminUiMockState): Record<string, unknown> {
  const retired = state.deleteCalls.length > 0 || state.retireCalls > 0;
  return {
    kinds: [
      {
        kind: 'jwks',
        active_kid: 'jwks-key-active',
        keys: [
          key('jwks', 'jwks-key-active', 'active'),
          key('jwks', 'jwks-key-old', retired ? 'retired' : 'verifying'),
        ],
      },
      { kind: 'cookie', active_kid: null, keys: [] },
    ],
  };
}

function key(kind: string, kid: string, state: string): Record<string, unknown> {
  return {
    kind,
    kid,
    state,
    created_at: '2026-07-01T10:00:00.000Z',
    rotated_at: null,
    retired_at: state === 'retired' ? '2026-07-20T10:00:00.000Z' : null,
    deleted_at: null,
    verification_grace_ends_at: state === 'verifying' ? '2026-07-25T10:00:00.000Z' : null,
  };
}

function receipt(action: string, targetKid: string | null, resultKid: string | null): Record<string, unknown> {
  return {
    id: `job-${action}`,
    kind: 'jwks',
    action,
    status: 'completed',
    created_at: '2026-07-21T09:00:00.000Z',
    completed_at: '2026-07-21T09:00:01.000Z',
    target_kid: targetKid,
    result_kid: resultKid,
    error_code: null,
  };
}

function stepUp(route: Route, status: number): Promise<void> {
  return route.fulfill({
    status,
    json: {
      type: 'https://dollhousemcp.com/errors/step_up_required',
      code: 'step_up_required',
      title: 'Step up required',
      status,
      detail: 'Fresh elevation required.',
      extensions: { required_capability: 'console:admin:security' },
    },
  });
}

function problemBody(code: string, detail: string): Record<string, unknown> {
  return { type: `https://dollhousemcp.com/errors/${code}`, code, title: 'Error', detail };
}
