/** Never serialize arbitrary request/config objects or invoke their getters. */
export function httpErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error !== 'object' || error === null) return String(error as string | number | boolean | bigint | symbol | undefined | null);
  try {
    const prototype: unknown = Object.getPrototypeOf(error);
    const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
    const type = typeof constructor === 'function' ? safeIdentifier(constructor.name) : 'Object';
    const fields = ['code', 'name', 'message'].flatMap(key => {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      if (!descriptor) return [];
      // Free-form messages can contain credentials. Keep only their presence;
      // code/name are bounded classifier identifiers, not nested values.
      const value = key === 'message' ? '[redacted]' : safeIdentifier(descriptor.value);
      return [`${key}=${value}`];
    });
    return [type, ...fields].join(' ');
  } catch {
    return 'Object [unavailable summary]';
  }
}

function safeIdentifier(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value).slice(0, 32);
  return typeof value === 'string' && /^[\w.-]{1,64}$/.test(value) ? value : '[redacted]';
}
