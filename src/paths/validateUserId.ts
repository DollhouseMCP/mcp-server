/**
 * validateUserId — reject userId values that would break path safety.
 *
 * The path module builds filesystem paths from user IDs (e.g.
 * `users/<userId>/portfolio/...`). A userId containing path traversal
 * characters, null bytes, reserved device names, or other hostile
 * content would let a caller escape the per-user sandbox, collide
 * with other users, or create unmanageable directories.
 *
 * **Acceptance rule:** userId must match `^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$`
 * (1–64 chars, ASCII alphanumerics + underscore + hyphen, first char
 * must not be a hyphen). This covers UUIDs (hex + hyphen),
 * `local-user`, `DOLLHOUSE_USER` literal values, and other reasonable
 * identifiers. It excludes dots, slashes, null bytes, control chars,
 * whitespace, Unicode, leading-dash argv-confusion, and trailing
 * dot/space (silently stripped by Windows).
 *
 * **Separately rejected:** Windows reserved device names (`CON`,
 * `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9` — case-insensitive). These
 * match the charset rule but cannot be created as directories on
 * Windows and would cause silent failures.
 *
 * **Case-insensitive filesystems (macOS, Windows default):** two
 * userIds that differ only in case (`Alice` vs `alice`) will collide
 * on case-insensitive filesystems. This is an auth-layer concern —
 * identity providers should normalize to a canonical form before
 * handing userIds to the path module. We document rather than
 * enforce here because forcing lowercase would break case-preserving
 * display names.
 *
 * This is a defense-in-depth check. The DB layer validates UUIDs
 * independently; MCP handlers validate session identity upstream;
 * this layer guarantees that any userId reaching `path.join` is safe.
 *
 * @since Step 4.5
 */

/** Strict allow-list regex. */
const VALID_USERID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/**
 * Windows reserved device names (case-insensitive). Creating a
 * directory with any of these names fails silently on Windows — the
 * name is valid per our charset but the OS refuses to make the dir.
 */
const WIN_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Directory-sentinel names that collide with structural segments of
 * the per-user layout or the shared pool. A userId equal to one of
 * these would produce paths like `users/users/portfolio/...` which
 * are not traversal bugs but are confusing to reason about and
 * collide with future scanners that enumerate the `users/` directory.
 * Case-insensitive because filesystems on macOS and Windows are too.
 *
 * Keep this deny-list tight — it rejects names that *structurally*
 * collide with our layout, not names that are merely aesthetically
 * odd. Identity-layer concerns (stable vs rotating names, reserved
 * admin/root/default handles) belong in the auth layer, not here.
 */
const DIRECTORY_SENTINELS = new Set([
  'USERS',    // same segment as the per-user subtree container
  'SHARED',   // same segment as the shared-pool directory (Step 4.6)
  'SYSTEM',   // DB-side SYSTEM user identity for shared-pool provenance
]);

const MAX_LENGTH = 64;

export class InvalidUserIdError extends Error {
  readonly code = 'INVALID_USER_ID';
  constructor(reason: string) {
    super(`Invalid userId: ${reason}`);
    this.name = 'InvalidUserIdError';
  }
}

/**
 * Throws `InvalidUserIdError` if `userId` is unsafe for use as a path
 * segment. Returns `userId` unchanged on success (allows call-site
 * use as `getUserDir(validateUserId(id))`).
 */
export function validateUserId(userId: string): string {
  if (typeof userId !== 'string') {
    throw new InvalidUserIdError('not a string');
  }
  if (userId.length === 0) {
    throw new InvalidUserIdError('empty');
  }
  if (userId.length > MAX_LENGTH) {
    throw new InvalidUserIdError(`exceeds ${MAX_LENGTH} characters`);
  }
  if (!VALID_USERID.test(userId)) {
    throw new InvalidUserIdError(
      'must match /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/ (ASCII alphanumerics, underscore, hyphen; no leading hyphen)'
    );
  }
  const upper = userId.toUpperCase();
  if (WIN_RESERVED.has(upper)) {
    throw new InvalidUserIdError('Windows reserved device name');
  }
  if (DIRECTORY_SENTINELS.has(upper)) {
    throw new InvalidUserIdError('collides with a reserved directory sentinel');
  }
  return userId;
}
