/**
 * GitHub OAuth scope constants
 *
 * Distinct from the device-flow scopes used by GitHubAuthManager (which
 * needs `public_repo` / `read:user` to write the user's portfolio).
 * The §8.1 social-login auth-code flow only needs identity.
 *
 * Both flows can share the same GitHub OAuth app — GitHub's consent
 * screen shows only the scopes the current request asks for, so users
 * approving "Sign in with DollhouseMCP" never see `repo` even when the
 * device-flow code path elsewhere requests it.
 *
 * @module auth/embedded-as/methods/githubScopes
 */

export const MIN_AUTHCODE_SCOPES = ['read:user', 'user:email'] as const;

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_API_USER_URL = 'https://api.github.com/user';
export const GITHUB_API_EMAILS_URL = 'https://api.github.com/user/emails';
