import { createHash, randomBytes } from 'node:crypto';

import { logger } from '../../utils/logger.js';

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
  ConsoleCapability,
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../platform/ConsolePlatformTypes.js';
import { CONSOLE_CAPABILITIES } from '../platform/ConsolePlatformTypes.js';
import { capabilitiesForRoles } from '../modules/account-admin/AccountAdminRoleAuthority.js';
import { normalizeConsoleReturnPath } from '../platform/ConsoleReturnPaths.js';
import type { IConsoleOAuthClient } from './IConsoleOAuthClient.js';

const LOGIN_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PKCE_VERIFIER_BYTES = 32;
const PKCE_SECRET_CLASS = 'pkce_verifier';
const AUTH_PATH = '/api/v1/auth';
const SELF_CAPABILITY = 'console:self';
const ADMIN_ACR = 'urn:dollhouse:acr:admin-stepup';
// The BFF attaches a maximum elevation lifetime; route-specific 30m/5m freshness remains enforced by authorization middleware.
const ELEVATION_TTL_MAX_MS = 30 * 60 * 1000;
// The callback accepts only recent AS administrative proof before any route-specific freshness check runs later.
const AUTH_TIME_FRESHNESS_MAX_MS = 30 * 60 * 1000;

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
    capabilities: [SELF_CAPABILITY],
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
      method: 'GET',
      path: `${AUTH_PATH}/step-up`,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_security',
      idempotency: 'not_applicable',
      handler: req => service.startStepUp(req),
    }, {
      method: 'GET',
      path: `${AUTH_PATH}/step-up/callback`,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_security',
      idempotency: 'not_applicable',
      handler: req => service.completeStepUp(req),
    }, {
      method: 'POST',
      path: `${AUTH_PATH}/step-down`,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_security',
      idempotency: 'not_applicable',
      handler: req => service.stepDown(req),
    }, {
      method: 'POST',
      path: `${AUTH_PATH}/logout`,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
      ownership: 'authenticated_user',
      elevation: 'none',
      privacyClass: 'self_security',
      idempotency: 'not_applicable',
      handler: req => service.logout(req),
    }, {
      method: 'GET',
      path: `${AUTH_PATH}/me`,
      audience: 'self',
      requiredCapability: SELF_CAPABILITY,
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
        codeChallengeMethod: 'S256',
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
      grantedCapabilities: [SELF_CAPABILITY],
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

  async startStepUp(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const authentication = requireAuthentication(req);
    const capability = readRequestedAdminCapability(req);
    if (!capability) {
      return invalidCapability();
    }
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
      flowKind: 'step_up',
      stateHash: this.options.opaqueValues.hashOpaqueValue(state),
      pkceVerifierEnc,
      userId: authentication.userId,
      consoleSessionIdHash: Buffer.from(authentication.sessionIdHash),
      requestedCapability: capability,
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
        codeChallengeMethod: 'S256',
        redirectUri: this.stepUpRedirectUri,
        prompt: 'login',
        maxAgeSeconds: 0,
        acrValues: ADMIN_ACR,
      }),
      cookies: [{ operation: 'set', name: CONSOLE_LOGIN_STATE_COOKIE, value: transactionId }],
    };
  }

  async completeStepUp(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const authentication = requireAuthentication(req);
    const transactionId = readCookie(req.headers.cookie, CONSOLE_LOGIN_STATE_COOKIE);
    const code = singleQueryValue(req.query.code);
    const state = singleQueryValue(req.query.state);
    if (!transactionId || !code || !state) {
      logger.warn('[ConsoleBffAuthModule] step-up rejected: missing params', {
        hasTransactionId: !!transactionId, hasCode: !!code, hasState: !!state,
      });
      return failedCallback();
    }

    const transaction = await this.options.loginTransactions.consume(
      this.options.opaqueValues.hashOpaqueValue(transactionId),
      this.options.opaqueValues.hashOpaqueValue(state),
      this.now(),
    );
    if (transaction?.flowKind !== 'step_up' ||
        !transaction.userId ||
        !transaction.consoleSessionIdHash ||
        !transaction.requestedCapability ||
        transaction.userId !== authentication.userId ||
        !buffersEqual(transaction.consoleSessionIdHash, authentication.sessionIdHash)) {
      logger.warn('[ConsoleBffAuthModule] step-up rejected: transaction check', {
        found: !!transaction,
        flowKind: transaction?.flowKind,
        hasUserId: !!transaction?.userId,
        hasSessionHash: !!transaction?.consoleSessionIdHash,
        hasCapability: !!transaction?.requestedCapability,
        userIdMatch: transaction?.userId === authentication.userId,
        sessionMatch: !!transaction?.consoleSessionIdHash &&
          buffersEqual(transaction.consoleSessionIdHash, authentication.sessionIdHash),
      });
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
        redirectUri: this.stepUpRedirectUri,
      });
    } catch (error) {
      logger.warn('[ConsoleBffAuthModule] step-up rejected: code exchange failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return failedCallback();
    }
    const principal = await this.options.identityResolver.resolveEnabledPrincipal(claims.sub);
    const now = this.now();
    if (principal?.userId !== authentication.userId ||
        claims.acr !== ADMIN_ACR ||
        !claims.amr?.includes('otp') ||
        !claims.authTime ||
        claims.authTime > now ||
        claims.authTime.getTime() + AUTH_TIME_FRESHNESS_MAX_MS <= now.getTime()) {
      logger.warn(
        `[ConsoleBffAuthModule] step-up rejected: claims check — ` +
        `principalMatch=${principal?.userId === authentication.userId} ` +
        `acr=${String(claims.acr)} amr=${JSON.stringify(claims.amr ?? null)} ` +
        `hasOtp=${claims.amr?.includes('otp') ?? false} ` +
        `authTime=${claims.authTime?.toISOString() ?? 'none'} now=${now.toISOString()} ` +
        `inFuture=${claims.authTime ? claims.authTime > now : 'n/a'} ` +
        `stale=${claims.authTime ? claims.authTime.getTime() + AUTH_TIME_FRESHNESS_MAX_MS <= now.getTime() : 'n/a'}`,
      );
      return failedCallback();
    }
    // One step-up elevates the session to the principal's FULL role-entitled
    // admin capability set (e.g. an `admin` gets operate + accounts + audit +
    // security at once) instead of only the requested capability — so a single
    // step-up unlocks all admin surfaces the role allows. Falls back to the
    // requested capability when the principal carries no recognized roles.
    const roleCapabilities = capabilitiesForRoles(principal.roles ?? []);
    const elevationCapabilities = roleCapabilities.length > 0
      ? roleCapabilities
      : [transaction.requestedCapability];
    const attached = await this.options.sessionStore.setElevation(authentication.sessionIdHash, {
      capabilities: elevationCapabilities,
      expiresAt: new Date(now.getTime() + ELEVATION_TTL_MAX_MS),
      acr: claims.acr,
      amr: claims.amr,
      authTime: claims.authTime,
    }, now);
    if (!attached) {
      return failedCallback();
    }
    return {
      status: 302,
      redirectTo: transaction.returnTo ?? '/',
      cookies: [{ operation: 'clear', name: CONSOLE_LOGIN_STATE_COOKIE }],
    };
  }

  async stepDown(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const authentication = requireAuthentication(req);
    await this.options.sessionStore.clearElevation(authentication.sessionIdHash, this.now());
    return { status: 204 };
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

  async me(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const authentication = requireAuthentication(req);
    // The admin capabilities this principal's role entitles them to step up
    // into — the honest signal for whether to offer elevation in the UI. A
    // (non-elevated) session only holds `console:self`, so this must come from
    // the role grant, not the session's current capabilities. Re-resolving keeps
    // it live: a revoked role stops offering elevation immediately. Resolution
    // failure (disabled/removed principal) falls back to none.
    const principal = await this.options.identityResolver.resolveEnabledPrincipal(authentication.authSub);
    const availableAdminCapabilities = principal ? capabilitiesForRoles(principal.roles ?? []) : [];
    return {
      status: 200,
      body: {
        user_id: authentication.userId,
        auth_sub: authentication.authSub,
        granted_capabilities: authentication.grantedCapabilities,
        available_admin_capabilities: availableAdminCapabilities,
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

  private get stepUpRedirectUri(): string {
    return new URL(`${AUTH_PATH}/step-up/callback`, normalizeBaseUrl(this.options.publicBaseUrl)).toString();
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

function readRequestedAdminCapability(req: ConsoleRequest): ConsoleCapability | null {
  const capability = singleQueryValue(req.query.capability);
  return isAdminCapability(capability) ? capability : null;
}

function isAdminCapability(value: string | null): value is ConsoleCapability {
  return !!value &&
    value.startsWith('console:admin:') &&
    (CONSOLE_CAPABILITIES as readonly string[]).includes(value);
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

function invalidCapability(): ConsoleHandlerResult {
  return {
    status: 400,
    body: {
      code: 'invalid_capability',
      detail: 'Step-up requires a valid administrative console capability.',
    },
  };
}

function requireAuthentication(req: ConsoleRequest): ConsoleAuthenticatedContext {
  if (!req.consoleAuthentication) {
    throw new Error('Console authentication context is required');
  }
  return req.consoleAuthentication;
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}
