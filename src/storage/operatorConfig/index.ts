/**
 * Operator Config Storage — barrel export.
 *
 * @module storage/operatorConfig
 */

export {
  type IOperatorConfigStore,
  type OperatorConfig,
  DEFAULT_OPERATOR_CONFIG,
} from './IOperatorConfigStore.js';
export { InMemoryOperatorConfigStore } from './InMemoryOperatorConfigStore.js';
export { FilesystemOperatorConfigStore } from './FilesystemOperatorConfigStore.js';
export {
  type OperatorConfigBackend,
  type CreateOperatorConfigStoreOptions,
  createOperatorConfigStore,
} from './createOperatorConfigStore.js';
