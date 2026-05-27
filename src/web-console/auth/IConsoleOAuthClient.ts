export interface ConsoleAuthorizationUrlRequest {
  readonly state: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
}

export interface ConsoleOAuthCodeExchangeRequest {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export interface ConsoleOAuthIdentityClaims {
  readonly sub: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly authMethod?: string;
}

/**
 * BFF-facing OAuth client boundary. Implementations perform token exchange and
 * validation internally and return only identity claims; browser tokens and raw
 * token responses never cross into console route results.
 */
export interface IConsoleOAuthClient {
  createAuthorizationUrl(request: ConsoleAuthorizationUrlRequest): string;
  exchangeAuthorizationCode(request: ConsoleOAuthCodeExchangeRequest): Promise<ConsoleOAuthIdentityClaims>;
}
