/**
 * Authentication Module
 *
 * Unified authentication for both the MCP HTTP transport and the web console.
 * Pluggable providers (local dev JWTs or external OIDC) selected via config.
 *
 * @module auth
 */

export type { IAuthProvider, AuthClaims, AuthResult, IssueOptions } from './IAuthProvider.js';
export { LocalDevAuthProvider } from './LocalDevAuthProvider.js';
export { OidcAuthProvider } from './OidcAuthProvider.js';
export { createAuthProvider, type AuthConfig } from './AuthProviderFactory.js';
export { createUnifiedAuthMiddleware, type AuthMiddlewareOptions } from './authMiddleware.js';
