import { resolvePrivateBetaOnboardingConfiguration, type PrivateBetaOnboardingEnv } from '../invitations/onboarding/PrivateBetaOnboardingConfiguration.js';

import { env, type Env } from '../config/env.js';
import { isLoopbackHost } from '../auth/oauth/url.js';
import { logger } from '../utils/logger.js';
import type { DiContainerFacade } from '../di/DiContainerFacade.js';
import type { AuthMethodId } from '../auth/embedded-as/AuthMethodFactory.js';
import { WebConsoleRegistrar, type WebConsoleRegistrarOptions, type WebConsoleComposition } from './WebConsoleRegistrar.js';
import { resolveWebConsoleProductionDatabaseVerificationFromEnv } from './WebConsoleProductionDatabaseReadiness.js';

const REQUIRED_KEY_BYTES = 32;
const API_V1_MOUNT_REQUIRES_PUBLIC_BASE_URL =
  'DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED=true requires DOLLHOUSE_PUBLIC_BASE_URL';
const API_V1_REPLACEMENT_REFUSES_LEGACY_WEB_CONSOLE =
  'DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED=true replaces the legacy web console API; set DOLLHOUSE_HTTP_WEB_CONSOLE=false so legacy /api routes are not exposed';

export type WebConsoleHttpBootstrapEnv = Pick<
  Env,
  | 'DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED'
  | 'DOLLHOUSE_WEB_CONSOLE_PORTFOLIO_WRITE_ROUTES_ENABLED'
  | 'DOLLHOUSE_WEB_CONSOLE_COLLECTION_ENABLED'
  | 'DOLLHOUSE_WEB_CONSOLE_ALLOWLIST_ROUTES_ENABLED'
  | 'DOLLHOUSE_WEB_CONSOLE_CANARY_INTERVAL_MINUTES'
  | 'DOLLHOUSE_HTTP_WEB_CONSOLE'
  | 'DOLLHOUSE_PUBLIC_BASE_URL'
  | 'DOLLHOUSE_HTTP_HOST'
  | 'DOLLHOUSE_AUTH_METHODS'
  | 'GITHUB_REPOSITORY'
  | 'GITHUB_TOKEN'
  | 'DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_NAME'
  | 'DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_USER'
  | 'DOLLHOUSE_WEB_CONSOLE_OPAQUE_HMAC_KEY'
  | 'DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY'
  | 'DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY_ID'
  | 'DOLLHOUSE_WEB_CONSOLE_PROTECTED_CORRELATION_HMAC_KEY'
  | 'DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE'
  | 'DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_ID'
  | 'DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_SECRET'
  | 'DOLLHOUSE_INTEGRATION_DESCRIPTOR_SEED_DIR'
> & Partial<PrivateBetaOnboardingEnv>;

export async function bootstrapWebConsoleHttpApiV1(
  container: DiContainerFacade,
  sourceEnv: WebConsoleHttpBootstrapEnv = env,
): Promise<WebConsoleComposition | null> {
  const options = resolveWebConsoleHttpBootstrapOptions(sourceEnv);
  if (!options) return null;
  return await new WebConsoleRegistrar(options).bootstrapAndRegister(container);
}

