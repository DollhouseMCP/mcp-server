import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { SecurityMonitor } from '../../../security/securityMonitor.js';
import {
  CONSOLE_INTEGRATION_STATE_COOKIE,
  readCookie,
} from '../../middleware/ConsoleCookies.js';
import type {
  ConsoleAuthenticatedContext,
  ConsoleHandlerResult,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import { normalizeConsoleReturnPath } from '../../platform/ConsoleReturnPaths.js';
import type { IConsoleOpaqueValueService } from '../../security/ConsoleOpaqueValues.js';
import type { ISecretEncryptionService } from '../../security/SecretEncryption.js';
import type { ILoginTransactionStore } from '../../stores/ILoginTransactionStore.js';
import type { IUserIntegrationStore } from '../../stores/IUserIntegrationStore.js';
import {
  serializeGitHubIntegrationStatus,
  serializeIntegrationList,
} from './IntegrationDtos.js';
import type {
  GitHubIntegrationContentsPermission,
  GitHubIntegrationTokenExchangeResult,
  IGitHubIntegrationProvider,
} from './GitHubIntegrationProvider.js';
import type {
  IIntegrationSecurityEventSink,
  IntegrationCallbackRejectedReason,
} from './IntegrationSecurityEvents.js';
import { integrationSecretContext, type IntegrationSecretContext } from './IntegrationSecretContext.js';

const INTEGRATION_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const PKCE_VERIFIER_BYTES = 32;
const PKCE_SECRET_CLASS = 'pkce_verifier';
const INTEGRATION_PATH = '/api/v1/me/integrations';
const GITHUB_CALLBACK_PATH = `${INTEGRATION_PATH}/github/callback`;

export class IntegrationService {
  constructor(private readonly options: {
    readonly store: IUserIntegrationStore;
    readonly loginTransactions?: ILoginTransactionStore | null;
    readonly opaqueValues?: IConsoleOpaqueValueService | null;
    readonly secretEncryption?: ISecretEncryptionService | null;
    readonly githubProvider?: IGitHubIntegrationProvider | null;
    readonly publicBaseUrl?: string | null;
    readonly securityEventSink?: IIntegrationSecurityEventSink | null;
    readonly now?: () => Date;
  }) {}

  async list(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const records = await this.options.store.listByUser(auth.userId);
    return {
      status: 200,
      body: serializeIntegrationList(records),
    };
  }

  async getGitHub(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const record = await this.options.store.findByProvider(auth.userId, 'github');
    return {
      status: 200,
      body: serializeGitHubIntegrationStatus(record),
    };
  }

  async connectGitHub(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const deps = this.writeDependencies();
    if (!deps) return serviceUnavailable('GitHub integration linking is not configured.');
    const now = this.now();
    const transactionId = deps.opaqueValues.createOpaqueValue();
    const state = deps.opaqueValues.createOpaqueValue();
    const pkceVerifier = createPkceVerifier();
    const pkceVerifierEnc = deps.secretEncryption.encrypt(
      Buffer.from(pkceVerifier, 'utf8'),
      pkceContext(transactionId),
    );
    const contentsPermission = requestedContentsPermission(req.body);
    const redirectUri = this.githubCallbackUri();
    await deps.loginTransactions.create({
      idHash: deps.opaqueValues.hashOpaqueValue(transactionId),
      flowKind: 'integration_link',
      stateHash: deps.opaqueValues.hashOpaqueValue(state),
      pkceVerifierEnc,
      userId: auth.userId,
      consoleSessionIdHash: Buffer.from(auth.sessionIdHash),
      requestedCapability: null,
      returnTo: readBodyReturnTo(req.body),
      createdAt: now,
      expiresAt: new Date(now.getTime() + INTEGRATION_TRANSACTION_TTL_MS),
      consumedAt: null,
    });
    logIntegrationSecurityEvent('OPERATION_COMPLETED', 'LOW', 'GitHub integration link flow started', {
      userId: auth.userId,
      contentsPermission,
    });
    return {
      // Return the authorization URL in the body (not a 302): the console is an
      // SPA driven by fetch, which can't follow a cross-origin redirect, and CSRF
      // is header-only so a plain form POST can't drive this. The browser does
      // window.location = authorize_url. (Slice B's /:provider/connect matches.)
      status: 200,
      body: {
        authorize_url: deps.githubProvider.createAuthorizationUrl({
          state,
          codeChallenge: createPkceChallenge(pkceVerifier),
          codeChallengeMethod: 'S256',
          redirectUri,
          contentsPermission,
        }),
      },
      cookies: [{ operation: 'set', name: CONSOLE_INTEGRATION_STATE_COOKIE, value: transactionId }],
    };
  }

  async completeGitHubCallback(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const deps = this.writeDependencies();
    if (!deps) return failedIntegrationCallback();
    const transactionId = readCookie(req.headers.cookie, CONSOLE_INTEGRATION_STATE_COOKIE);
    const code = singleQueryValue(req.query.code);
    const state = singleQueryValue(req.query.state);
    if (!transactionId || !code || !state) {
      await this.recordCallbackRejected(auth.userId, 'missing');
      return failedIntegrationCallback();
    }

    const idHash = deps.opaqueValues.hashOpaqueValue(transactionId);
    const now = this.now();
    const transaction = await deps.loginTransactions.consume(
      idHash,
      deps.opaqueValues.hashOpaqueValue(state),
      now,
    );
    if (transaction?.flowKind !== 'integration_link') {
      await this.recordCallbackRejected(
        auth.userId,
        await this.classifyMissingTransaction(deps.loginTransactions, idHash, now),
      );
      return failedIntegrationCallback();
    }
    if (transaction.userId !== auth.userId) {
      await this.recordCallbackRejected(auth.userId, 'user_mismatch');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }
    if (!transaction.consoleSessionIdHash ||
        !buffersEqual(transaction.consoleSessionIdHash, auth.sessionIdHash)) {
      await this.recordCallbackRejected(auth.userId, 'session_mismatch');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }

    let pkceVerifier;
    try {
      pkceVerifier = deps.secretEncryption.decrypt(
        transaction.pkceVerifierEnc,
        pkceContext(transactionId),
      ).toString('utf8');
    } catch {
      await this.recordCallbackRejected(auth.userId, 'consumed');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }
    let exchanged: GitHubIntegrationTokenExchangeResult;
    try {
      exchanged = await deps.githubProvider.exchangeAuthorizationCode({
        code,
        codeVerifier: pkceVerifier,
        redirectUri: this.githubCallbackUri(),
        installationId: singleQueryValue(req.query.installation_id),
      });
    } catch {
      await this.options.store.recordError({
        userId: auth.userId,
        provider: 'github',
        errorReason: 'token_exchange_failed',
        occurredAt: this.now(),
      });
      logIntegrationSecurityEvent('OPERATION_FAILED', 'MEDIUM', 'GitHub integration token exchange failed', {
        userId: auth.userId,
      });
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }

    const connectedAt = this.now();
    await this.options.store.connect({
      userId: auth.userId,
      provider: 'github',
      externalAccountLabel: exchanged.accountLabel,
      externalInstallationId: exchanged.installationId,
      authorizedPermissions: {
        repository_selection: exchanged.repositorySelection,
        permissions: { contents: exchanged.contentsPermission },
      },
      accessTokenCiphertext: deps.secretEncryption.encrypt(
        Buffer.from(exchanged.accessToken, 'utf8'),
        integrationSecretContext('access_token', auth.userId, 'github'),
      ),
      refreshTokenCiphertext: exchanged.refreshToken
        ? deps.secretEncryption.encrypt(
          Buffer.from(exchanged.refreshToken, 'utf8'),
          integrationSecretContext('refresh_token', auth.userId, 'github'),
        )
        : null,
      connectedAt,
    });
    logIntegrationSecurityEvent('OPERATION_COMPLETED', 'LOW', 'GitHub integration connected', {
      userId: auth.userId,
      repositorySelection: exchanged.repositorySelection,
      contentsPermission: exchanged.contentsPermission,
    });

    return {
      status: 302,
      redirectTo: transaction.returnTo ?? INTEGRATION_PATH,
      cookies: [{ operation: 'clear', name: CONSOLE_INTEGRATION_STATE_COOKIE }],
    };
  }

  async disconnectGitHub(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const deps = this.writeDependencies();
    if (!deps) return serviceUnavailable('GitHub integration disconnect is not configured.');
    const active = await this.options.store.findByProvider(auth.userId, 'github');
    if (active) {
      const revoked = await this.revokeRemoteGitHubCredentials(deps, auth, active);
      if (!revoked) {
        const errorRecord = await this.options.store.recordError({
          userId: auth.userId,
          provider: 'github',
          errorReason: 'revocation_failed',
          occurredAt: this.now(),
        });
        return {
          status: 200,
          body: serializeGitHubIntegrationStatus(errorRecord),
        };
      }
      await this.options.store.disconnect({
        userId: auth.userId,
        provider: 'github',
        revokedAt: this.now(),
      });
      logIntegrationSecurityEvent('OPERATION_COMPLETED', 'LOW', 'GitHub integration disconnected', {
        userId: auth.userId,
      });
    }
    return {
      status: 200,
      body: serializeGitHubIntegrationStatus(null),
    };
  }

  private async revokeRemoteGitHubCredentials(
    deps: NonNullable<ReturnType<IntegrationService['writeDependencies']>>,
    auth: ConsoleAuthenticatedContext,
    active: NonNullable<Awaited<ReturnType<IUserIntegrationStore['findByProvider']>>>,
  ): Promise<boolean> {
    const accessToken = active.accessTokenCiphertext
      ? decryptNullable(deps.secretEncryption, active.accessTokenCiphertext, integrationSecretContext('access_token', auth.userId, 'github'))
      : null;
    const refreshToken = active.refreshTokenCiphertext
      ? decryptNullable(deps.secretEncryption, active.refreshTokenCiphertext, integrationSecretContext('refresh_token', auth.userId, 'github'))
      : null;
    try {
      await deps.githubProvider.revokeCredentials({
        accessToken,
        refreshToken,
        installationId: active.externalInstallationId,
      });
      return true;
    } catch {
      // Local credential invalidation still proceeds so no future console path
      // can use the stored credentials. Structured event persistence lands with
      // the self-security/user-event sink.
      return false;
    }
  }

  private writeDependencies(): {
    readonly loginTransactions: ILoginTransactionStore;
    readonly opaqueValues: IConsoleOpaqueValueService;
    readonly secretEncryption: ISecretEncryptionService;
    readonly githubProvider: IGitHubIntegrationProvider;
  } | null {
    if (!this.options.loginTransactions ||
        !this.options.opaqueValues ||
        !this.options.secretEncryption ||
        !this.options.githubProvider ||
        !this.options.publicBaseUrl) {
      return null;
    }
    return {
      loginTransactions: this.options.loginTransactions,
      opaqueValues: this.options.opaqueValues,
      secretEncryption: this.options.secretEncryption,
      githubProvider: this.options.githubProvider,
    };
  }

  private async classifyMissingTransaction(
    loginTransactions: ILoginTransactionStore,
    idHash: Buffer,
    now: Date,
  ): Promise<IntegrationCallbackRejectedReason> {
    const existing = await loginTransactions.findByIdHash(idHash);
    if (!existing) return 'missing';
    if (existing.expiresAt <= now) return 'expired';
    return 'consumed';
  }

  private async recordCallbackRejected(
    userId: string | null,
    reason: IntegrationCallbackRejectedReason,
  ): Promise<void> {
    logIntegrationSecurityEvent('OPERATION_FAILED', 'MEDIUM', 'GitHub integration callback rejected', {
      userId,
      reason,
    });
    try {
      await this.options.securityEventSink?.recordIntegrationCallbackRejected({
        type: 'console.auth.integration_callback_rejected.v1',
        userId,
        provider: 'github',
        reason,
        occurredAt: this.now(),
      });
    } catch {
      // A security-event sink failure cannot make callback rejection observable
      // to the browser or revive a failed OAuth transaction.
    }
  }

  private githubCallbackUri(): string {
    if (!this.options.publicBaseUrl) throw new Error('GitHub integration public base URL is not configured');
    return new URL(GITHUB_CALLBACK_PATH, normalizeBaseUrl(this.options.publicBaseUrl)).toString();
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

function pkceContext(transactionId: string): { readonly secretClass: string; readonly ownerId: string } {
  return { secretClass: PKCE_SECRET_CLASS, ownerId: `integration:${transactionId}` };
}

function decryptNullable(
  secretEncryption: ISecretEncryptionService,
  ciphertext: Buffer,
  context: IntegrationSecretContext,
): string | null {
  try {
    return secretEncryption.decrypt(ciphertext, context).toString('utf8');
  } catch {
    return null;
  }
}

function requestedContentsPermission(body: unknown): GitHubIntegrationContentsPermission {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return record.contents_permission === 'write' ? 'write' : 'read';
}

function readBodyReturnTo(body: unknown): string {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return normalizeConsoleReturnPath(record.return_to, INTEGRATION_PATH);
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

function failedIntegrationCallback(returnTo = INTEGRATION_PATH): ConsoleHandlerResult {
  return {
    status: 302,
    redirectTo: normalizeConsoleReturnPath(returnTo, INTEGRATION_PATH),
    cookies: [{ operation: 'clear', name: CONSOLE_INTEGRATION_STATE_COOKIE }],
  };
}

function serviceUnavailable(detail: string): ConsoleHandlerResult {
  return {
    status: 503,
    body: {
      type: 'about:blank',
      title: 'Service unavailable',
      status: 503,
      code: 'service_unavailable',
      detail,
    },
  };
}

function logIntegrationSecurityEvent(
  type: 'OPERATION_COMPLETED' | 'OPERATION_FAILED',
  severity: 'LOW' | 'MEDIUM',
  details: string,
  additionalData?: Record<string, unknown>,
): void {
  SecurityMonitor.logSecurityEvent({
    type,
    severity,
    source: 'IntegrationService',
    details,
    additionalData,
  });
}

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
