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
const PROCESS_IDENTITY_COMMAND_TIMEOUT_MS = 5_000;
const LOCK_WAIT_SIGNAL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
let cachedCurrentProcessIdentity;

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

function commandProcessIdentity(executable, args, prefix, deadline) {
  const remainingTime = deadline - Date.now();
  if (remainingTime <= 0) return undefined;
  const output = execFileSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: Math.min(PROCESS_IDENTITY_COMMAND_TIMEOUT_MS, remainingTime)
  }).trim();
  return output ? `${prefix}:${output}` : undefined;
}

function windowsSystemExecutables() {
  const windowsRoot = process.env.SystemRoot;
  const rootMatch = /^([A-Z]:)\\Windows$/i.exec(windowsRoot ?? '');
  if (!rootMatch) return null;
  return {
    powershell: String.raw`${windowsRoot}\System32\WindowsPowerShell\v1.0\powershell.exe`,
    pwsh: String.raw`${rootMatch[1]}\Program Files\PowerShell\7\pwsh.exe`,
    wmic: String.raw`${windowsRoot}\System32\wbem\WMIC.exe`
  };
}

function windowsManagementIdentity(pid, deadline) {
  const executables = windowsSystemExecutables();
  if (!executables) return undefined;
  const powershellArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$started = [DateTimeOffset]((Get-Process -Id ${pid}).StartTime); $started.ToUnixTimeMilliseconds()`
  ];
  for (const executable of [executables.powershell, executables.pwsh]) {
    try {
      const identity = commandProcessIdentity(executable, powershellArgs, 'win32', deadline);
      if (identity) return identity;
    } catch {
      // Try the next independent Windows process-management interface.
    }
  }

  const remainingTime = deadline - Date.now();
  if (remainingTime <= 0) return undefined;
  try {
    const output = execFileSync(
      executables.wmic,
      ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: Math.min(PROCESS_IDENTITY_COMMAND_TIMEOUT_MS, remainingTime)
      }
    );
    const match = /CreationDate=(\d{14})\.(\d{6})([+-]\d{3})/.exec(output);
    if (!match) return undefined;
    const timestamp = match[1];
    const localMilliseconds = Date.UTC(
      Number.parseInt(timestamp.slice(0, 4), 10),
      Number.parseInt(timestamp.slice(4, 6), 10) - 1,
      Number.parseInt(timestamp.slice(6, 8), 10),
      Number.parseInt(timestamp.slice(8, 10), 10),
      Number.parseInt(timestamp.slice(10, 12), 10),
      Number.parseInt(timestamp.slice(12, 14), 10),
      Number.parseInt(match[2].slice(0, 3), 10)
    );
    const utcMilliseconds = localMilliseconds - Number.parseInt(match[3], 10) * 60_000;
    return Number.isFinite(utcMilliseconds) ? `win32:${utcMilliseconds}` : undefined;
  } catch {
    return undefined;
  }
}

function processIdentity(pid, deadline) {
  if (Date.now() >= deadline) return undefined;
  if (!Number.isSafeInteger(pid) || pid <= 0 || !processExists(pid)) return null;
  try {
    if (process.platform === 'linux') return linuxProcessIdentity(pid);
    if (process.platform === 'darwin') {
      return commandProcessIdentity('/bin/ps', ['-p', String(pid), '-o', 'lstart='], 'darwin', deadline);
    }
    if (process.platform === 'win32') return windowsManagementIdentity(pid, deadline);
  } catch {
    // The process may exit between the liveness probe and identity lookup.
  }
  return processExists(pid) ? undefined : null;
}

function currentProcessIdentity(deadline) {
  if (typeof cachedCurrentProcessIdentity === 'string') return cachedCurrentProcessIdentity;
  const identity = processIdentity(process.pid, deadline);
  if (typeof identity === 'string') cachedCurrentProcessIdentity = identity;
  return identity;
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

function ownerIsStillActive(owner, deadline) {
  if (!owner) return false;
  const currentIdentity = owner.ownerPid === process.pid
    ? currentProcessIdentity(deadline)
    : processIdentity(owner.ownerPid, deadline);
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

function allocationIntentSnapshotSync(lockDirectory) {
  try {
    return {
      entries: fs.readdirSync(lockDirectory, { withFileTypes: true }),
      publishedOwnerIds: new Set(
        listTicketSlotsSync(lockDirectory)
          .map(slot => parseSlotOwnerSync(slot.slotPath)?.id)
          .filter(id => typeof id === 'string')
      )
    };
  } catch {
    return null;
  }
}

function allocationIntentBlocksCompactionSync(intentPath, publishedOwnerIds, deadline) {
  try {
    const owner = parseSlotOwnerSync(intentPath);
    if (owner && publishedOwnerIds.has(owner.id)) {
      // The private inode was already linked to an immutable numbered slot.
      // Retry a failed finally-cleanup without treating it as an allocator.
      fs.unlinkSync(intentPath);
      return false;
    }
    if (!slotIsStale(intentPath)) return true;
    if (ownerIsStillActive(owner, deadline)) return true;
    fs.unlinkSync(intentPath);
    return false;
  } catch (error) {
    return errorCode(error) !== 'ENOENT';
  }
}

function otherAllocationIntentExistsSync(lockDirectory, ownStagedSlotPath, deadline) {
  const snapshot = allocationIntentSnapshotSync(lockDirectory);
  if (!snapshot) return true;
  return snapshot.entries.some(entry => {
    if (!entry.isFile() || !entry.name.endsWith('.slot.tmp')) return false;
    const intentPath = `${lockDirectory}/${entry.name}`;
    return intentPath !== ownStagedSlotPath &&
      allocationIntentBlocksCompactionSync(intentPath, snapshot.publishedOwnerIds, deadline);
  });
}

function cleanupOrphanedDoneMarkersSync(lockDirectory, preservedTicket) {
  let entries;
  try {
    entries = fs.readdirSync(lockDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = /^(\d+)\.done$/.exec(entry.name);
    const ticket = match ? Number.parseInt(match[1], 10) : null;
    if (!entry.isFile() || !Number.isSafeInteger(ticket) || ticket <= 0 || ticket >= preservedTicket) {
      continue;
    }
    const slotPath = `${lockDirectory}/${ticket}.slot`;
    if (fs.existsSync(slotPath)) continue;
    try {
      fs.unlinkSync(`${lockDirectory}/${entry.name}`);
    } catch {
      // Best-effort cleanup is retried by the next allocation.
    }
  }
}

function compactCompletedTicketsSync(lockDirectory, preservedTicket, ownStagedSlotPath, deadline) {
  // A competing allocator may already have selected a lower path but not yet
  // linked it. Its private staging file fences that path against compaction.
  // An intent created after this check will observe preservedTicket instead.
  if (otherAllocationIntentExistsSync(lockDirectory, ownStagedSlotPath, deadline)) return;
  let slots;
  try {
    slots = listTicketSlotsSync(lockDirectory);
  } catch {
    return;
  }
  for (const slot of slots) {
    if (slot.ticket >= preservedTicket || !fs.existsSync(slot.donePath)) continue;
    try {
      // Remove the slot first. If this fails, retaining .done keeps the slot
      // completed. The preserved newer slot prevents ticket-number reuse.
      fs.unlinkSync(slot.slotPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') continue;
    }
    try {
      fs.unlinkSync(slot.donePath);
    } catch {
      // A leftover marker is ignored by allocation and is safe to retry later.
    }
  }
  cleanupOrphanedDoneMarkersSync(lockDirectory, preservedTicket);
}

function slotIsOutstandingSync(slot, deadline) {
  if (fs.existsSync(slot.donePath)) return false;
  try {
    if (!slotIsStale(slot.slotPath)) return true;
    const owner = parseSlotOwnerSync(slot.slotPath);
    if (ownerIsStillActive(owner, deadline)) return true;
    // Completion is an atomic create. The immutable slot remains as the
    // high-water mark, so its ticket can never be allocated again.
    publishDoneSync(slot.donePath);
    return false;
  } catch (error) {
    return errorCode(error) !== 'ENOENT';
  }
}

function allocateTicketSync(lockDirectory, deadline) {
  ensureLockDirectorySync(lockDirectory);
  if (Date.now() >= deadline) throw lockTimeoutError(lockDirectory);
  const ownerIdentity = currentProcessIdentity(deadline);
  if (Date.now() >= deadline) throw lockTimeoutError(lockDirectory);
  if (typeof ownerIdentity !== 'string') {
    throw new TypeError('Unable to determine process identity for OAuth state locking');
  }

  const id = randomUUID();
  const stagedSlotPath = `${lockDirectory}/.${process.pid}.${id}.slot.tmp`;
  fs.writeFileSync(
    stagedSlotPath,
    JSON.stringify({ id, ownerPid: process.pid, ownerIdentity }),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
  );

  try {
    while (true) {
      if (Date.now() >= deadline) throw lockTimeoutError(lockDirectory);
      const slots = listTicketSlotsSync(lockDirectory);
      if (Date.now() >= deadline) throw lockTimeoutError(lockDirectory);
      const highestTicket = slots.reduce((highest, slot) => Math.max(highest, slot.ticket), 0);
      const ticket = highestTicket + 1;
      if (!Number.isSafeInteger(ticket)) throw new Error('OAuth state lock ticket space exhausted');
      const slotPath = `${lockDirectory}/${ticket}.slot`;
      try {
        // Linking a complete private file publishes both the ticket and its
        // owner record atomically. A contender can never observe partial JSON.
        fs.linkSync(stagedSlotPath, slotPath);
        compactCompletedTicketsSync(lockDirectory, ticket, stagedSlotPath, deadline);
        return { ticket, slotPath, donePath: `${lockDirectory}/${ticket}.done`, lockDirectory };
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
    }
  } finally {
    try {
      fs.unlinkSync(stagedSlotPath);
    } catch {
      // The published hard link owns the record; staging cleanup is best-effort.
    }
  }
}

function earlierOutstandingSlotExistsSync(claim, deadline) {
  return listTicketSlotsSync(claim.lockDirectory)
    .some(slot => slot.ticket < claim.ticket && slotIsOutstandingSync(slot, deadline));
}

function lockTimeoutError(lockDirectory) {
  return new Error(`Timed out waiting for OAuth state lock: ${lockDirectory}`);
}

function acquireLockSync(lockDirectory) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const claim = allocateTicketSync(lockDirectory, deadline);
  try {
    while (true) {
      if (Date.now() >= deadline) throw lockTimeoutError(lockDirectory);
      const earlierSlotIsOutstanding = earlierOutstandingSlotExistsSync(claim, deadline);
      if (Date.now() >= deadline) throw lockTimeoutError(lockDirectory);
      if (!earlierSlotIsOutstanding) return claim;
      waitSync(Math.min(LOCK_RETRY_MS, deadline - Date.now()));
    }
  } catch (error) {
    publishDoneSync(claim.donePath);
    throw error;
  }
}

async function acquireLock(lockDirectory) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const claim = allocateTicketSync(lockDirectory, deadline);
  try {
    while (true) {
      if (Date.now() >= deadline) throw lockTimeoutError(lockDirectory);
      const earlierSlotIsOutstanding = earlierOutstandingSlotExistsSync(claim, deadline);
      if (Date.now() >= deadline) throw lockTimeoutError(lockDirectory);
      if (!earlierSlotIsOutstanding) return claim;
      await new Promise(resolve => setTimeout(
        resolve,
        Math.min(LOCK_RETRY_MS, deadline - Date.now())
      ));
    }
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
