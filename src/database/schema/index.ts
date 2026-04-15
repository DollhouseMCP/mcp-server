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
export { memoryEntries } from './memories.js';
export { ensembleMembers } from './ensembles.js';
export { agentStates } from './agents.js';
export { sessions } from './sessions.js';
