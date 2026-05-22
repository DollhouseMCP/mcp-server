import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Create `dir` (and any missing ancestors) with the given mode applied to
 * every newly-created level. `fs.mkdir({recursive, mode})` only applies
 * `mode` to the leaf — intermediate ancestors created during the same
 * call inherit the process umask, which on most distros leaves them
 * world-listable. This helper walks back from the leaf to the first
 * newly-created ancestor and chmods each, while leaving pre-existing
 * ancestors untouched.
 *
 * If everything along the chain already exists, only the leaf is chmod'd
 * (idempotent).
 *
 * Used for `audit_hmac_keys` file storage and the audit-event JSONL sink.
 * Both directories hold sensitive material and need 0o700 perms throughout.
 */
export async function ensureDirectory(dir: string, mode: number): Promise<void> {
  const firstCreated = await fs.mkdir(dir, { recursive: true, mode });
  if (firstCreated === undefined) {
    // Nothing was created — caller-managed ancestor already exists with
    // whatever perms the operator set. Tighten only the leaf (idempotent).
    await fs.chmod(dir, mode);
    return;
  }
  // Walk from the leaf back up to (and including) firstCreated, tightening
  // each newly-created directory. Stops at firstCreated so we don't disturb
  // directories that pre-existed.
  let cursor = dir;
  // Guard against an infinite loop if firstCreated isn't a prefix of dir.
  for (let i = 0; i < 32; i += 1) {
    await fs.chmod(cursor, mode);
    if (cursor === firstCreated) return;
    const parent = path.dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
