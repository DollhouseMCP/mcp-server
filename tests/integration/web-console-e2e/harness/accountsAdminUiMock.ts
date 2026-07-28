/**
 * Browser harness for the account-governance sections inside the Users tab.
 *
 * The allowlist returns a plain `{ entries }` envelope rather than the paged
 * Family-B shape used elsewhere, and only an entry's note is mutable — the mock
 * enforces both so the UI cannot quietly rely on something the API doesn't do.
 */

import type { Page, Route } from '@playwright/test';

export interface MockAllowlistEntry {
  id: string;
  kind: string;
  value: string;
  note: string | null;
  created_by_user_id: string;
  created_at: string;
}

export interface AccountsAdminUiMockState {
  entries: MockAllowlistEntry[];
  unlinked: Array<Record<string, unknown>>;
  bootstrap: Record<string, unknown>;
  correlation: Record<string, unknown> | null;
  posts: Array<{ kind: string; value: string; note?: string }>;
  patches: Array<{ id: string; body: Record<string, unknown> }>;
  deletes: string[];
}

export async function installAccountsAdminUiMock(page: Page): Promise<AccountsAdminUiMockState> {
  const state: AccountsAdminUiMockState = {
    entries: [],
    unlinked: [{
      identity_id: 'identity-1',
      provider: 'github',
      subject: 'octocat',
      last_seen_at: '2026-07-20T09:00:00.000Z',
    }],
    bootstrap: {
      completed: true,
      completed_at: '2026-07-01T08:00:00.000Z',
      admin_user_id: 'user-admin',
    },
    correlation: { account_correlation_id: 'corr-1', user_id: 'user-admin', username: 'e2e_admin' },
    posts: [],
    patches: [],
    deletes: [],
  };
  await page.route('**/api/v1/admin/accounts/allowlist**', route => allowlistRoute(route, state));
  await page.route('**/api/v1/admin/accounts/identities/unlinked**', route =>
    route.fulfill({ status: 200, json: { items: state.unlinked, page: { limit: 50, cursor: null, next_cursor: null } } }));
  await page.route('**/api/v1/admin/accounts/bootstrap', route =>
    route.fulfill({ status: 200, json: state.bootstrap }));
  await page.route('**/api/v1/admin/accounts/correlations/**', route => correlationRoute(route, state));
  return state;
}

function allowlistRoute(route: Route, state: AccountsAdminUiMockState): Promise<void> {
  const request = route.request();
  const method = request.method();
  const id = new URL(request.url()).pathname.split('/allowlist/')[1] ?? null;

  if (method === 'GET') return route.fulfill({ status: 200, json: { entries: state.entries } });

  if (method === 'POST') {
    const body = JSON.parse(request.postData() ?? '{}') as { kind: string; value: string; note?: string };
    state.posts.push(body);
    state.entries = [...state.entries, {
      id: `allow-${state.entries.length + 1}`,
      kind: body.kind,
      value: body.value,
      note: body.note ?? null,
      created_by_user_id: 'user-admin',
      created_at: '2026-07-21T10:00:00.000Z',
    }];
    return route.fulfill({ status: 201, json: state.entries.at(-1) as Record<string, unknown> });
  }

  if (method === 'PATCH' && id) {
    const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
    state.patches.push({ id, body });
    state.entries = state.entries.map(entry =>
      entry.id === id ? { ...entry, note: (body.note as string | null) ?? null } : entry);
    return route.fulfill({ status: 200, json: state.entries.find(entry => entry.id === id) as Record<string, unknown> });
  }

  if (method === 'DELETE' && id) {
    state.deletes.push(id);
    state.entries = state.entries.filter(entry => entry.id !== id);
    return route.fulfill({ status: 204, body: '' });
  }

  return route.fulfill({ status: 404, json: { detail: 'Not found.' } });
}

function correlationRoute(route: Route, state: AccountsAdminUiMockState): Promise<void> {
  if (!state.correlation) {
    return route.fulfill({ status: 404, json: { detail: 'No account matches that correlation ID.' } });
  }
  return route.fulfill({ status: 200, json: state.correlation });
}
