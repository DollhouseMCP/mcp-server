import type { Router } from 'express';
import type { DatabaseInstance } from '../../database/connection.js';
import type { IRateLimitStore } from '../../auth/embedded-as/storage/IRateLimitStore.js';
import type { TransactionalEmailSender } from '../../auth/embedded-as/methods/TransactionalEmailSender.js';
import { GitHubOAuthTokenClient } from '../../auth/github/GitHubOAuthTokenClient.js';
import { GitHubAuthenticatedUserClient } from '../../auth/github/GitHubAuthenticatedUserClient.js';
import { DatabaseAuditSink, appendSecurityAuditEventWithTx } from '../../security/auditSink.js';
import { PostgresAdminAuditWriter, type AdminAuditHmacKeyResolver } from '../../web-console/audit/PostgresAdminAuditWriter.js';
import { createDurableInvitationAdminModule } from '../../web-console/modules/account-admin/DurableInvitationAdminModule.js';
import { createDurableInvitationAdminAuditFactory } from '../../web-console/modules/account-admin/DurableInvitationAdminAudit.js';
import { ROLE_DESCRIPTIONS } from '../../web-console/modules/account-admin/AccountAdminRoleDescriptions.js';
import type { ConsoleModuleDescriptor } from '../../web-console/platform/ConsolePlatformTypes.js';
import type { IConsoleOpaqueValueService } from '../../web-console/security/ConsoleOpaqueValues.js';
import { invitationPublicOrigin } from '../InvitationClaimLink.js';
import { InvitationDeliveryService } from '../InvitationDeliveryService.js';
import { PostgresInvitationManagementStore } from '../PostgresInvitationManagementStore.js';
import { PostgresInvitationDeliveryStore } from '../PostgresInvitationDeliveryStore.js';
import { PostgresInvitationClaimStore } from '../PostgresInvitationClaimStore.js';
import { PostgresInvitationActivationStore } from '../PostgresInvitationActivationStore.js';
import { PostgresOnboardingStore } from './PostgresOnboardingStore.js';
import { PostgresOnboardingMetadataStore } from './PostgresOnboardingMetadataStore.js';
import { OnboardingCredentials } from './OnboardingCredentials.js';
import { GitHubEnrollmentOAuthStateService } from './GitHubEnrollmentOAuthState.js';
import { PostgresGitHubEnrollmentOAuthStateStore } from './PostgresGitHubEnrollmentOAuthStateStore.js';
import { GitHubEnrollmentOrchestrationService } from './GitHubEnrollmentOrchestrationService.js';
import { createOnboardingRouter } from './OnboardingRouter.js';
import { createOnboardingClaimPageRouter } from './OnboardingClaimPage.js';

export interface OnboardingCompositionOptions {
  readonly database: DatabaseInstance;
  readonly opaqueValues: IConsoleOpaqueValueService;
  readonly rateLimits: IRateLimitStore;
  readonly adminAuditKeys: AdminAuditHmacKeyResolver;
  readonly publicBaseUrl: string;
  readonly supportEmail: string;
  readonly github: { readonly clientId: string; readonly clientSecret: string };
  /** Explicit null keeps immediate manual-copy invitations available without sending email. */
  readonly sender: TransactionalEmailSender | null;
  /** Deterministic provider adapter for tests; production uses bounded fixed-endpoint clients. */
  readonly githubFetch?: typeof fetch;
}
export interface OnboardingComposition {
  readonly adminModule: ConsoleModuleDescriptor;
  /** Mount at /auth/onboarding, before generic body parsing, caching and request logging. */
  readonly apiRouter: Router;
  /** Owns only the exact /auth/onboarding/invitation path and its nonce policy. */
  readonly claimPageRouter: Router;
}

/** Constructs an unregistered composition; no network, startup mount, or environment opt-in. */
export function createOnboardingComposition(options: OnboardingCompositionOptions): OnboardingComposition {
  const origin = invitationPublicOrigin(options.publicBaseUrl);
  const callbackUri = `${origin}/auth/onboarding/github/callback`;
  const { database: db, opaqueValues, rateLimits, adminAuditKeys } = options;
  if (!db?.transaction || !opaqueValues?.hashOpaqueValue || !rateLimits?.update || !adminAuditKeys?.resolve ||
      (options.sender !== null && typeof options.sender?.sendTransactionalEmail !== 'function')) {
    throw new Error('Invalid onboarding composition configuration');
  }
  const claimPageRouter = createOnboardingClaimPageRouter(options.supportEmail);
  const credentials = new OnboardingCredentials(opaqueValues);
  const store = new PostgresOnboardingStore(db, new PostgresInvitationClaimStore(db));
  const activationAudit = { kind: 'system' as const, appendSecurityEvent: appendSecurityAuditEventWithTx };
  const githubEnrollment = new GitHubEnrollmentOrchestrationService({
    state: new GitHubEnrollmentOAuthStateService(new PostgresGitHubEnrollmentOAuthStateStore(db, store), opaqueValues,
      { clientId: options.github.clientId, callbackUri }),
    tokens: new GitHubOAuthTokenClient({ clientId: options.github.clientId, clientSecret: options.github.clientSecret,
      callbackUrl: callbackUri, fetchImpl: options.githubFetch }),
    users: new GitHubAuthenticatedUserClient({ fetchImpl: options.githubFetch }),
    activation: new PostgresInvitationActivationStore(db, store), activationAudit, audit: new DatabaseAuditSink(db),
  });
  const delivery = new InvitationDeliveryService(new PostgresInvitationDeliveryStore(db), options.sender, {
    publicBaseUrl: origin, supportEmail: options.supportEmail,
    describeRole: role => ({ name: ROLE_DESCRIPTIONS[role].name, description: ROLE_DESCRIPTIONS[role].summary }),
  });
  return {
    claimPageRouter,
    apiRouter: createOnboardingRouter({ store, credentials, rateLimits, trustedOrigin: origin, audit: activationAudit,
      metadataReader: new PostgresOnboardingMetadataStore(db, store), githubEnrollment }),
    adminModule: createDurableInvitationAdminModule({ store: new PostgresInvitationManagementStore(db),
      auditFactory: createDurableInvitationAdminAuditFactory(adminAuditKeys), auditWriter: new PostgresAdminAuditWriter(db, adminAuditKeys),
      rateLimits, publicBaseUrl: origin, delivery }),
  };
}
