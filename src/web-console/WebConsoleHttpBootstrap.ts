import { readFile } from 'node:fs/promises';

import { env, type Env } from '../config/env.js';
import type { DiContainerFacade } from '../di/DiContainerFacade.js';
import type { AuthMethodId } from '../auth/embedded-as/AuthMethodFactory.js';
import { WebConsoleRegistrar, type WebConsoleRegistrarOptions, type WebConsoleComposition } from './WebConsoleRegistrar.js';
import { resolveWebConsoleProductionDatabaseVerificationFromEnv } from './WebConsoleProductionDatabaseReadiness.js';
import { verifyWebConsoleReplacementReadiness } from './WebConsoleReplacementReadiness.js';
import {
  parseWebConsoleReplacementReadinessEvidence,
  type WebConsoleReplacementReadinessEvidence,
} from './WebConsoleReplacementReadinessEvidence.js';

const REQUIRED_KEY_BYTES = 32;
const API_V1_MOUNT_REQUIRES_PUBLIC_BASE_URL =
  'DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED=true requires DOLLHOUSE_PUBLIC_BASE_URL';
const API_V1_REPLACEMENT_REFUSES_LEGACY_WEB_CONSOLE =
  'DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED=true replaces the legacy web console API; set DOLLHOUSE_HTTP_WEB_CONSOLE=false so legacy /api routes are not exposed';
const API_V1_REPLACEMENT_REQUIRES_EVIDENCE =
  'DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED=true requires DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE';

export type WebConsoleHttpBootstrapEnv = Pick<
  Env,
  | 'DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED'
  | 'DOLLHOUSE_HTTP_WEB_CONSOLE'
  | 'DOLLHOUSE_PUBLIC_BASE_URL'
  | 'DOLLHOUSE_HTTP_HOST'
  | 'DOLLHOUSE_AUTH_METHODS'
  | 'GITHUB_REPOSITORY'
  | 'DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_NAME'
  | 'DOLLHOUSE_WEB_CONSOLE_PRODUCTION_DATABASE_USER'
  | 'DOLLHOUSE_WEB_CONSOLE_OPAQUE_HMAC_KEY'
  | 'DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY'
  | 'DOLLHOUSE_WEB_CONSOLE_SECRET_ENCRYPTION_KEY_ID'
  | 'DOLLHOUSE_WEB_CONSOLE_PROTECTED_CORRELATION_HMAC_KEY'
  | 'DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE'
  | 'DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_ID'
  | 'DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_SECRET'
>;

export async function bootstrapWebConsoleHttpApiV1(
  container: DiContainerFacade,
  sourceEnv: WebConsoleHttpBootstrapEnv = env,
): Promise<WebConsoleComposition | null> {
  const options = resolveWebConsoleHttpBootstrapOptions(sourceEnv);
  if (!options) return null;
  const composition = await new WebConsoleRegistrar(options).bootstrapAndRegister(container);
  await assertWebConsoleReplacementEvidenceReady(
    composition,
    sourceEnv.DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE,
  );
  return composition;
}

export function resolveWebConsoleHttpBootstrapOptions(
  sourceEnv: WebConsoleHttpBootstrapEnv,
): WebConsoleRegistrarOptions | null {
  if (!sourceEnv.DOLLHOUSE_WEB_CONSOLE_API_V1_ENABLED) return null;
  if (sourceEnv.DOLLHOUSE_HTTP_WEB_CONSOLE) {
    throw new Error(API_V1_REPLACEMENT_REFUSES_LEGACY_WEB_CONSOLE);
  }
  if (!sourceEnv.DOLLHOUSE_PUBLIC_BASE_URL) {
    throw new Error(API_V1_MOUNT_REQUIRES_PUBLIC_BASE_URL);
  }
  if (!sourceEnv.DOLLHOUSE_WEB_CONSOLE_REPLACEMENT_READINESS_EVIDENCE) {
    throw new Error(API_V1_REPLACEMENT_REQUIRES_EVIDENCE);
  }
  const githubIntegrationProviderConfig = sourceEnv.DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_ID &&
    sourceEnv.DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_SECRET
    ? {
        clientId: sourceEnv.DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_ID,
        clientSecret: sourceEnv.DOLLHOUSE_INTEGRATION_GITHUB_CLIENT_SECRET,
      }
    : undefined;
  return {
    activationProfile: 'shared-hosted',
    deploymentSignal: {
      sharedHosted: true,
      httpHost: sourceEnv.DOLLHOUSE_HTTP_HOST,
      publicBaseUrl: sourceEnv.DOLLHOUSE_PUBLIC_BASE_URL,
      authMethods: normalizeAuthMethods(sourceEnv.DOLLHOUSE_AUTH_METHODS),
    },
    enableApiV1Mount: true,
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
    portfolioSyncRepositoryName: sourceEnv.GITHUB_REPOSITORY,
  };
}

export async function assertWebConsoleReplacementEvidenceReady(
  composition: Pick<WebConsoleComposition,
    'activationProfile' | 'apiV1Mount' | 'registry' | 'routesMounted' | 'storageBackend'
  >,
  evidencePath: string | undefined,
): Promise<void> {
  if (!evidencePath) {
    throw new Error(API_V1_REPLACEMENT_REQUIRES_EVIDENCE);
  }
  const evidence = await readReplacementReadinessEvidence(evidencePath);
  const result = verifyWebConsoleReplacementReadiness({
    composition,
    phase: 'pre-replacement',
    liveChecks: evidence.liveChecks,
  });
  if (!result.ready) {
    const details = result.failures.map(failure => `${failure.id}: ${failure.detail}`).join('; ');
    throw new Error(`Web console replacement readiness evidence is not ready: ${details}`);
  }
}

async function readReplacementReadinessEvidence(
  evidencePath: string,
): Promise<WebConsoleReplacementReadinessEvidence> {
  try {
    return parseWebConsoleReplacementReadinessEvidence(JSON.parse(await readFile(evidencePath, 'utf8')));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read web console replacement readiness evidence at ${evidencePath}: ${message}`);
  }
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
