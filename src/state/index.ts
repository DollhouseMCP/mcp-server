/**
 * State Persistence Module
 *
 * Typed repository interfaces and implementations for session-scoped
 * state persistence. Each store is bound to a single session at
 * construction and handles one domain concept.
 *
 * @module state
 * @since v2.1.0 — Issue #1945
 */

// Interfaces
export type { IActivationStateStore } from './IActivationStateStore.js';
export type { PersistedActivation, PersistedActivationState, PersistedActivationStateSnapshot } from './IActivationStateStore.js';
export type { IConfirmationStore } from './IConfirmationStore.js';
export type { IChallengeStore } from './IChallengeStore.js';

// File-backed implementations
export { FileActivationStateStore } from './FileActivationStateStore.js';
export { FileConfirmationStore } from './FileConfirmationStore.js';
export { FileChallengeStore } from './FileChallengeStore.js';

// Database-backed implementations
export { DatabaseActivationStateStore } from './DatabaseActivationStateStore.js';
export { DatabaseConfirmationStore } from './DatabaseConfirmationStore.js';
export { DatabaseChallengeStore } from './DatabaseChallengeStore.js';

// In-memory implementations
export { InMemoryChallengeStore } from './InMemoryChallengeStore.js';

// Persistence infrastructure
export { PersistQueue, type PersistQueueOptions } from './PersistQueue.js';

// Session activation state
export type { SessionActivationState, SessionUserIdentity } from './SessionActivationState.js';
export { createSessionActivationState, SessionActivationRegistry } from './SessionActivationState.js';
