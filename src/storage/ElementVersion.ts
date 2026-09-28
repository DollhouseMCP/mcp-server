import { createHash } from 'node:crypto';
import type { WriteContentOptions } from './IStorageLayer.js';

export class StaleElementWriteError extends Error {
  readonly code = 'ESTALE';
  constructor(message = 'Element is missing or changed since it was read; read it again before retrying.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'StaleElementWriteError';
  }
}

export function storedContentVersion(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function validateConditionalWrite(options?: WriteContentOptions): void {
  if (options?.expectedVersion !== undefined && !options.expectedIdentity) {
    throw new Error('An expected storage version requires an expected identity');
  }
  if (options?.exclusive && (options.expectedVersion !== undefined || options.expectedIdentity)) {
    throw new Error('Exclusive creation cannot be combined with an expected identity or version');
  }
}
