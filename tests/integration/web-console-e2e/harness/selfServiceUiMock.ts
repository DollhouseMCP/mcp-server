import type { Page, Route } from '@playwright/test';

import { mutationProtocolProblem, preconditionProblem } from './requestProtocolMock.js';

export interface SelfServiceUiMockState {
  displayName: string | null;
  theme: unknown;
  settingsWrites: number;
}

export async function installSelfServiceUiMock(
  page: Page,
  options: { conflictOnFirstSettingsWrite?: boolean; initialTheme?: unknown } = {},
): Promise<SelfServiceUiMockState> {
  const state: SelfServiceUiMockState = {
    displayName: 'E2E Admin',
    theme: options.initialTheme ?? 'light',
    settingsWrites: 0,
  };
  let settingsVersion = 1;
  await page.route('**/api/v1/me/profile', route => handleProfile(route, state));
  await page.route('**/api/v1/me/settings**', async route => {
    const request = route.request();
    const method = request.method();
    if (method === 'GET') {
      await fulfill(route, 200, settings(state, settingsVersion), settingsEtag(settingsVersion));
      return;
    }
    const protocolProblem = mutationProtocolProblem(request.headers());
    if (protocolProblem) {
      await fulfill(route, protocolProblem.status, protocolProblem.body);
      return;
    }
    state.settingsWrites += 1;
    if (options.conflictOnFirstSettingsWrite && state.settingsWrites === 1) {
      state.theme = 'dark';
      settingsVersion += 1;
    }
    const concurrencyProblem = preconditionProblem(request.headers(), settingsEtag(settingsVersion));
    if (concurrencyProblem) {
      await fulfill(route, concurrencyProblem.status, concurrencyProblem.body);
      return;
    }
    if (method === 'PUT') {
      const body = request.postDataJSON() as { value?: unknown } | null;
      state.theme = typeof body?.value === 'string' ? body.value : null;
    } else if (method === 'DELETE') {
      state.theme = null;
    }
    settingsVersion += 1;
    await fulfill(route, 200, {
      key: 'display_config.theme',
      value: state.theme,
      updated_at: Date.now(),
      etag: settingsEtag(settingsVersion),
    }, settingsEtag(settingsVersion));
  });
  return state;
}

async function handleProfile(route: Route, state: SelfServiceUiMockState) {
  const request = route.request();
  if (request.method() === 'PATCH') {
    const protocolProblem = mutationProtocolProblem(request.headers());
    if (protocolProblem) {
      await fulfill(route, protocolProblem.status, protocolProblem.body);
      return;
    }
    const body = request.postDataJSON() as { display_name?: unknown } | null;
    state.displayName = typeof body?.display_name === 'string' ? body.display_name : null;
  }
  await fulfill(route, 200, profile(state));
}

function profile(state: SelfServiceUiMockState) {
  return {
    user_id: '22222222-2222-4222-8222-222222222222',
    primary_sub: 'local_e2e_admin',
    username: 'e2e_admin',
    display_name: state.displayName,
    email: 'e2e@example.test',
    email_verified: true,
    auth_methods: ['password'],
    roles: ['admin'],
    created_at: new Date().toISOString(),
    last_login_at: new Date().toISOString(),
  };
}

function settings(state: SelfServiceUiMockState, version: number) {
  return {
    github_config: {},
    sync_config: {},
    autoload_config: {},
    retention_config: {},
    wizard_config: {},
    display_config: state.theme === null ? {} : { theme: state.theme },
    collection_config: {},
    auto_activate_config: {},
    source_priority_config: {},
    user_identity_config: {},
    config_version: version,
    updated_at: Date.now(),
    etag: settingsEtag(version),
  };
}

function settingsEtag(version: number) {
  return `W/"settings-${version}"`;
}

async function fulfill(route: Route, status: number, body: unknown, etag?: string) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: etag ? { etag } : undefined,
    body: JSON.stringify(body),
  });
}
