/**
 * Context Module for DollhouseMCP
 *
 * Exports session context types, policy helpers, and transport-specific
 * session factories.
 *
 * @module context
 */

// Types
export type { SessionContext, SessionResolver } from './SessionContext.js';

// Policy: sentinel, error class, helpers
export {
  SYSTEM_CONTEXT,
  SessionContextRequiredError,
  isStrictMode,
  getSessionOrSystem,
} from './ContextPolicy.js';

// Transport factories and constants
export { createStdioSession, STDIO_DEFAULT_USER_ID } from './StdioSession.js';
