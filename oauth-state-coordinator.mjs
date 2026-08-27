import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { uptime as systemUptime } from 'node:os';
import { performance } from 'node:perf_hooks';

// The OAuth parent and detached helper are separate processes. Monotonic,
// never-reused ticket slots provide cross-process ordering without deleting
// or replacing another owner's lock artifact. A matching .done marker releases
// a slot; abandoned slots are completed only after process-start verification.
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const CLAIM_STALE_MS = 30_000;
const PROCESS_IDENTITY_COMMAND_TIMEOUT_MS = 5_000;
const WINDOWS_START_TIME_TOLERANCE_MS = 2_000;
const LOCK_WAIT_SIGNAL = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
let cachedCurrentProcessIdentity;
const pendingDonePaths = new Set();
const pendingDoneRetryTimers = new Map();
const currentProcessMarkerReferences = new Map();

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

function createLockDeadline() {
  return {
    monotonic: performance.now() + LOCK_TIMEOUT_MS,
    systemUptime: systemUptime() * 1_000 + LOCK_TIMEOUT_MS
  };
}

function remainingLockTime(deadline) {
  return deadline.monotonic - performance.now();
}

function lockDeadlineExpired(deadline) {
  return remainingLockTime(deadline) <= 0 ||
    systemUptime() * 1_000 >= deadline.systemUptime;
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

function commandProcessIdentity(executable, args, prefix, deadline, remainingProviders = 1) {
  const remainingTime = remainingLockTime(deadline);
  if (remainingTime <= 0) return undefined;
  const providerBudget = Math.max(1, Math.floor(remainingTime / remainingProviders));
  const output = execFileSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: Math.min(PROCESS_IDENTITY_COMMAND_TIMEOUT_MS, providerBudget)
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

function windowsWmicIdentity(pid, executable, deadline, remainingProviders) {
  const remainingTime = remainingLockTime(deadline);
  if (remainingTime <= 0) return undefined;
  const providerBudget = Math.max(1, Math.floor(remainingTime / remainingProviders));
  try {
    const output = execFileSync(
      executable,
      ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: Math.min(PROCESS_IDENTITY_COMMAND_TIMEOUT_MS, providerBudget)
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

function windowsManagementIdentity(pid, deadline) {
  const executables = windowsSystemExecutables();
  if (!executables) return undefined;
  // WMIC is substantially lighter than starting a PowerShell runtime. On
  // systems where it has been removed, ENOENT returns immediately and leaves
  // nearly the full common deadline for the two PowerShell fallbacks.
  const wmicIdentity = windowsWmicIdentity(pid, executables.wmic, deadline, 3);
  if (wmicIdentity) return wmicIdentity;
  const powershellArgs = [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$started = [DateTimeOffset]((Get-Process -Id ${pid}).StartTime); $started.ToUnixTimeMilliseconds()`
  ];
  const powershellProviders = [executables.pwsh, executables.powershell];
  for (const [index, executable] of powershellProviders.entries()) {
    try {
      // Reserve a share of the common deadline for every remaining provider,
      // including WMIC, so one slow executable cannot starve all fallbacks.
      const identity = commandProcessIdentity(
        executable,
        powershellArgs,
        'win32',
        deadline,
        powershellProviders.length - index
      );
      if (identity) return identity;
    } catch {
      // Try the next independent Windows process-management interface.
    }
  }

  return undefined;
}

function processIdentity(pid, deadline) {
  if (lockDeadlineExpired(deadline)) return undefined;
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
  if (lockDeadlineExpired(deadline)) return undefined;
  // Starting a management shell in every Windows contender causes the probe
  // processes themselves to exhaust the shared lock deadline. Node exposes
  // its own high-resolution process time origin without spawning. Foreign
  // stale owners still go through the independent OS-backed probes above.
  const identity = process.platform === 'win32' && Number.isFinite(performance.timeOrigin)
    ? `win32:${Math.trunc(performance.timeOrigin)}`
    : processIdentity(process.pid, deadline);
  if (typeof identity === 'string') cachedCurrentProcessIdentity = identity;
  return identity;
}

function processIdentityMarkerPath(lockDirectory, pid) {
  return `${lockDirectory}.process-${pid}.identity`;
}

function readProcessIdentityMarkerSync(lockDirectory, pid) {
  try {
    const markerPath = processIdentityMarkerPath(lockDirectory, pid);
    const mtimeMs = fs.statSync(markerPath).mtimeMs;
    const serializedMarker = fs.readFileSync(markerPath, 'utf8').trim();
    if (!serializedMarker) return null;
    try {
      const marker = JSON.parse(serializedMarker);
      return typeof marker?.identity === 'string' && marker.identity.length > 0 &&
        Number.isFinite(marker.writtenAt)
        ? { identity: marker.identity, writtenAt: marker.writtenAt, mtimeMs }
        : null;
    } catch {
      // Markers written by the immediately preceding implementation contain
      // only the identity. They are short-lived and retain mtime fallback
      // compatibility across an in-place beta update.
      return { identity: serializedMarker, writtenAt: mtimeMs, mtimeMs };
    }
  } catch {
    return null;
  }
}

function retainCurrentProcessIdentityMarkerSync(lockDirectory, identity) {
  const markerPath = processIdentityMarkerPath(lockDirectory, process.pid);
  writeFileAtomicallySync(markerPath, JSON.stringify({ identity, writtenAt: Date.now() }));
  currentProcessMarkerReferences.set(
    markerPath,
    (currentProcessMarkerReferences.get(markerPath) ?? 0) + 1
  );
  return markerPath;
}

function releaseCurrentProcessIdentityMarkerSync(markerPath) {
  const references = currentProcessMarkerReferences.get(markerPath) ?? 0;
  if (references > 1) {
    currentProcessMarkerReferences.set(markerPath, references - 1);
    return;
  }
  currentProcessMarkerReferences.delete(markerPath);
  try {
    fs.unlinkSync(markerPath);
  } catch {
    // A leftover marker is safe: a later process reusing the PID replaces it
    // atomically before publishing a ticket.
  }
}

function processIdentitiesMatch(recordedIdentity, currentIdentity) {
  if (recordedIdentity === currentIdentity) return true;
  const recordedWindowsStart = /^win32:(\d+)$/.exec(recordedIdentity)?.[1];
  const currentWindowsStart = /^win32:(\d+)$/.exec(currentIdentity)?.[1];
  if (!recordedWindowsStart || !currentWindowsStart) return false;
  // performance.timeOrigin is a few milliseconds after the kernel's process
  // creation timestamp. The tolerance can only retain a reused PID (fail
  // closed); it can never reclaim a live owner whose identity probe succeeded.
  return Math.abs(Number(recordedWindowsStart) - Number(currentWindowsStart)) <=
    WINDOWS_START_TIME_TOLERANCE_MS;
}

function staleMarkerStillBelongsToProcess(marker, ownerIdentity, currentIdentity) {
  if (currentIdentity === ownerIdentity) return true;
  const ownerWindowsStart = /^win32:(\d+)$/.exec(ownerIdentity)?.[1];
  const currentWindowsStart = /^win32:(\d+)$/.exec(currentIdentity)?.[1];
  if (!ownerWindowsStart || !currentWindowsStart) return false;
  const ownerStart = Number(ownerWindowsStart);
  const currentStart = Number(currentWindowsStart);
  const identitiesAgree = Math.abs(currentStart - ownerStart) <=
    WINDOWS_START_TIME_TOLERANCE_MS;
  if (marker.writtenAt < ownerStart) {
    // The wall clock moved backward between this process starting and writing
    // its marker, so marker ordering cannot distinguish the original process
    // from PID reuse. In that explicitly ambiguous case, retain only an OS
    // identity that agrees with the recorded performance time origin. This is
    // fail-closed for an extremely close reuse and cannot admit a contender
    // while the original process is still in its critical section.
    return identitiesAgree;
  }
  // The marker is written after its process starts. If the currently live
  // process started after this matching marker was written, the PID was
  // reused. Exact ordering rejects ordinary PID reuse regardless of tolerance;
  // identity agreement also prevents a rollback after marker publication from
  // making a materially different replacement start look older than the marker.
  return identitiesAgree && currentStart <= marker.writtenAt;
}

function parseSlotOwnerSync(slotPath) {
  try {
    const ownerPath = fs.statSync(slotPath).isDirectory()
      ? `${slotPath}/owner.json`
      : slotPath;
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    if (typeof owner?.id !== 'string' || owner.id.length === 0) return null;
    if (!Number.isSafeInteger(owner.ownerPid) || owner.ownerPid <= 0) return null;
    if (typeof owner.ownerIdentity !== 'string' || owner.ownerIdentity.length === 0) return null;
    return owner;
  } catch {
    return null;
  }
}

function ownerIsStillActive(owner, deadline, lockDirectory) {
  if (!owner) return false;
  if (owner.ownerPid === process.pid) {
    const currentIdentity = currentProcessIdentity(deadline);
    return currentIdentity === undefined ||
      (currentIdentity !== null && processIdentitiesMatch(owner.ownerIdentity, currentIdentity));
  }
  if (!processExists(owner.ownerPid)) return false;
  const marker = readProcessIdentityMarkerSync(lockDirectory, owner.ownerPid);
  const markerAgeMs = marker === null ? null : Date.now() - marker.writtenAt;
  if (marker?.identity === owner.ownerIdentity && markerAgeMs >= 0 &&
      markerAgeMs < LOCK_TIMEOUT_MS) return true;
  if (marker !== null && marker.identity !== owner.ownerIdentity) return false;
  const currentIdentity = processIdentity(owner.ownerPid, deadline);
  // An unavailable identity probe fails closed; a later scan can retry.
  return currentIdentity === undefined ||
    (currentIdentity !== null &&
      (currentIdentity === owner.ownerIdentity ||
        (marker !== null &&
          staleMarkerStillBelongsToProcess(marker, owner.ownerIdentity, currentIdentity))));
}

function slotIsStale(slotPath) {
  const ageMs = Date.now() - fs.statSync(slotPath).mtimeMs;
  // A future mtime proves the wall clock moved backward after publication.
  // Treat it as requiring an ownership check now: a live owner still fails
  // closed in ownerIsStillActive, while a dead owner can be recovered without
  // waiting for wall time to catch up.
  return ageMs < 0 || ageMs >= CLAIM_STALE_MS;
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
    .filter(entry => entry.isFile() || entry.isDirectory())
    .map(entry => ({ entry, ticket: ticketFromSlotName(entry.name) }))
    .filter(item => item.ticket !== null)
    .map(item => ({
      ticket: item.ticket,
      slotPath: `${lockDirectory}/${item.entry.name}`,
      donePath: `${lockDirectory}/${item.ticket}.done`,
      lockDirectory
    }));
}

function publishDoneSync(donePath) {
  try {
    fs.writeFileSync(donePath, '', { flag: 'wx', mode: 0o600 });
    pendingDonePaths.delete(donePath);
    const retryTimer = pendingDoneRetryTimers.get(donePath);
    if (retryTimer) clearTimeout(retryTimer);
    pendingDoneRetryTimers.delete(donePath);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      pendingDonePaths.delete(donePath);
      return;
    }
    // Retain failed releases in memory so the next transaction in this
    // process retries them before it can publish another ticket. An unref'd
    // timer also retries independently when no later local transaction occurs.
    pendingDonePaths.add(donePath);
    schedulePendingDoneRetry(donePath);
    throw error;
  }
}

function schedulePendingDoneRetry(donePath) {
  if (pendingDoneRetryTimers.has(donePath)) return;
  const timer = setTimeout(() => {
    pendingDoneRetryTimers.delete(donePath);
    if (!pendingDonePaths.has(donePath)) return;
    try {
      publishDoneSync(donePath);
    } catch {
      // publishDoneSync retained the path and scheduled the next retry.
    }
  }, LOCK_RETRY_MS);
  timer.unref?.();
  pendingDoneRetryTimers.set(donePath, timer);
}

function retryPendingDoneMarkersSync(lockDirectory) {
  const directoryPrefix = `${lockDirectory}/`;
  for (const donePath of pendingDonePaths) {
    if (donePath.startsWith(directoryPrefix)) publishDoneSync(donePath);
  }
}

function allocationIntentSnapshotSync(lockDirectory) {
  try {
    const entries = fs.readdirSync(lockDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith('.slot.tmp.publish')) continue;
      const fallbackDirectory = `${lockDirectory}/${entry.name}`;
      const stagedSlotPath = fallbackDirectory.slice(0, -'.publish'.length);
      if (fs.existsSync(stagedSlotPath)) continue;
      try {
        fs.rmSync(fallbackDirectory, { recursive: true });
      } catch {
        // Best-effort orphan cleanup is retried by the next allocation.
      }
    }
    return {
      entries,
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

function allocationIntentBlocksCompactionSync(
  intentPath,
  publishedOwnerIds,
  deadline,
  lockDirectory
) {
  try {
    const owner = parseSlotOwnerSync(intentPath);
    if (owner && publishedOwnerIds.has(owner.id)) {
      // The private inode was already linked to an immutable numbered slot.
      // Retry a failed finally-cleanup without treating it as an allocator.
      fs.unlinkSync(intentPath);
      return false;
    }
    if (Number.isFinite(owner?.allocationDeadlineUptime) &&
        systemUptime() * 1_000 >= owner.allocationDeadlineUptime) {
      // Allocation checks the same process-shared monotonic deadline
      // immediately before publishing.
      // If cleanup lost a transient race, linkSync either already published
      // the complete inode or will fail after this unlink; it cannot publish
      // an expired intent later.
      fs.unlinkSync(intentPath);
      return false;
    }
    if (!slotIsStale(intentPath)) return true;
    if (ownerIsStillActive(owner, deadline, lockDirectory)) return true;
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
      allocationIntentBlocksCompactionSync(
        intentPath,
        snapshot.publishedOwnerIds,
        deadline,
        lockDirectory
      );
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
      fs.rmSync(slot.slotPath, { recursive: true });
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
    if (ownerIsStillActive(owner, deadline, slot.lockDirectory)) return true;
    // Completion is an atomic create. The immutable slot remains as the
    // high-water mark, so its ticket can never be allocated again.
    publishDoneSync(slot.donePath);
    return false;
  } catch (error) {
    return errorCode(error) !== 'ENOENT';
  }
}

function tryPublishNextTicketSync(lockDirectory, stagedSlotPath, deadline) {
  const slots = listTicketSlotsSync(lockDirectory);
  if (lockDeadlineExpired(deadline)) throw lockTimeoutError(lockDirectory);
  const highestTicket = slots.reduce((highest, slot) => Math.max(highest, slot.ticket), 0);
  const ticket = highestTicket + 1;
  if (!Number.isSafeInteger(ticket)) throw new Error('OAuth state lock ticket space exhausted');
  const slotPath = `${lockDirectory}/${ticket}.slot`;
  try {
    // Linking a complete private file publishes both the ticket and its
    // owner record atomically. A contender can never observe partial JSON.
    fs.linkSync(stagedSlotPath, slotPath);
    return { ticket, slotPath, donePath: `${lockDirectory}/${ticket}.done`, lockDirectory };
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return null;
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(errorCode(error))) {
      throw error;
    }
  }
  const fallbackDirectory = `${stagedSlotPath}.publish`;
  try {
    // FAT/exFAT and some network shares do not support hard links. Publish a
    // private non-empty directory instead: its owner record is complete before
    // rename, and atomic rename cannot replace a competing non-empty directory.
    // Mixed file/directory slots share the same numeric ticket namespace.
    if (!fs.existsSync(fallbackDirectory)) {
      fs.mkdirSync(fallbackDirectory, { mode: 0o700 });
      fs.copyFileSync(
        stagedSlotPath,
        `${fallbackDirectory}/owner.json`,
        fs.constants.COPYFILE_EXCL
      );
    }
    fs.renameSync(fallbackDirectory, slotPath);
    return { ticket, slotPath, donePath: `${lockDirectory}/${ticket}.done`, lockDirectory };
  } catch (error) {
    if (fs.existsSync(slotPath)) return null;
    throw error;
  }
}

function allocateTicketSync(lockDirectory, deadline) {
  ensureLockDirectorySync(lockDirectory);
  retryPendingDoneMarkersSync(lockDirectory);
  if (lockDeadlineExpired(deadline)) throw lockTimeoutError(lockDirectory);
  const ownerIdentity = currentProcessIdentity(deadline);
  if (lockDeadlineExpired(deadline)) throw lockTimeoutError(lockDirectory);
  if (typeof ownerIdentity !== 'string') {
    throw new TypeError('Unable to determine process identity for OAuth state locking');
  }
  const markerPath = retainCurrentProcessIdentityMarkerSync(lockDirectory, ownerIdentity);

  try {
    const id = randomUUID();
    const stagedSlotPath = `${lockDirectory}/.${process.pid}.${id}.slot.tmp`;
    fs.writeFileSync(
      stagedSlotPath,
      JSON.stringify({
        id,
        ownerPid: process.pid,
        ownerIdentity,
        allocationDeadlineUptime: deadline.systemUptime
      }),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );

    try {
      while (true) {
        if (lockDeadlineExpired(deadline)) throw lockTimeoutError(lockDirectory);
        const claim = tryPublishNextTicketSync(lockDirectory, stagedSlotPath, deadline);
        if (!claim) continue;
        compactCompletedTicketsSync(lockDirectory, claim.ticket, stagedSlotPath, deadline);
        return { ...claim, markerPath };
      }
    } finally {
      try {
        fs.unlinkSync(stagedSlotPath);
      } catch {
        // The published hard link owns the record; staging cleanup is best-effort.
      }
      try {
        fs.rmSync(`${stagedSlotPath}.publish`, { recursive: true });
      } catch {
        // Atomic rename consumed the fallback directory, or cleanup is best-effort.
      }
    }
  } catch (error) {
    releaseCurrentProcessIdentityMarkerSync(markerPath);
    throw error;
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
  const deadline = createLockDeadline();
  const claim = allocateTicketSync(lockDirectory, deadline);
  try {
    while (true) {
      if (lockDeadlineExpired(deadline)) throw lockTimeoutError(lockDirectory);
      const earlierSlotIsOutstanding = earlierOutstandingSlotExistsSync(claim, deadline);
      if (lockDeadlineExpired(deadline)) throw lockTimeoutError(lockDirectory);
      if (!earlierSlotIsOutstanding) return claim;
      waitSync(Math.min(LOCK_RETRY_MS, remainingLockTime(deadline)));
    }
  } catch (error) {
    try {
      publishDoneSync(claim.donePath);
    } finally {
      releaseCurrentProcessIdentityMarkerSync(claim.markerPath);
    }
    throw error;
  }
}

async function acquireLock(lockDirectory) {
  const deadline = createLockDeadline();
  const claim = allocateTicketSync(lockDirectory, deadline);
  try {
    while (true) {
      if (lockDeadlineExpired(deadline)) throw lockTimeoutError(lockDirectory);
      const earlierSlotIsOutstanding = earlierOutstandingSlotExistsSync(claim, deadline);
      if (lockDeadlineExpired(deadline)) throw lockTimeoutError(lockDirectory);
      if (!earlierSlotIsOutstanding) return claim;
      await new Promise(resolve => setTimeout(
        resolve,
        Math.min(LOCK_RETRY_MS, remainingLockTime(deadline))
      ));
    }
  } catch (error) {
    try {
      publishDoneSync(claim.donePath);
    } finally {
      releaseCurrentProcessIdentityMarkerSync(claim.markerPath);
    }
    throw error;
  }
}

export function withOAuthStateLockSync(stateFile, operation) {
  const claim = acquireLockSync(lockDirectoryFor(stateFile));
  try {
    return operation();
  } finally {
    try {
      publishDoneSync(claim.donePath);
    } finally {
      releaseCurrentProcessIdentityMarkerSync(claim.markerPath);
    }
  }
}

export async function withOAuthStateLock(stateFile, operation) {
  const claim = await acquireLock(lockDirectoryFor(stateFile));
  try {
    return await operation();
  } finally {
    try {
      publishDoneSync(claim.donePath);
    } finally {
      releaseCurrentProcessIdentityMarkerSync(claim.markerPath);
    }
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
