import type { IUserConfigStore } from '../../../storage/userConfig/IUserConfigStore.js';
import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import type { IConsoleAccountAdminStore } from '../../stores/IConsoleAccountAdminStore.js';
import { SelfServiceProfileService } from './SelfServiceProfileService.js';
import { SelfServiceSettingsService } from './SelfServiceSettingsService.js';
import {
  projectSelfProfile,
  projectSelfSetting,
  projectSelfSettings,
} from './SelfServicePrivacyProjectors.js';

const SELF_CAPABILITY = 'console:self';

export interface SelfServiceModuleOptions {
  readonly accountAdminStore: IConsoleAccountAdminStore;
  readonly userConfigStore: IUserConfigStore;
  readonly now?: () => Date;
}

export function createSelfServiceModule(options: SelfServiceModuleOptions): ConsoleModuleDescriptor {
  const profileService = new SelfServiceProfileService(options.accountAdminStore, options.now);
  const settingsService = new SelfServiceSettingsService(options.userConfigStore);
  const routes: ConsoleModuleDescriptor['routes'] = [
    {
      method: 'GET',
      path: '/api/v1/me/profile',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      privacyProjector: projectSelfProfile,
      handler: req => profileService.getProfile(req),
    },
    {
      method: 'PATCH',
      path: '/api/v1/me/profile',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      privacyProjector: projectSelfProfile,
      handler: req => profileService.patchProfile(req),
    },
    {
      method: 'GET',
      path: '/api/v1/me/settings',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      privacyProjector: projectSelfSettings,
      handler: req => settingsService.getSettings(req),
    },
    {
      method: 'GET',
      path: '/api/v1/me/settings/:key',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'not_applicable',
      privacyProjector: projectSelfSetting,
      handler: req => withSettingKey(req, key => settingsService.getSetting(req, key)),
    },
    {
      method: 'PUT',
      path: '/api/v1/me/settings/:key',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      privacyProjector: projectSelfSetting,
      handler: req => withSettingKey(req, key => settingsService.putSetting(req, key)),
    },
    {
      method: 'DELETE',
      path: '/api/v1/me/settings/:key',
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_private',
      idempotency: 'required',
      privacyProjector: projectSelfSetting,
      handler: req => withSettingKey(req, key => settingsService.deleteSetting(req, key)),
    },
  ];
  return {
    id: 'selfService',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    events: [
      { type: 'profile.updated.v1', schemaId: 'profile.updated.v1' },
      { type: 'settings.updated.v1', schemaId: 'settings.updated.v1' },
    ],
    routes,
  };
}

function withSettingKey(
  req: ConsoleRequest,
  action: (key: string) => Promise<ConsoleHandlerResult>,
): Promise<ConsoleHandlerResult> | ConsoleHandlerResult {
  const key = req.params.key;
  if (typeof key !== 'string' || key.trim() === '') {
    return {
      status: 400,
      body: {
        type: 'about:blank',
        title: 'Invalid request',
        status: 400,
        code: 'invalid_request',
        detail: 'key path parameter is required.',
      },
    };
  }
  return action(key);
}