export function resolveWebConsoleHttpBootstrapOptions(
  sourceEnv: WebConsoleHttpBootstrapEnv,
): WebConsoleRegistrarOptions | null {
  const onboardingConfiguration = resolvePrivateBetaOnboardingConfiguration(sourceEnv as PrivateBetaOnboardingEnv);
  if (!sourceEnv.DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED) return null;
  if (sourceEnv.DOLLHOUSE_HTTP_WEB_CONSOLE) {
    throw new Error(API_V1_REPLACEMENT_REFUSES_LEGACY_WEB_CONSOLE);
  }
  if (!sourceEnv.DOLLHOUSE_PUBLIC_BASE_URL) {
    throw new Error(API_V1_MOUNT_REQUIRES_PUBLIC_BASE_URL);
  }
  warnRetiredReadinessEvidenceVariable(sourceEnv);
  warnCollectionBrowseWithoutGitHubToken(sourceEnv);
  const githubIntegrationProviderConfig = sourceEnv.DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_ID &&
    sourceEnv.DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_SECRET
    ? {
        clientId: sourceEnv.DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_ID,
        clientSecret: sourceEnv.DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_SECRET,
      }
    : undefined;
  return {
    onboardingConfiguration,
    activationProfile: 'shared-hosted',
    deploymentSignal: {
      sharedHosted: true,
      httpHost: sourceEnv.DOLLHOUSE_HTTP_HOST,
      publicBaseUrl: sourceEnv.DOLLHOUSE_PUBLIC_BASE_URL,
      authMethods: normalizeAuthMethods(sourceEnv.DOLLHOUSE_AUTH_METHODS),
    },
    enableApiV1Mount: true,
    enablePortfolioWriteRoutes: sourceEnv.DOLLHOUSE_WEB_CONSOLE_PORTFOLIO_WRITE_ROUTES_ENABLED,
    enableCollectionRoutes: sourceEnv.DOLLHOUSE_WEB_CONSOLE_COLLECTION_ENABLED,
    enableAccountAllowlistRoutes: sourceEnv.DOLLHOUSE_WEB_CONSOLE_ALLOWLIST_ROUTES_ENABLED,
    canaryIntervalMs: sourceEnv.DOLLHOUSE_WEB_CONSOLE_CANARY_INTERVAL_MINUTES * 60_000,
    requireExplicitProductionAdapterMetadata: true,
    productionDatabaseVerification: resolveWebConsoleProductionDatabaseVerificationFromEnv(sourceEnv),
    publicBaseUrl: sourceEnv.DOLLHOUSE_PUBLIC_BASE_URL,
    opaqueValueHmacKey: decodeBase64Key(
      sourceEnv.DOLLHOUSE_WEB_CONSOLE_OPAQUE_HMAC_KEY,
      'DOLLHOUSE_WEB_CONSOLE_OPAQUE_HMAC_KEY',
    ),
    secretEncryptionKey: {
      keyId: sourceEnv.DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY_ID,
      key: decodeBase64Key(
        sourceEnv.DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY,
        'DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY',
      ),
    },
    protectedCorrelationSelectorHmacKey: decodeBase64Key(
      sourceEnv.DOLLHOUSE_WEB_CONSOLE_PROTECTED_CORRELATION_HMAC_KEY,
      'DOLLHOUSE_WEB_CONSOLE_PROTECTED_CORRELATION_HMAC_KEY',
    ),
    githubIntegrationProviderConfig,
    integrationDescriptorSeedDir: sourceEnv.DOLLHOUSE_INTEGRATION_DESCRIPTOR_SEED_DIR,
    portfolioSyncRepositoryName: sourceEnv.GITHUB_REPOSITORY,
    reportCleanupError: ({ store, error }) => {
      logger.error('[WebConsole] Scheduled store cleanup failed', {
        store,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  };
}

/**
 * Hosted collection-browse token nudge. Catalog browse makes server-funded
 * outbound GitHub calls; without GITHUB_TOKEN those fall under GitHub's
 * unauthenticated budget of 60 requests/hour per egress IP, shared across
 * every console user AND portfolio sync. Warn (never fail — the surface
 * degrades gracefully to cached/empty responses) so operators of non-loopback
 * deployments set a token. Skip for loopback binds: dev/CI doesn't need the
 * nudge, and a single local user rarely exhausts the anonymous budget.
 */
function warnCollectionBrowseWithoutGitHubToken(sourceEnv: WebConsoleHttpBootstrapEnv): void {
  if (!sourceEnv.DOLLHOUSE_WEB_CONSOLE_COLLECTION_ENABLED) return;
  if (sourceEnv.GITHUB_TOKEN) return;
  if (isLoopbackHost(sourceEnv.DOLLHOUSE_HTTP_HOST)) return;
  logger.warn(
    '[WebConsoleHttpBootstrap] Collection browse is enabled (DOLLHOUSE_WEB_CONSOLE_COLLECTION_ENABLED=true) ' +
    `on a non-loopback bind '${sourceEnv.DOLLHOUSE_HTTP_HOST}' without GITHUB_TOKEN. Catalog fetches will ` +
    "use GitHub's unauthenticated rate budget (60 requests/hour per egress IP), shared across all console " +
    'users and portfolio sync. Set GITHUB_TOKEN to a zero-scope personal access token — public catalog ' +
    'reads need no scopes, and scopes like public_repo would grant public-repository write — to raise ' +
    'the budget to 5,000 requests/hour.',
  );
}

/**
 * The console used to refuse to start without an operator-written readiness
 * evidence file. That requirement is gone and the file is never read. A
 * deployment that still sets the variable keeps starting; it is told once
 * that the setting does nothing.
 */
function warnRetiredReadinessEvidenceVariable(sourceEnv: WebConsoleHttpBootstrapEnv): void {
  if (!sourceEnv.DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE) return;
  logger.warn(
    '[WebConsoleHttpBootstrap] DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE is set but is no longer used. ' +
    'The web console does not read a readiness evidence file and starts without one. Remove the variable.',
  );
}

function decodeBase64Key(value: string | undefined, name: string): Buffer {
  if (!value) {
    throw new Error(`${name} must be set to a base64-encoded 32-byte key when DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED=true`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== REQUIRED_KEY_BYTES) {
    throw new Error(`${name} must decode to exactly ${REQUIRED_KEY_BYTES} bytes`);
  }
  return decoded;
}

function normalizeAuthMethods(methods: readonly string[] | undefined): readonly AuthMethodId[] {
  return (methods ?? ['trivial-consent']) as readonly AuthMethodId[];
}
