export const CONSOLE_SESSION_COOKIE = 'dh_session';
export const CONSOLE_CSRF_COOKIE = 'dh_csrf';

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  let found = false;
  let decodedValue: string | undefined;
  for (const segment of cookieHeader?.split(';') ?? []) {
    const separator = segment.indexOf('=');
    if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
    if (found) return undefined;
    found = true;
    const value = segment.slice(separator + 1).trim();
    if (value.startsWith('"') || value.endsWith('"')) return undefined;
    try {
      decodedValue = decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return decodedValue;
}
