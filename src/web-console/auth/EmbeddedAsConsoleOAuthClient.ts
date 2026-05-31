import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';

import { EMBEDDED_AS_CONSOLE_CLIENT_ID } from '../../auth/embedded-as/ConsoleOAuthClientConstants.js';
import { joinUrl, normalizeBaseUrl } from '../../auth/oauth/url.js';
import type {
  ConsoleAuthorizationUrlRequest,
  ConsoleOAuthCodeExchangeRequest,
  ConsoleOAuthIdentityClaims,
  IConsoleOAuthClient,
} from './IConsoleOAuthClient.js';

const OIDC_SCOPES = 'openid profile email';
const ID_TOKEN_ALGORITHM = 'ES256';

export interface EmbeddedAsConsoleOAuthClientOptions {
  readonly publicBaseUrl: string;
  readonly clientId?: string;
  readonly fetch?: typeof fetch;
  readonly jwks?: JWTVerifyGetKey;
}

export class EmbeddedAsConsoleOAuthClient implements IConsoleOAuthClient {
  private readonly issuer: string;
  private readonly authorizationEndpoint: URL;
  private readonly tokenEndpoint: URL;
  private readonly clientId: string;
  private readonly fetchFn: typeof fetch;
  private readonly jwks: JWTVerifyGetKey;

  constructor(options: EmbeddedAsConsoleOAuthClientOptions) {
    const baseUrl = normalizeBaseUrl(options.publicBaseUrl);
    this.issuer = baseUrl;
    this.authorizationEndpoint = new URL(joinUrl(baseUrl, '/auth'));
    this.tokenEndpoint = new URL(joinUrl(baseUrl, '/token'));
    this.clientId = options.clientId ?? EMBEDDED_AS_CONSOLE_CLIENT_ID;
    this.fetchFn = options.fetch ?? fetch;
    this.jwks = options.jwks ?? createRemoteJWKSet(new URL(joinUrl(baseUrl, '/jwks')));
  }

  createAuthorizationUrl(request: ConsoleAuthorizationUrlRequest): string {
    const url = new URL(this.authorizationEndpoint);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', OIDC_SCOPES);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('state', request.state);
    url.searchParams.set('code_challenge', request.codeChallenge);
    url.searchParams.set('code_challenge_method', request.codeChallengeMethod);
    if (request.prompt) url.searchParams.set('prompt', request.prompt);
    if (request.maxAgeSeconds !== undefined) url.searchParams.set('max_age', String(request.maxAgeSeconds));
    if (request.acrValues) url.searchParams.set('acr_values', request.acrValues);
    return url.toString();
  }

  async exchangeAuthorizationCode(
    request: ConsoleOAuthCodeExchangeRequest,
  ): Promise<ConsoleOAuthIdentityClaims> {
    const response = await this.fetchFn(this.tokenEndpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.clientId,
        code: request.code,
        code_verifier: request.codeVerifier,
        redirect_uri: request.redirectUri,
      }),
    });
    if (!response.ok) {
      throw new Error('Console OAuth code exchange failed');
    }
    const body = await response.json() as { readonly id_token?: unknown };
    if (typeof body.id_token !== 'string' || body.id_token === '') {
      throw new Error('Console OAuth code exchange did not return an id_token');
    }
    const { payload } = await jwtVerify(body.id_token, this.jwks, {
      issuer: this.issuer,
      audience: this.clientId,
      algorithms: [ID_TOKEN_ALGORITHM],
    });
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new Error('Console OAuth id_token is missing sub');
    }
    return {
      sub: payload.sub,
      displayName: typeof payload.name === 'string' ? payload.name : undefined,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      acr: typeof payload.acr === 'string' ? payload.acr : undefined,
      amr: Array.isArray(payload.amr)
        ? payload.amr.filter((value): value is string => typeof value === 'string')
        : undefined,
      authTime: typeof payload.auth_time === 'number' ? new Date(payload.auth_time * 1000) : undefined,
    };
  }
}
