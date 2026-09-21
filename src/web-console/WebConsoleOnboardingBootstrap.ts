import type { DatabaseInstance } from '../database/connection.js';
import type { IAuthStorageLayer } from '../auth/embedded-as/storage/IAuthStorageLayer.js';
import type { IRateLimitStore } from '../auth/embedded-as/storage/IRateLimitStore.js';
import { PostgresAuthStorageLayer } from '../auth/embedded-as/storage/PostgresAuthStorageLayer.js';
import { PostgresRateLimitStore } from '../auth/embedded-as/storage/PostgresRateLimitStore.js';
import { NodemailerEmailSender } from '../auth/embedded-as/methods/nodemailerEmailSender.js';
import { assertOnboardingSchemaReady } from '../invitations/onboarding/OnboardingSchemaPreflight.js';
import { invitationPublicOrigin } from '../invitations/InvitationClaimLink.js';
import type { PrivateBetaOnboardingConfiguration } from '../invitations/onboarding/PrivateBetaOnboardingConfiguration.js';
import type { OnboardingComposition } from '../invitations/onboarding/createOnboardingComposition.js';
import type { AdminAuditHmacKeyResolver } from './audit/PostgresAdminAuditWriter.js';
import type { IConsoleOpaqueValueService } from './security/ConsoleOpaqueValues.js';

export interface WebConsoleOnboardingBootstrapOptions {
  readonly configuration?: PrivateBetaOnboardingConfiguration | null;
  readonly database?: DatabaseInstance;
  readonly authStorage: IAuthStorageLayer | null;
  readonly rateLimits: IRateLimitStore | null;
  readonly opaqueValues: IConsoleOpaqueValueService;
  readonly adminAuditKeys?: AdminAuditHmacKeyResolver;
  readonly apiEnabled: boolean;
  readonly sharedHosted: boolean;
  readonly accountAdminEnabled: boolean;
  readonly publicBaseUrl?: string;
}

/** No registration is observable until dependency validation and SMTP readiness succeed. */
export async function bootstrapWebConsoleOnboarding(
  options: WebConsoleOnboardingBootstrapOptions,
): Promise<OnboardingComposition | null> {
  if (!options.configuration) return null;
  const configuration = structuredClone(options.configuration);
  const { database, authStorage, rateLimits, opaqueValues, adminAuditKeys } = options;
  if (!options.apiEnabled || !options.sharedHosted || !options.accountAdminEnabled ||
      invitationPublicOrigin(options.publicBaseUrl ?? '') !== configuration.publicBaseUrl || !database?.transaction ||
      !(authStorage instanceof PostgresAuthStorageLayer) || !authStorage.usesDatabase(database) ||
      !(rateLimits instanceof PostgresRateLimitStore) || !rateLimits.usesDatabase(database) ||
      !opaqueValues?.hashOpaqueValue || !adminAuditKeys?.resolve) {
    throw new Error('Private beta onboarding requires the activated console API and shared PostgreSQL authentication, rate limiting, and audit dependencies.');
  }
  await assertOnboardingSchemaReady(database);
  let sender: NodemailerEmailSender | null = null;
  if (configuration.smtp.state === 'enabled') {
    sender = new NodemailerEmailSender(configuration.smtp.options);
    try {
      await sender.verify();
    } catch {
      throw new Error('Private beta onboarding SMTP readiness verification failed.');
    }
  }
  const { createOnboardingComposition } = await import('../invitations/onboarding/createOnboardingComposition.js');
  return createOnboardingComposition({ database, opaqueValues, rateLimits, adminAuditKeys,
    publicBaseUrl: configuration.publicBaseUrl, supportEmail: configuration.supportEmail,
    github: configuration.github, sender });
}
