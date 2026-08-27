import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// The OAuth parent and detached helper are separate processes, so the
// repository's in-process FileLockManager cannot serialize their state-file
// transactions. This coordinator uses Lamport bakery-style ticket claims:
// every contender owns a UUID-named file that is never reused, which makes
// stale cleanup safe even when several processes recover concurrently.
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 10;
const CLAIM_STALE_MS = 30_000;
const CLAIM_HEARTBEAT_MS = 10_000;
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

function claimIsStale(claimPath) {
  return Date.now() - fs.statSync(claimPath).mtimeMs >= CLAIM_STALE_MS;
}

function removeStaleClaimSync(claimPath) {
  try {
    if (!claimIsStale(claimPath)) return false;
    // Claim paths contain a UUID and are never reused. Removing this exact
    // path therefore cannot unlink a replacement claim from another owner.
    fs.unlinkSync(claimPath);
    return true;
  } catch (error) {
    return errorCode(error) === 'ENOENT';
  }
}

function parseClaimSync(claimPath, fallbackId) {
  try {
    const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
    if (claim?.id !== fallbackId || typeof claim.choosing !== 'boolean') return null;
    if (!Number.isSafeInteger(claim.ticket) || claim.ticket < 0) return null;
    return { ...claim, path: claimPath };
  } catch {
    return null;
  }
}

function listActiveClaimsSync(lockDirectory, ownPath) {
  let entries;
  try {
    entries = fs.readdirSync(lockDirectory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }

  const claims = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.claim')) continue;
    const claimPath = `${lockDirectory}/${entry.name}`;
    if (claimPath !== ownPath && removeStaleClaimSync(claimPath)) continue;

    const id = entry.name.slice(0, -'.claim'.length);
    const claim = parseClaimSync(claimPath, id);
    // A fresh partial or malformed claim is conservatively treated as a
    // choosing contender until its owner completes it or it becomes stale.
    claims.push(claim ?? { id, choosing: true, ticket: 0, path: claimPath });
  }
  return claims;
}

function createClaimSync(lockDirectory) {
  ensureLockDirectorySync(lockDirectory);
  const id = randomUUID();
  const claimPath = `${lockDirectory}/${id}.claim`;
  fs.writeFileSync(
    claimPath,
    JSON.stringify({ id, choosing: true, ticket: 0 }),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 }
  );

  const observedClaims = listActiveClaimsSync(lockDirectory, claimPath);
  const highestTicket = observedClaims.reduce(
    (highest, claim) => claim.choosing ? highest : Math.max(highest, claim.ticket),
    0
  );
  const ticket = highestTicket + 1;
  fs.writeFileSync(
    claimPath,
    JSON.stringify({ id, choosing: false, ticket }),
    { encoding: 'utf8', mode: 0o600 }
  );
  return { id, ticket, path: claimPath, lockDirectory };
}

function claimPrecedes(claim, ownClaim) {
  if (claim.path === ownClaim.path) return false;
  if (claim.choosing) return true;
  return claim.ticket < ownClaim.ticket ||
    (claim.ticket === ownClaim.ticket && claim.id < ownClaim.id);
}

function lockTimeoutError(lockDirectory) {
  return new Error(`Timed out waiting for OAuth state lock: ${lockDirectory}`);
}

function releaseClaimSync(claim) {
  try {
    fs.unlinkSync(claim.path);
  } catch {
    // The claim may already have been cleaned after an abnormal delay.
  }
}

async function releaseClaim(claim) {
  try {
    await fsPromises.unlink(claim.path);
  } catch {
    // The claim may already have been cleaned after an abnormal delay.
  }
}

function acquireLockSync(lockDirectory) {
  const claim = createClaimSync(lockDirectory);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  try {
    while (listActiveClaimsSync(lockDirectory, claim.path).some(other => claimPrecedes(other, claim))) {
      if (Date.now() >= deadline) throw lockTimeoutError(lockDirectory);
      waitSync(LOCK_RETRY_MS);
    }
    return claim;
  } catch (error) {
    releaseClaimSync(claim);
    throw error;
  }
}

async function acquireLock(lockDirectory) {
  const claim = createClaimSync(lockDirectory);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  try {
    while (listActiveClaimsSync(lockDirectory, claim.path).some(other => claimPrecedes(other, claim))) {
      if (Date.now() >= deadline) throw lockTimeoutError(lockDirectory);
      await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
    }
    return claim;
  } catch (error) {
    await releaseClaim(claim);
    throw error;
  }
}

function startClaimHeartbeat(claim) {
  const heartbeat = setInterval(() => {
    const now = new Date();
    fsPromises.utimes(claim.path, now, now).catch(() => {});
  }, CLAIM_HEARTBEAT_MS);
  heartbeat.unref();
  return heartbeat;
}

export function withOAuthStateLockSync(stateFile, operation) {
  const claim = acquireLockSync(lockDirectoryFor(stateFile));
  try {
    return operation();
  } finally {
    releaseClaimSync(claim);
  }
}

export async function withOAuthStateLock(stateFile, operation) {
  const claim = await acquireLock(lockDirectoryFor(stateFile));
  const heartbeat = startClaimHeartbeat(claim);
  try {
    return await operation();
  } finally {
    clearInterval(heartbeat);
    await releaseClaim(claim);
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
