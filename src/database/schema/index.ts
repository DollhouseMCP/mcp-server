/**
 * Database Schema — Barrel Export
 *
 * All Drizzle table definitions for the DollhouseMCP database.
 * Used by drizzle-kit for migration generation and by the
 * application for type-safe queries.
 *
 * @since v2.2.0 — Phase 4, Step 4.1
 */

export { users, userSettings } from './users.js';
export { elements, elementTags, elementRelationships } from './elements.js';
export { elementProvenance } from './provenance.js';
export { memoryEntries } from './memories.js';
export { ensembleMembers } from './ensembles.js';
export { agentStates } from './agents.js';
export { sessions } from './sessions.js';
export { authAccounts, authIdentityEvents, authKv } from './auth.js';
// Phase 4.5 storage completion:
export { operatorSettings } from './operatorSettings.js';
export { sharedCache } from './sharedCache.js';
export { authSigningKeys } from './signingKeys.js';
export { userOauthTokens } from './userOauthTokens.js';
export { rateLimitState } from './rateLimitState.js';
export { securityAuditEvents } from './securityAuditEvents.js';
export { auditHmacKeys } from './auditHmacKeys.js';
// Sign-in allowlist:
export { authAllowlist } from './authAllowlist.js';
export type { AuthAllowlistKind, AuthAllowlistEntry } from './authAllowlist.js';
export {
  userAdminRoles,
  accountAllowlistEntries,
  consoleSessions,
  consoleLoginTransactions,
  userIntegrations,
  portfolioSyncJobs,
  idempotencyRecords,
  accountFactors,
  accountFactorBackupCodes,
  securityInvalidationEvents,
  securityInvalidationReplicaCursors,
  securityInvalidationReplicaLeases,
  securityInvalidationAcks,
  runtimeSessionPresence,
  runtimeControlCommands,
  runtimeControlAcks,
  adminAuditChainHeads,
  adminAuditEvents,
} from './webConsole.js';
export type {
  ConsoleAccountFactorType,
  ConsoleAdminRole,
  ConsoleLoginFlowKind,
  UserIntegrationProvider,
  UserIntegrationErrorReason,
  UserIntegrationStatus,
  PortfolioSyncDirection,
  PortfolioSyncConflictPolicy,
  PortfolioSyncJobStatus,
  ConsoleSecurityInvalidationKind,
  ConsoleSecurityInvalidationUrgency,
  RuntimeSessionTransport,
  RuntimeSessionStatus,
  RuntimeTerminationReason,
  RuntimeTerminationRequesterKind,
  RuntimeTerminationAckResult,
} from './webConsole.js';
