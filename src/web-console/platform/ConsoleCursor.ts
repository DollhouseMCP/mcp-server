/**
 * Opaque pagination cursors for the console's cursor list family
 * (`{items, page:{limit, cursor, next_cursor}}`).
 *
 * The contract guarantees cursors are opaque strings: clients never parse or
 * construct them, and the payload shape is a server implementation detail a
 * module can change freely. There is no server-side state and therefore no
 * TTL — a cursor pointing at data that has since been retained away simply
 * yields an empty page with `next_cursor: null`, which clients treat as the
 * terminal condition.
 */

const CURSOR_ENCODING = 'base64url';

export function encodeConsoleCursor(payload: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString(CURSOR_ENCODING);
}

/** Returns null for anything that is not a cursor this server issued. */
export function decodeConsoleCursor(token: string): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 512) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, CURSOR_ENCODING).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Convenience for the offset-backed sources (in-memory ring buffers): decode
 * a cursor carrying `{o: <offset>}` to a non-negative integer offset, treating
 * absent/garbage cursors as offset 0 (first page).
 */
export function offsetFromConsoleCursor(token: string | null): number {
  if (!token) return 0;
  const payload = decodeConsoleCursor(token);
  const offset = payload?.o;
  return typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

export function offsetConsoleCursor(offset: number): string {
  return encodeConsoleCursor({ o: offset });
}
