/**
 * Swappable persistence boundary for GitHub OAuth tokens.
 *
 * Implementations are responsible only for encrypted persistence. Token
 * validation and logging stay in TokenManager so callers keep the existing API.
 */
export interface ITokenStore {
  storeToken(userId: string, token: string): Promise<void>;
  retrieveToken(userId: string): Promise<string | null>;
  deleteToken(userId: string): Promise<void>;
}
