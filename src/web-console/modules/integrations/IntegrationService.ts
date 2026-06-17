import { createHash, randomBytes } from 'node:crypto';

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
import type { IUserIntegrationStore, UserIntegrationProvider } from '../../stores/IUserIntegrationStore.js';
import {
  serializeIntegrationList,
} from './IntegrationDtos.js';
import type {
  IIntegrationSecurityEventSink,
  IntegrationCallbackRejectedReason,
} from './IntegrationSecurityEvents.js';
import { integrationSecretContext, type IntegrationSecretContext } from './IntegrationSecretContext.js';
import type { IIntegrationProvider } from './IntegrationProvider.js';
import type { IntegrationProviderRegistry } from './IntegrationProviderRegistry.js';

const INTEGRATION_TRANSACTION_TTL_MS = 10 * 60 * 1000;
const PKCE_VERIFIER_BYTES = 32;
const PKCE_SECRET_CLASS = 'pkce_verifier';
const INTEGRATION_PATH = '/api/v1/me/integrations';

export class IntegrationService {
  constructor(private readonly options: {
    readonly store: IUserIntegrationStore;
    readonly providers: IntegrationProviderRegistry;
    readonly loginTransactions?: ILoginTransactionStore | null;
    readonly opaqueValues?: IConsoleOpaqueValueService | null;
    readonly secretEncryption?: ISecretEncryptionService | null;
    readonly publicBaseUrl?: string | null;
    readonly securityEventSink?: IIntegrationSecurityEventSink | null;
    readonly now?: () => Date;
  }) {}

  async list(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const records = await this.options.store.listByUser(auth.userId);
    return {
      status: 200,
      body: serializeIntegrationList(records, this.options.providers.listDescriptors()),
    };
  }

  async getGitHub(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    return this.getProvider(req, 'github');
  }

