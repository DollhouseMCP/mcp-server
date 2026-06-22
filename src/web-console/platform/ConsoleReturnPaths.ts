export function normalizeConsoleReturnPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || value === '') return fallback;
  if (!isSafeConsoleReturnPath(value)) return fallback;
  return value;
}

export function isSafeConsoleReturnPath(value: string): boolean {
  return value.startsWith('/') &&
    !value.startsWith('//') &&
    !value.includes('\\') &&
    !/[\r\n]/.test(value);
}
