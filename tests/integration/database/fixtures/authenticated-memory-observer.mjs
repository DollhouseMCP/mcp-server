/** Test-only preloader for the ACTUAL compiled CLI; never loaded by production. */
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const compiledRoot = process.env.DOLLHOUSE_PROOF_COMPILED_ROOT;
if (!compiledRoot || !process.send) throw new Error('Private compiled proof requires its owned IPC child');
const { TenantMemoryOperationProvider } = await import(pathToFileURL(path.join(compiledRoot, 'storage/TenantMemoryOperationProvider.js')));
const { DollhouseContainer } = await import(pathToFileURL(path.join(compiledRoot, 'di/Container.js')));
const { encodeMemoryCandidate } = await import(pathToFileURL(path.join(compiledRoot, 'storage/DatabaseMemoryCandidateEnvelope.js')));
const handles = new Map();
let armed = false;
let rootMemoryResolutions = 0;
let rootMemoryAttempts = 0;
const managerIds = new WeakMap();
const send = value => { if (process.connected) process.send(value); };
const serializeError = cause => ({ name: cause?.name ?? typeof cause, code: cause?.code ?? null,
  message: cause instanceof Error ? cause.message : String(cause) });
const digest = value => createHash('sha256').update(value).digest('hex');

function invalidate(record) {
  if (!record.active) return;
  record.active = false;
  record.memory = undefined;
  handles.delete(record.handle);
  record.release();
}
function requireActive(record) {
  if (!record || !record.active || !process.connected) throw new Error('Live child-local invocation handle required');
  record.provider.assertOperation(record.operation);
}
const originalResolve = TenantMemoryOperationProvider.prototype.resolve;
TenantMemoryOperationProvider.prototype.resolve = function (capture) {
  const tracker = this.tracker;
  const context = tracker.getContext();
  const original = Reflect.apply(originalResolve, this, [capture]);
  if (!armed || context?.session?.transport !== 'http' || context.metadata?.toolName !== 'mcp_aql_read') return original;
  armed = false;
  const provider = this;
  return original.then(async operation => {
    // This observer delays only the genuine resolve return; the original
    // request is STILL awaiting inside its original ContextTracker scope.
    provider.assertOperation(operation);
    if (!Object.isFrozen(context.session)) throw new Error('Expected server-created frozen session');
    const handle = randomUUID();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const record = { handle, active: true, busy: false, provider, operation, tracker, context, release, memory: undefined };
    handles.set(handle, record);
    if (!managerIds.has(operation.manager)) managerIds.set(operation.manager, randomUUID());
    send({ event: 'invocation-held', handle, manager: managerIds.get(operation.manager),
      session: context.session.sessionId, user: context.session.userId, request: context.requestId,
      tool: context.metadata.toolName });
    try {
      await held;
      // A released/disconnected handle can no longer serve internal commands.
      return operation;
    } finally { invalidate(record); }
  });
};

const originalSession = DollhouseContainer.prototype.createServerForHttpSession;
DollhouseContainer.prototype.createServerForHttpSession = function (session) {
  const result = Reflect.apply(originalSession, this, [session]);
  return result.then(attachment => {
    const dispose = attachment.dispose;
    attachment.dispose = function (...args) {
      for (const record of [...handles.values()]) {
        if (record.context.session.sessionId === session.sessionId) invalidate(record);
      }
      return Reflect.apply(dispose, this, args);
    };
    return attachment;
  });
};
const originalContainerResolve = DollhouseContainer.prototype.resolve;
DollhouseContainer.prototype.resolve = function (name, ...args) {
  if (name === 'MemoryManager') rootMemoryAttempts++;
  const result = Reflect.apply(originalContainerResolve, this, [name, ...args]);
  if (name === 'MemoryManager') rootMemoryResolutions++;
  return result;
};

async function command(message) {
  if (message.command === 'arm') { armed = true; return { armed: true }; }
  if (message.command === 'stats') return { active: handles.size, rootMemoryResolutions, rootMemoryAttempts };
  const record = handles.get(message.handle);
  if (!record || !record.active) throw new Error('Live child-local invocation handle required');
  if (record.busy) throw new Error('An internal command still owns this live invocation');
  if (message.command === 'release') { invalidate(record); return { released: true }; }
  record.busy = true;
  // No selector, new context, new provider, operation fabrication or qualifier.
  // Disposal/disconnect invalidates immediately, but does not cancel an
  // already running save or establish rollback. Its final check refuses.
  try { return await record.tracker.runAsync(record.context, async () => {
    requireActive(record);
    if (message.command === 'load') {
      const listed = await record.operation.manager.list({ strictDatabase: true });
      requireActive(record);
      if (listed.length !== 1) throw new Error('Owned central proof expects one selected memory');
      // MemoryManager.list returns genuine loaded Memory instances. Its
      // actual captured DB locator is carried by getFilePath, not filename.
      const memory = await record.operation.manager.load(listed[0].getFilePath());
      requireActive(record);
      record.memory = memory;
      const entries = [...memory.getEntries().values()];
      return { name: memory.metadata.name, entries: entries.length,
        entryDigest: digest(JSON.stringify(entries)), serializedDigest: digest(memory.serialize()) };
    }
    if (!record.memory) throw new Error('Actual selected memory must be loaded in this live scope');
    if (message.command === 'pending') {
      const pending = record.operation.manager.getPendingHeadUpdate(record.memory);
      if (!pending) return { status: null };
      const encoded = encodeMemoryCandidate(pending.candidate);
      return { status: pending.status, bytes: encoded.bytes.toString('hex'), digest: encoded.digest };
    }
    if (message.command === 'save') {
      if (typeof message.content !== 'string') throw new TypeError('Fixture append content required');
      await record.memory.addEntry(message.content, [], { fixture: 'internal-owner-cas' });
      requireActive(record);
      await record.memory.save();
      requireActive(record);
      return { saved: true, entryDigest: digest(JSON.stringify([...record.memory.getEntries().values()])) };
    }
    throw new Error('Unknown private proof command');
  }); } finally { record.busy = false; }
}
process.on('message', message => {
  if (!message || typeof message.id !== 'string') return;
  command(message).then(result => send({ id: message.id, result }), cause => send({ id: message.id, error: serializeError(cause) }));
});
process.once('disconnect', () => {
  for (const record of [...handles.values()]) invalidate(record);
});
process.once('exit', () => {
  for (const record of [...handles.values()]) invalidate(record);
});
send({ event: 'observer-ready' });
