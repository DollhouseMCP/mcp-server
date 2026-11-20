import assert from 'node:assert/strict';
import { archivedHandler, archivedAql, archivedSession, archivedSignal } from './compiled-fragments.mjs';

export function fixture() {
  let callback;
  let saveStarted = false;
  let saveFinished = false;
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const origin = { sessionId: 'fixture-session', context: Object.freeze({ subject: 'fixture-owner' }) };
  const warnings = [];
  const events = [];
  const logger = { debug() {}, info() {}, warn(value) { warnings.push(value); }, error(value) { warnings.push(value); } };
  const Handler = archivedHandler({ logger, STORAGE_LAYER_CONFIG: { MEMORY_SAVE_DEBOUNCE_MS: 2000 },
    setTimeout(fn, delay) { assert.equal(delay, 2000); callback = fn; return { unref() {} }; }, clearTimeout() {} });
  const handler = new Handler();
  Object.assign(handler, {
    pendingSaves: new Map(), failedMemorySaves: new Map(), memorySaveAttempts: new Map(),
    saveFrequencyCounters: new Map(), debounceMetrics: { coalesced: 0, written: 0 },
    requireLegacyDeferred() {}, observeDeferredRefusal() { return false; }, reportGuardedPending() {},
    checkOrigin(actual) { assert.equal(actual.sessionId, origin.sessionId); assert.equal(actual.context, origin.context); },
    memorySaveKey() { return 'fixture-session:memory'; }, trackSaveFrequency() {},
    removalWarningFields() { return {}; },
    deleteByPrefix(map, prefix) { events.push('memory-cleanup'); for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key); },
    runInOrigin(actual, fn) { assert.equal(actual.context, origin.context); return fn(); },
  });
  const candidate = { async addEntry() { return { id: 'entry', timestamp: new Date(0), trustLevel: 'trusted' }; } };
  const memory = {
    captureAppendState() { return {}; }, getPolicyRemovedCount() { return 0; },
    createAppendCandidate() { return candidate; }, commitAppendCandidate() { return true; },
  };
  const manager = {
    async assertPersistable() {},
    async save(actual) { assert.equal(actual, memory); saveStarted = true; await barrier; saveFinished = true; },
  };
  return { handler, memory, manager, origin, logger, events, warnings, fire() { assert.ok(callback); callback(); }, release,
    get saveStarted() { return saveStarted; }, get saveFinished() { return saveFinished; } };
}

export async function append(f) {
  return f.handler.appendValidated('memory', f.memory, f.manager, 'fixture-session:memory', undefined,
    { content: 'entry', tags: [], metadata: {}, origin: f.origin });
}

export function signalFromArchivedFragments(f, exitProcess, beforeClose = () => {}) {
  const AqL = archivedAql({ logger: f.logger });
  const aql = new AqL();
  Object.assign(aql, {
    memoryProvider: false, memorySaveHandler: f.handler, requireOrdinary(value) { return value; },
    deleteByPrefix() { f.events.push('aql-cleanup'); }, executingAgents: new Map(), abortedGoals: new Map(),
    verificationRateLimiters: new Map(), deadlockReliefIssuanceLimiters: new Map(),
    permissionPromptLimiters: new Map(), cliApprovalLimiters: new Map(),
  });
  const Session = archivedSession({ logger: f.logger });
  const child = new Session();
  child.sessionId = 'fixture-session';
  child.disposeSessionServices = async () => { f.events.push('dispose-services'); };
  child.parent = { resolve(name) {
    return { SessionActivationRegistry: { dispose() {} }, gatekeeper: { disposeSession() {} }, mcpAqlHandler: aql }[name];
  } };
  const session = { transport: { async close() { f.events.push('transport-close'); } },
    attachment: { async dispose() { await child.dispose(); f.events.push('attachment-disposed'); } } };
  return archivedSignal({
    logger: f.logger, sessions: new Map([['fixture-session', session]]), sessionTelemetry: { disposed: 0 },
    clearSessionTimer() {}, options: {}, pooledSessions: [], clearInterval() {},
    disposePreparedSession: async () => {},
    httpServer: { closeAllConnections() { f.events.push('close-connections'); }, close(fn) { f.events.push('http-close'); beforeClose(); fn(); } },
    process: exitProcess, console,
  });
}
