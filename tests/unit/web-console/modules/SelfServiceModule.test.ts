import { describe, expect, it } from '@jest/globals';

import {
  createSelfServiceModule,
  InMemoryConsoleAccountAdminStore,
  type ConsolePrincipalSummary,
  type ConsoleRequest,
  type ConsoleRouteDefinition,
} from '../../../../src/web-console/index.js';
import { InMemoryUserConfigStore } from '../../../../src/storage/userConfig/InMemoryUserConfigStore.js';
import { UserConfigConflictError, type UserConfig } from '../../../../src/storage/userConfig/IUserConfigStore.js';

const USER_ID = '018f3d47-73ae-7f10-a0de-0742618d4fb1';
const UNKNOWN_USER_ID = '118f3d47-73ae-7f10-a0de-0742618d4fb2';
const PRIMARY_SUB = 'github_user-7';
const ACCOUNT_CORRELATION_ID = '7d0e5e89-52d0-4f88-a7bc-8f2f65a708b8';
const NOW = new Date('2026-05-28T10:00:00.000Z');
const LAST_LOGIN = new Date('2026-05-28T09:00:00.000Z');
const SELF_CAPABILITY = 'console:self';
const PROFILE_PATH = '/api/v1/me/profile';
const SETTINGS_PATH = '/api/v1/me/settings';
const SETTING_PATH = '/api/v1/me/settings/:key';
const DISPLAY_THEME_KEY = 'display_config.theme';
const WEAK_SETTINGS_ETAG_RE = /^W\/"user-settings-[A-Za-z0-9_-]+"$/;

function authenticatedContext(userId = USER_ID): NonNullable<ConsoleRequest['consoleAuthentication']> {
  return {
    sessionIdHash: Buffer.alloc(32, 7),
    userId,
    authSub: PRIMARY_SUB,
    authzVersion: 3,
    grantedCapabilities: [SELF_CAPABILITY],
    elevation: null,
  };
}

function accountStore(): InMemoryConsoleAccountAdminStore {
  return new InMemoryConsoleAccountAdminStore([principalFixture()]);
}

function principalFixture(overrides: Partial<ConsolePrincipalSummary> = {}): ConsolePrincipalSummary {
  return {
    userId: USER_ID,
    primarySub: PRIMARY_SUB,
    username: 'alice',
    displayName: 'Alice Example',
    email: 'alice@example.test',
    emailVerified: true,
    authMethods: ['github'],
    roles: ['account_admin'],
    disabledAt: null,
    createdAt: NOW,
    lastLoginAt: LAST_LOGIN,
    adminFactorEnrolled: true,
    accountCorrelationId: ACCOUNT_CORRELATION_ID,
    authzVersion: 3,
    ...overrides,
  };
}

function moduleFixture() {
  const userConfigStore = new InMemoryUserConfigStore();
  const module = createSelfServiceModule({
    accountAdminStore: accountStore(),
    userConfigStore,
    now: () => NOW,
  });
  return { module, userConfigStore };
}

function findRoute(
  routes: readonly ConsoleRouteDefinition[],
  path: string,
  method = 'GET',
): ConsoleRouteDefinition {
  const route = routes.find(candidate => candidate.path === path && candidate.method === method);
  if (!route) throw new Error(`missing route ${method} ${path}`);
  return route;
}

function consoleRequest(overrides: Partial<ConsoleRequest> = {}): ConsoleRequest {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    consoleAuthentication: authenticatedContext(),
    ...overrides,
  } as ConsoleRequest;
}

