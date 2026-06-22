/**
 * User Config Storage — barrel export.
 *
 * @module storage/userConfig
 */

export {
  type IUserConfigStore,
  type UserConfig,
  DEFAULT_USER_CONFIG,
} from './IUserConfigStore.js';
export { InMemoryUserConfigStore } from './InMemoryUserConfigStore.js';
export { FilesystemUserConfigStore } from './FilesystemUserConfigStore.js';
export {
  type UserConfigBackend,
  type CreateUserConfigStoreOptions,
  createUserConfigStore,
} from './createUserConfigStore.js';
