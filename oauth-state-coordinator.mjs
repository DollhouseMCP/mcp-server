import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// The OAuth parent and detached helper are separate processes. Monotonic,
// never-reused ticket slots provide cross-process ordering without deleting
// or replacing another owner's lock artifact. A matching .done marker releases
// a slot; abandoned slots are completed only after process-start verification.
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const CLAIM_STALE_MS = 30_000;
const LOCK_WAIT_SIGNAL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function lockDirectoryFor(stateFile) {
  return `${stateFile}.lock`;
}

function errorCode(error) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

function waitSync(milliseconds) {
  Atomics.wait(LOCK_WAIT_SIGNAL, 0, 0, milliseconds);
}

function ensureLockDirectorySync(lockDirectory) {
  fs.mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function linuxProcessIdentity(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fieldsAfterCommand = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
  const startTicks = fieldsAfterCommand[19];
  const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!startTicks || !bootId) return undefined;
  return `linux:${bootId}:${startTicks}`;
}

function commandProcessIdentity(executable, args, prefix) {
  const output = execFileSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1_000
  }).trim();
  return output ? `${prefix}:${output}` : undefined;
}

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !processExists(pid)) return null;
  try {
    if (process.platform === 'linux') return linuxProcessIdentity(pid);
    if (process.platform === 'darwin') {
      return commandProcessIdentity('/bin/ps', ['-p', String(pid), '-o', 'lstart='], 'darwin');
    }
    if (process.platform === 'win32') {
      return commandProcessIdentity(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`],
        'win32'
      );
    }
  } catch {
    // The process may exit between the liveness probe and identity lookup.
  }
  return processExists(pid) ? undefined : null;
}

function parseSlotOwnerSync(slotPath) {
  try {
    const owner = JSON.parse(fs.readFileSync(slotPath, 'utf8'));
    if (typeof owner?.id !== 'string' || owner.id.length === 0) return null;
    if (!Number.isSafeInteger(owner.ownerPid) || owner.ownerPid <= 0) return null;
    if (typeof owner.ownerIdentity !== 'string' || owner.ownerIdentity.length === 0) return null;
    return owner;
  } catch {
    return null;
  }
}

function ownerIsStillActive(owner) {
  if (!owner) return false;
  const currentIdentity = processIdentity(owner.ownerPid);
  // An unavailable identity probe fails closed; a later scan can retry.
  return currentIdentity === undefined || currentIdentity === owner.ownerIdentity;
}

function slotIsStale(slotPath) {
  return Date.now() - fs.statSync(slotPath).mtimeMs >= CLAIM_STALE_MS;
}

function ticketFromSlotName(name) {
  const match = /^(\d+)\.slot$/.exec(name);
  if (!match) return null;
  const ticket = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(ticket) && ticket > 0 ? ticket : null;
}

function listTicketSlotsSync(lockDirectory) {
  let entries;
  try {
    entries = fs.readdirSync(lockDirectory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter(entry => entry.isFile())
    .map(entry => ({ entry, ticket: ticketFromSlotName(entry.name) }))
    .filter(item => item.ticket !== null)
    .map(item => ({
      ticket: item.ticket,
      slotPath: `${lockDirectory}/${item.entry.name}`,
      donePath: `${lockDirectory}/${item.ticket}.done`
    }));
}

function publishDoneSync(donePath) {
  try {
    fs.writeFileSync(donePath, '', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
}

function slotIsOutstandingSync(slot) {
  if (fs.existsSync(slot.donePath)) return false;
  try {
    if (!slotIsStale(slot.slotPath)) return true;
    const owner = parseSlotOwnerSync(slot.slotPath);
    if (ownerIsStillActive(owner)) return true;
    // Completion is an atomic create. The immutable slot remains as the
    // high-water mark, so its ticket can never be allocated again.
    publishDoneSync(slot.donePath);
    return false;
  } catch (error) {
    return errorCode(error) !== 'ENOENT';
  }
}

function allocateTicketSync(lockDirectory) {
  ensureLockDirectorySync(lockDirectory);
  const ownerIdentity = processIdentity(process.pid);
  if (typeof ownerIdentity !== 'string') {
    throw new TypeError('Unable to determine process identity for OAuth state locking');
  }

  while (true) {
    const slots = listTicketSlotsSync(lockDirectory);
    const highestTicket = slots.reduce((highest, slot) => Math.max(highest, slot.ticket), 0);
    const ticket = highestTicket + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error('OAuth state lock ticket space exhausted');
    const slotPath = `${lockDirectory}/${ticket}.slot`;
    try {
      fs.writeFileSync(
        slotPath,
        JSON.stringify({ id: randomUUID(), ownerPid: process.pid, ownerIdentity }),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 }
      );
      return { ticket, slotPath, donePath: `${lockDirectory}/${ticket}.done`, lockDirectory };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
  }
}

function earlierOutstandingSlotExistsSync(claim) {
  return listTicketSlotsSync(claim.lockDirectory)
    .some(slot => slot.ticket < claim.ticket && slotIsOutstandingSync(slot));
}

function lockTimeoutError(lockDirectory) {
  return new Error(`Timed out waiting for OAuth state lock: ${lockDirectory}`);
}

function acquireLockSync(lockDirectory) {
  const claim = allocateTicketSync(lockDirectory);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  try {
    while (earlierOutstandingSlotExistsSync(claim)) {
      if (Date.now() >= deadline) throw lockTimeoutError(lockDirectory);
      waitSync(LOCK_RETRY_MS);
    }
    return claim;
  } catch (error) {
    publishDoneSync(claim.donePath);
    throw error;
  }
}

async function acquireLock(lockDirectory) {
  const claim = allocateTicketSync(lockDirectory);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  try {
    while (earlierOutstandingSlotExistsSync(claim)) {
      if (Date.now() >= deadline) throw lockTimeoutError(lockDirectory);
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
    return claim;
  } catch (error) {
    publishDoneSync(claim.donePath);
    throw error;
  }
}

export function withOAuthStateLockSync(stateFile, operation) {
  const claim = acquireLockSync(lockDirectoryFor(stateFile));
  try {
    return operation();
  } finally {
    publishDoneSync(claim.donePath);
  }
}

export async function withOAuthStateLock(stateFile, operation) {
  const claim = await acquireLock(lockDirectoryFor(stateFile));
  try {
    return await operation();
  } finally {
    publishDoneSync(claim.donePath);
  }
}

export function writeFileAtomicallySync(filePath, serializedState, mode = 0o600) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, serializedState, { encoding: 'utf8', mode });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The rename consumed the temporary file, or cleanup is best-effort.
    }
  }
}
