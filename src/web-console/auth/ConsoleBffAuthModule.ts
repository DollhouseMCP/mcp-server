import { createHash, randomBytes } from 'node:crypto';

import type { IConsoleIdentityResolver } from '../identity/IConsoleIdentityResolver.js';
import {
  CONSOLE_CSRF_COOKIE,
  CONSOLE_LOGIN_STATE_COOKIE,
  CONSOLE_SESSION_COOKIE,
  readCookie,
} from '../middleware/ConsoleCookies.js';
import type { IConsoleOpaqueValueService } from '../security/ConsoleOpaqueValues.js';
import type { ISecretEncryptionService } from '../security/SecretEncryption.js';
import type { IConsoleSessionStore } from '../stores/IConsoleSessionStore.js';
import type { ILoginTransactionStore } from '../stores/ILoginTransactionStore.js';
import type {
  ConsoleAuthenticatedContext,
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../platform/ConsolePlatformTypes.js';
import { normalizeConsoleReturnPath } from '../platform/ConsoleReturnPaths.js';
import type { IConsoleOAuthClient } from './IConsoleOAuthClient.js';

const LOGIN_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PKCE_VERIFIER_BYTES = 32;
const PKCE_SECRET_CLASS = 'pkce_verifier';
const AUTH_PATH = '/api/v1/auth';

export interface ConsoleBffAuthModuleOptions {
  readonly oauthClient: IConsoleOAuthClient;
  readonly loginTransactions: ILoginTransactionStore;
  readonly sessionStore: IConsoleSessionStore;
  readonly identityResolver: IConsoleIdentityResolver;
  readonly opaqueValues: IConsoleOpaqueValueService;
  readonly secretEncryption: ISecretEncryptionService;
  readonly publicBaseUrl: string;
  readonly now?: () => Date;
  readonly sessionIdleTtlMs?: number;
  readonly sessionAbsoluteTtlMs?: number;
}

export function createConsoleBffAuthModule(options: ConsoleBffAuthModuleOptions): ConsoleModuleDescriptor {
  const service = new ConsoleBffAuthService(options);
  return {
    id: 'auth',
    apiVersion: 'v1',
    capabilities: ['console:self'],
    routes: [{
      method: 'GET',
      path: `${AUTH_PATH}/login`,
      audience: 'public',
      requiredCapability: 'none',
      ownership: 'flow_transaction',
      elevation: 'none',
      privacyClass: 'self_security',
      idempotency: 'not_applicable',
      handler: req => service.startLogin(req),
    }, {
      method: 'GET',
      path: `${AUTH_PATH}/callback`,
      audience: 'public',
      requiredCapability: 'none',
      ownership: 'flow_transaction',
      elevation: 'none',
      privacyClass: 'self_security',
      idempotency: 'not_applicable',
      handler: req => service.completeLogin(req),
    }, {
      method: 'POST',
      path: `${AUTH_PATH}/logout`,
      audience: 'self',
      requiredCapability: 'console:self',
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_security',
      idempotency: 'not_applicable',
      handler: req => service.logout(req),
    }, {
      method: 'GET',
      path: `${AUTH_PATH}/me`,
      audience: 'self',
      requiredCapability: 'console:self',
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_security',
      idempotency: 'not_applicable',
      handler: req => service.me(req),
    }],
  };
}

class ConsoleBffAuthService {
  private readonly redirectUri: string;

  constructor(private readonly options: ConsoleBffAuthModuleOptions) {
    this.redirectUri = new URL(`${AUTH_PATH}/callback`, normalizeBaseUrl(options.publicBaseUrl)).toString();
  }

  async startLogin(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const now = this.now();
    const transactionId = this.options.opaqueValues.createOpaqueValue();
    const state = this.options.opaqueValues.createOpaqueValue();
    const pkceVerifier = createPkceVerifier();
    const pkceVerifierEnc = this.options.secretEncryption.encrypt(
      Buffer.from(pkceVerifier, 'utf8'),
      pkceContext(transactionId),
    );
    await this.options.loginTransactions.create({
      idHash: this.options.opaqueValues.hashOpaqueValue(transactionId),
      flowKind: 'login',
      stateHash: this.options.opaqueValues.hashOpaqueValue(state),
      pkceVerifierEnc,
      userId: null,
      consoleSessionIdHash: null,
      requestedCapability: null,
      returnTo: readReturnTo(req),
      createdAt: now,
      expiresAt: new Date(now.getTime() + LOGIN_TRANSACTION_TTL_MS),
      consumedAt: null,
    });

    return {
      status: 302,
      redirectTo: this.options.oauthClient.createAuthorizationUrl({
        state,
        codeChallenge: createPkceChallenge(pkceVerifier),
        redirectUri: this.redirectUri,
      }),
      cookies: [{ operation: 'set', name: CONSOLE_LOGIN_STATE_COOKIE, value: transactionId }],
    };
  }

  async completeLogin(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const transactionId = readCookie(req.headers.cookie, CONSOLE_LOGIN_STATE_COOKIE);
    const code = singleQueryValue(req.query.code);
    const state = singleQueryValue(req.query.state);
    if (!transactionId || !code || !state) {
      return failedCallback();
    }

    const transaction = await this.options.loginTransactions.consume(
      this.options.opaqueValues.hashOpaqueValue(transactionId),
      this.options.opaqueValues.hashOpaqueValue(state),
      this.now(),
    );
    if (transaction?.flowKind !== 'login') {
      return failedCallback();
    }

    const pkceVerifier = this.options.secretEncryption.decrypt(
      transaction.pkceVerifierEnc,
      pkceContext(transactionId),
    ).toString('utf8');
    let claims;
    try {
      claims = await this.options.oauthClient.exchangeAuthorizationCode({
        code,
        codeVerifier: pkceVerifier,
        redirectUri: this.redirectUri,
      });
    } catch {
      return failedCallback();
    }
    const principal = await this.options.identityResolver.resolveEnabledPrincipal(claims.sub);
    if (!principal) {
      return failedCallback();
    }

    const now = this.now();
    const sessionValue = this.options.opaqueValues.createOpaqueValue();
    const csrfValue = this.options.opaqueValues.createOpaqueValue();
    await this.options.sessionStore.create({
      idHash: this.options.opaqueValues.hashOpaqueValue(sessionValue),
      userId: principal.userId,
      authSub: principal.sub,
      csrfTokenHash: this.options.opaqueValues.hashOpaqueValue(csrfValue),
      grantedCapabilities: ['console:self'],
      elevation: null,
      createdAt: now,
      lastUsedAt: now,
      idleExpiresAt: new Date(now.getTime() + (this.options.sessionIdleTtlMs ?? SESSION_IDLE_TTL_MS)),
      absoluteExpiresAt: new Date(now.getTime() + (this.options.sessionAbsoluteTtlMs ?? SESSION_ABSOLUTE_TTL_MS)),
      revokedAt: null,
      lastIp: typeof req.ip === 'string' ? req.ip : null,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    });

    return {
      status: 302,
      redirectTo: transaction.returnTo ?? '/',
      cookies: [
        { operation: 'clear', name: CONSOLE_LOGIN_STATE_COOKIE },
        { operation: 'set', name: CONSOLE_SESSION_COOKIE, value: sessionValue },
        { operation: 'set', name: CONSOLE_CSRF_COOKIE, value: csrfValue },
      ],
    };
  }

  async logout(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const authentication = requireAuthentication(req);
    await this.options.sessionStore.revoke(authentication.sessionIdHash, this.now());
    return {
      status: 204,
      cookies: [
        { operation: 'clear', name: CONSOLE_SESSION_COOKIE },
        { operation: 'clear', name: CONSOLE_CSRF_COOKIE },
        { operation: 'clear', name: CONSOLE_LOGIN_STATE_COOKIE },
      ],
    };
  }

  me(req: ConsoleRequest): ConsoleHandlerResult {
    const authentication = requireAuthentication(req);
    return {
      status: 200,
      body: {
        user_id: authentication.userId,
        auth_sub: authentication.authSub,
        granted_capabilities: authentication.grantedCapabilities,
        available_admin_capabilities: [],
        elevation: authentication.elevation
          ? {
            active: true,
            expires_at: authentication.elevation.expiresAt.toISOString(),
            acr: authentication.elevation.acr,
          }
          : { active: false, expires_at: null, acr: null },
      },
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function createPkceVerifier(): string {
  return randomBytes(PKCE_VERIFIER_BYTES).toString('base64url');
}

function createPkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

function pkceContext(transactionId: string): { secretClass: string; ownerId: string } {
  return { secretClass: PKCE_SECRET_CLASS, ownerId: `login:${transactionId}` };
}

function readReturnTo(req: ConsoleRequest): string {
  return normalizeConsoleReturnPath(singleQueryValue(req.query.return_to));
}

function singleQueryValue(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  url.pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function failedCallback(): ConsoleHandlerResult {
  return {
    status: 302,
    redirectTo: '/api/v1/auth/login',
    cookies: [{ operation: 'clear', name: CONSOLE_LOGIN_STATE_COOKIE }],
  };
}

function requireAuthentication(req: ConsoleRequest): ConsoleAuthenticatedContext {
  if (!req.consoleAuthentication) {
    throw new Error('Console authentication context is required');
  }
  return req.consoleAuthentication;
}