  async getProvider(req: ConsoleRequest, providerId: UserIntegrationProvider): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const provider = this.options.providers.get(providerId);
    if (!provider) return providerNotFound(providerId);
    const record = await this.options.store.findByProvider(auth.userId, providerId);
    return {
      status: 200,
      body: provider.projectStatus(record).body,
    };
  }

  async connectGitHub(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    return this.connectProvider(req, 'github');
  }

  async connectProvider(req: ConsoleRequest, providerId: UserIntegrationProvider): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const deps = this.writeDependencies(providerId);
    if (!deps) return serviceUnavailable(`${providerId} integration linking is not configured.`);
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
    return {
      // Return the authorization URL in the body (not a 302): the console is an
      // SPA driven by fetch, which can't follow a cross-origin redirect, and CSRF
      // is header-only so a plain form POST can't drive this. The browser does
      // window.location = authorize_url. (Slice B's /:provider/connect matches.)
      status: 200,
      body: {
        authorize_url: deps.provider.createAuthorizationUrl({
          state,
          codeChallenge: createPkceChallenge(pkceVerifier),
          codeChallengeMethod: 'S256',
          redirectUri,
          requestedPermissions: contentsPermission,
        }),
      },
      cookies: [{ operation: 'set', name: CONSOLE_INTEGRATION_STATE_COOKIE, value: transactionId }],
    };
  }

  async completeGitHubCallback(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    return this.completeProviderCallback(req, 'github');
  }

  async completeProviderCallback(req: ConsoleRequest, providerId: UserIntegrationProvider): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const deps = this.writeDependencies(providerId);
    if (!deps) return failedIntegrationCallback();
    const transactionId = readCookie(req.headers.cookie, CONSOLE_INTEGRATION_STATE_COOKIE);
    const code = singleQueryValue(req.query.code);
    const state = singleQueryValue(req.query.state);
    if (!transactionId || !code || !state) {
      await this.recordCallbackRejected(providerId, auth.userId, 'missing');
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
        providerId,
        auth.userId,
        await this.classifyMissingTransaction(deps.loginTransactions, idHash, now),
      );
      return failedIntegrationCallback();
    }
    if (transaction.userId !== auth.userId) {
      await this.recordCallbackRejected(providerId, auth.userId, 'user_mismatch');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }
    if (!transaction.consoleSessionIdHash ||
        !buffersEqual(transaction.consoleSessionIdHash, auth.sessionIdHash)) {
      await this.recordCallbackRejected(providerId, auth.userId, 'session_mismatch');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }

    let pkceVerifier;
    try {
      pkceVerifier = deps.secretEncryption.decrypt(
        transaction.pkceVerifierEnc,
        pkceContext(transactionId),
      ).toString('utf8');
    } catch {
      await this.recordCallbackRejected(providerId, auth.userId, 'consumed');
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }
    let exchanged;
    try {
      exchanged = await deps.provider.exchangeAuthorizationCode({
        code,
        codeVerifier: pkceVerifier,
        redirectUri: this.githubCallbackUri(),
        providerCallbackParams: stringQueryParams(req.query),
      });
    } catch {
      await this.options.store.recordError({
        userId: auth.userId,
        provider: providerId,
        errorReason: 'token_exchange_failed',
        occurredAt: this.now(),
      });
      return failedIntegrationCallback(transaction.returnTo ?? undefined);
    }

    const connectedAt = this.now();
    await this.options.store.connect({
      userId: auth.userId,
      provider: providerId,
      externalAccountLabel: exchanged.accountLabel,
      externalInstallationId: exchanged.externalInstallationId,
      authorizedPermissions: exchanged.authorizedPermissions,
      accessTokenCiphertext: deps.secretEncryption.encrypt(
        Buffer.from(exchanged.accessToken, 'utf8'),
        integrationSecretContext('access_token', auth.userId, providerId),
      ),
      refreshTokenCiphertext: exchanged.refreshToken
        ? deps.secretEncryption.encrypt(
          Buffer.from(exchanged.refreshToken, 'utf8'),
          integrationSecretContext('refresh_token', auth.userId, providerId),
        )
        : null,
      connectedAt,
    });

    return {
      status: 302,
      redirectTo: transaction.returnTo ?? INTEGRATION_PATH,
      cookies: [{ operation: 'clear', name: CONSOLE_INTEGRATION_STATE_COOKIE }],
    };
  }

  async disconnectGitHub(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    return this.disconnectProvider(req, 'github');
  }

  async disconnectProvider(req: ConsoleRequest, providerId: UserIntegrationProvider): Promise<ConsoleHandlerResult> {
    const auth = requireConsoleAuthentication(req);
    const deps = this.writeDependencies(providerId);
    if (!deps) return serviceUnavailable(`${providerId} integration disconnect is not configured.`);
    const active = await this.options.store.findByProvider(auth.userId, providerId);
    if (active) {
      const revoked = await this.revokeRemoteCredentials(deps, auth, active);
      if (!revoked) {
        const errorRecord = await this.options.store.recordError({
          userId: auth.userId,
          provider: providerId,
          errorReason: 'revocation_failed',
          occurredAt: this.now(),
        });
        return {
          status: 200,
          body: deps.provider.projectStatus(errorRecord).body,
        };
      }
      await this.options.store.disconnect({
        userId: auth.userId,
        provider: providerId,
        revokedAt: this.now(),
      });
    }
    return {
      status: 200,
      body: deps.provider.projectStatus(null).body,
    };
  }

  private async revokeRemoteCredentials(
    deps: NonNullable<ReturnType<IntegrationService['writeDependencies']>>,
    auth: ConsoleAuthenticatedContext,
    active: NonNullable<Awaited<ReturnType<IUserIntegrationStore['findByProvider']>>>,
  ): Promise<boolean> {
    const accessToken = active.accessTokenCiphertext
      ? decryptNullable(deps.secretEncryption, active.accessTokenCiphertext, integrationSecretContext('access_token', auth.userId, active.provider))
      : null;
    const refreshToken = active.refreshTokenCiphertext
      ? decryptNullable(deps.secretEncryption, active.refreshTokenCiphertext, integrationSecretContext('refresh_token', auth.userId, active.provider))
      : null;
    try {
      await deps.provider.revokeCredentials({
        accessToken,
        refreshToken,
        externalInstallationId: active.externalInstallationId,
      });
      return true;
    } catch {
      // Local credential invalidation still proceeds so no future console path
      // can use the stored credentials. Structured event persistence lands with
      // the self-security/user-event sink.
      return false;
    }
  }

  private writeDependencies(providerId: UserIntegrationProvider): {
    readonly loginTransactions: ILoginTransactionStore;
    readonly opaqueValues: IConsoleOpaqueValueService;
    readonly secretEncryption: ISecretEncryptionService;
    readonly provider: IIntegrationProvider;
  } | null {
    const provider = this.options.providers.get(providerId);
    if (!this.options.loginTransactions ||
        !this.options.opaqueValues ||
        !this.options.secretEncryption ||
        !this.options.publicBaseUrl ||
        !provider?.authorizationConfigured) {
      return null;
    }
    return {
      loginTransactions: this.options.loginTransactions,
      opaqueValues: this.options.opaqueValues,
      secretEncryption: this.options.secretEncryption,
      provider,
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
    provider: UserIntegrationProvider,
    userId: string | null,
    reason: IntegrationCallbackRejectedReason,
  ): Promise<void> {
    try {
      await this.options.securityEventSink?.recordIntegrationCallbackRejected({
        type: 'console.auth.integration_callback_rejected.v1',
        userId,
        provider,
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
    return new URL(`${INTEGRATION_PATH}/github/callback`, normalizeBaseUrl(this.options.publicBaseUrl)).toString();
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

function requestedContentsPermission(body: unknown): Readonly<Record<string, unknown>> {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return { contents_permission: record.contents_permission === 'write' ? 'write' : 'read' };
}

function readBodyReturnTo(body: unknown): string {
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return normalizeConsoleReturnPath(record.return_to, INTEGRATION_PATH);
}

function singleQueryValue(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  return null;
}

function stringQueryParams(query: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value !== '') params[key] = value;
  }
  return params;
}

function providerNotFound(providerId: string): ConsoleHandlerResult {
  return {
    status: 404,
    body: {
      type: 'about:blank',
      title: 'Not found',
      status: 404,
      code: 'integration_provider_not_found',
      detail: `Integration provider '${providerId}' is not registered.`,
    },
  };
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

function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && left.equals(right);
}