describe('SelfServiceModule', () => {
  it('registers profile and settings descriptors', () => {
    const { module } = moduleFixture();

    expect(module).toMatchObject({
      id: 'selfService',
      apiVersion: 'v1',
      capabilities: [SELF_CAPABILITY],
    });
    expect(module.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'GET',
        path: PROFILE_PATH,
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
      }),
      expect.objectContaining({
        method: 'PATCH',
        path: PROFILE_PATH,
        idempotency: 'required',
      }),
      expect.objectContaining({
        method: 'PUT',
        path: SETTING_PATH,
        idempotency: 'required',
      }),
      expect.objectContaining({
        method: 'DELETE',
        path: SETTING_PATH,
        idempotency: 'required',
      }),
    ]));
  });

  it('returns and privacy-projects the authenticated principal profile', async () => {
    const { module } = moduleFixture();
    const getProfile = findRoute(module.routes, PROFILE_PATH);

    const result = await getProfile.handler(consoleRequest());

    expect(result).toEqual({
      status: 200,
      body: {
        user_id: USER_ID,
        primary_sub: PRIMARY_SUB,
        username: 'alice',
        display_name: 'Alice Example',
        email: 'alice@example.test',
        email_verified: true,
        auth_methods: ['github'],
        roles: ['account_admin'],
        created_at: NOW.toISOString(),
        last_login_at: LAST_LOGIN.toISOString(),
      },
    });
    expect(getProfile.privacyProjector?.({
      ...(result.body as Record<string, unknown>),
      account_correlation_id: ACCOUNT_CORRELATION_ID,
      private_settings: { leaked: true },
    })).toEqual(result.body);
  });

  it('updates only display_name on the authenticated principal profile', async () => {
    const { module } = moduleFixture();
    const patchProfile = findRoute(module.routes, PROFILE_PATH, 'PATCH');

    await expect(patchProfile.handler(consoleRequest({
      body: { display_name: '  Alice Console  ' },
    }))).resolves.toMatchObject({
      status: 200,
      body: { display_name: 'Alice Console' },
    });
    await expect(patchProfile.handler(consoleRequest({
      body: { email: 'new@example.test' },
    }))).resolves.toMatchObject({
      status: 400,
      body: { code: 'invalid_request' },
    });
    await expect(patchProfile.handler(consoleRequest({
      body: { display_name: null },
    }))).resolves.toMatchObject({
      status: 200,
      body: { display_name: null },
    });
    await expect(patchProfile.handler(consoleRequest({
      body: { display_name: 'x'.repeat(256) },
    }))).resolves.toMatchObject({
      status: 422,
      body: { code: 'validation_failed' },
    });
    await expect(patchProfile.handler(consoleRequest({
      body: { display_name: '<script>alert(1)</script>' },
    }))).resolves.toMatchObject({
      status: 422,
      body: { code: 'validation_failed' },
    });
    await expect(patchProfile.handler(consoleRequest({
      body: { display_name: `Alice\u202E` },
    }))).resolves.toMatchObject({
      status: 422,
      body: { code: 'validation_failed' },
    });
    await expect(patchProfile.handler(consoleRequest({
      body: { display_name: 123 },
    }))).resolves.toMatchObject({
      status: 422,
      body: { code: 'validation_failed' },
    });
  });

  it('requires authentication and uses only session user_id for self profile routes', async () => {
    const { module } = moduleFixture();
    const getProfile = findRoute(module.routes, PROFILE_PATH);
    const patchProfile = findRoute(module.routes, PROFILE_PATH, 'PATCH');

    await expect(getProfile.handler(consoleRequest({ consoleAuthentication: undefined }))).rejects
      .toThrow('authentication middleware');
    await expect(getProfile.handler(consoleRequest({ params: { user_id: UNKNOWN_USER_ID } }))).resolves
      .toMatchObject({ status: 200, body: { user_id: USER_ID } });
    await expect(patchProfile.handler(consoleRequest({
      body: { display_name: 'Session User' },
      params: { user_id: UNKNOWN_USER_ID },
    }))).resolves.toMatchObject({
      status: 200,
      body: { user_id: USER_ID, display_name: 'Session User' },
    });
  });

  it('rejects disabled self principals defensively when middleware is bypassed', async () => {
    const accountAdminStore = new InMemoryConsoleAccountAdminStore([
      principalFixture({ disabledAt: NOW }),
    ]);
    const module = createSelfServiceModule({
      accountAdminStore,
      userConfigStore: new InMemoryUserConfigStore(),
      now: () => NOW,
    });
    const getProfile = findRoute(module.routes, PROFILE_PATH);
    const patchProfile = findRoute(module.routes, PROFILE_PATH, 'PATCH');

    await expect(getProfile.handler(consoleRequest())).resolves.toMatchObject({
      status: 403,
      body: { code: 'principal_disabled' },
    });
    await expect(patchProfile.handler(consoleRequest({
      body: { display_name: 'Disabled' },
    }))).resolves.toMatchObject({
      status: 403,
      body: { code: 'principal_disabled' },
    });
  });

  it('returns not found when the authenticated principal is missing', async () => {
    const { module } = moduleFixture();
    const getProfile = findRoute(module.routes, PROFILE_PATH);

    await expect(getProfile.handler(consoleRequest({
      consoleAuthentication: {
        ...authenticatedContext(),
        userId: UNKNOWN_USER_ID,
      },
    }))).resolves.toMatchObject({
      status: 404,
      body: { code: 'not_found' },
    });
  });

  it('reads settings documents and dotted keys with ETag headers', async () => {
    const { module, userConfigStore } = moduleFixture();
    await userConfigStore.save(USER_ID, {
      githubConfig: {},
      syncConfig: {},
      autoloadConfig: {},
      retentionConfig: {},
      wizardConfig: {},
      displayConfig: { indicators: { enabled: true } },
      collectionConfig: {},
      autoActivateConfig: {},
      sourcePriorityConfig: {},
      userIdentityConfig: {},
      configVersion: 1,
    });
    const getSettings = findRoute(module.routes, SETTINGS_PATH);
    const getSetting = findRoute(module.routes, SETTING_PATH);

    const document = await getSettings.handler(consoleRequest());
    expect(document).toMatchObject({
      status: 200,
      headers: { ETag: expect.stringMatching(WEAK_SETTINGS_ETAG_RE) },
      body: {
        display_config: { indicators: { enabled: true } },
        config_version: 1,
        etag: expect.stringMatching(WEAK_SETTINGS_ETAG_RE),
      },
    });
    const otherUserDefault = await getSettings.handler(consoleRequest({
      consoleAuthentication: authenticatedContext(UNKNOWN_USER_ID),
    }));
    expect((otherUserDefault.body as { etag: string }).etag).not.toBe((document.body as { etag: string }).etag);

    await expect(getSetting.handler(consoleRequest({
      params: { key: 'display_config.indicators.enabled' },
    }))).resolves.toMatchObject({
      status: 200,
      body: {
        key: 'display_config.indicators.enabled',
        value: true,
      },
    });
  });

  it('enforces If-Match for settings mutations and rejects stale ETags', async () => {
    const { module } = moduleFixture();
    const getSettings = findRoute(module.routes, SETTINGS_PATH);
    const putSetting = findRoute(module.routes, SETTING_PATH, 'PUT');
    const initial = await getSettings.handler(consoleRequest());
    const etag = (initial.body as { etag: string }).etag;

    await expect(putSetting.handler(consoleRequest({
      params: { key: DISPLAY_THEME_KEY },
      body: { value: 'dark' },
    }))).resolves.toMatchObject({
      status: 428,
      body: { code: 'precondition_required' },
    });
    await expect(putSetting.handler(consoleRequest({
      params: { key: DISPLAY_THEME_KEY },
      headers: { 'if-match': '"stale"' },
      body: { value: 'dark' },
    }))).resolves.toMatchObject({
      status: 412,
      body: { code: 'precondition_failed' },
    });
    await expect(putSetting.handler(consoleRequest({
      params: { key: DISPLAY_THEME_KEY },
      headers: { 'if-match': etag },
      body: { value: 'dark' },
    }))).resolves.toMatchObject({
      status: 200,
      body: {
        key: DISPLAY_THEME_KEY,
        value: 'dark',
      },
    });
    await expect(putSetting.handler(consoleRequest({
      params: { key: DISPLAY_THEME_KEY },
      headers: { 'if-match': etag },
      body: { value: 'light' },
    }))).resolves.toMatchObject({
      status: 412,
      body: { code: 'precondition_failed' },
    });
  });

  it('maps store-level compare-and-swap conflicts to stale precondition responses', async () => {
    class ConflictingStore extends InMemoryUserConfigStore {
      override async save(
        userId: string,
        config: Omit<UserConfig, 'updatedAt'> & { updatedAt?: number },
        options?: { readonly expectedUpdatedAt?: number },
      ): Promise<void> {
        await super.save(userId, config, options);
        throw new UserConfigConflictError();
      }
    }
    const module = createSelfServiceModule({
      accountAdminStore: accountStore(),
      userConfigStore: new ConflictingStore(),
      now: () => NOW,
    });
    const getSettings = findRoute(module.routes, SETTINGS_PATH);
    const putSetting = findRoute(module.routes, SETTING_PATH, 'PUT');
    const initial = await getSettings.handler(consoleRequest());

    await expect(putSetting.handler(consoleRequest({
      params: { key: DISPLAY_THEME_KEY },
      headers: { 'if-match': (initial.body as { etag: string }).etag },
      body: { value: 'dark' },
    }))).resolves.toMatchObject({
      status: 412,
      body: { code: 'precondition_failed' },
    });
  });

  it('resets setting paths and rejects invalid settings keys and values', async () => {
    const { module } = moduleFixture();
    const getSettings = findRoute(module.routes, SETTINGS_PATH);
    const putSetting = findRoute(module.routes, SETTING_PATH, 'PUT');
    const deleteSetting = findRoute(module.routes, SETTING_PATH, 'DELETE');
    const initial = await getSettings.handler(consoleRequest());
    const etag = (initial.body as { etag: string }).etag;

    await expect(putSetting.handler(consoleRequest({
      params: { key: 'unknown_config.theme' },
      headers: { 'if-match': etag },
      body: { value: 'dark' },
    }))).resolves.toMatchObject({ status: 404, body: { code: 'not_found' } });
    await expect(putSetting.handler(consoleRequest({
      params: { key: DISPLAY_THEME_KEY },
      headers: { 'if-match': etag },
      body: { value: undefined },
    }))).resolves.toMatchObject({ status: 422, body: { code: 'validation_failed' } });
    const put = await putSetting.handler(consoleRequest({
      params: { key: DISPLAY_THEME_KEY },
      headers: { 'if-match': etag },
      body: { value: 'dark' },
    }));
    const nextEtag = (put.body as { etag: string }).etag;

    await expect(putSetting.handler(consoleRequest({
      params: { key: 'display_config.theme.palette' },
      headers: { 'if-match': nextEtag },
      body: { value: 'blue' },
    }))).resolves.toMatchObject({ status: 422, body: { code: 'validation_failed' } });
    await expect(deleteSetting.handler(consoleRequest({
      params: { key: DISPLAY_THEME_KEY },
    }))).resolves.toMatchObject({
      status: 428,
      body: { code: 'precondition_required' },
    });
    await expect(deleteSetting.handler(consoleRequest({
      params: { key: DISPLAY_THEME_KEY },
      headers: { 'if-match': etag },
    }))).resolves.toMatchObject({
      status: 412,
      body: { code: 'precondition_failed' },
    });
    await expect(deleteSetting.handler(consoleRequest({
      params: { key: DISPLAY_THEME_KEY },
      headers: { 'if-match': nextEtag },
    }))).resolves.toMatchObject({
      status: 200,
      body: {
        key: DISPLAY_THEME_KEY,
        value: null,
      },
    });

    const final = await findRoute(module.routes, SETTINGS_PATH).handler(consoleRequest());
    await expect(deleteSetting.handler(consoleRequest({
      params: { key: DISPLAY_THEME_KEY },
      headers: { 'if-match': (final.body as { etag: string }).etag },
    }))).resolves.toMatchObject({
      status: 200,
      body: {
        key: DISPLAY_THEME_KEY,
        value: null,
      },
    });
  });

  it('replaces and resets entire settings sections with ETag preconditions', async () => {
    const { module } = moduleFixture();
    const getSettings = findRoute(module.routes, SETTINGS_PATH);
    const putSetting = findRoute(module.routes, SETTING_PATH, 'PUT');
    const deleteSetting = findRoute(module.routes, SETTING_PATH, 'DELETE');
    const initial = await getSettings.handler(consoleRequest());

    const put = await putSetting.handler(consoleRequest({
      params: { key: 'display_config' },
      headers: { 'if-match': (initial.body as { etag: string }).etag },
      body: { value: { theme: 'dark' } },
    }));
    expect(put).toMatchObject({
      status: 200,
      body: { key: 'display_config', value: { theme: 'dark' } },
    });

    await expect(deleteSetting.handler(consoleRequest({
      params: { key: 'display_config' },
      headers: { 'if-match': (put.body as { etag: string }).etag },
    }))).resolves.toMatchObject({
      status: 200,
      body: { key: 'display_config', value: {} },
    });
  });
});
