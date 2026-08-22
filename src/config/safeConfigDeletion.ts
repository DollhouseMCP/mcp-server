const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
// Bound decoding so nested encodings are caught without allowing unbounded work.
const MAX_DECODE_PASSES = 3;

type MutableConfigRecord = Record<string, unknown>;

export type ConfigDeletionResult =
  | { kind: 'deleted'; previousValue: unknown }
  | { kind: 'missing' }
  | { kind: 'section' }
  | { kind: 'unsafe'; reason: string };

/**
 * Parse a dot-notation config path while rejecting prototype-related
 * segments before any object traversal occurs.
 */
export function parseSafeConfigPath(path: string): readonly string[] {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('Configuration path must be a non-empty string.');
  }

  const segments = path.split('.');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new Error('Configuration path must not contain empty segments.');
    }
    assertSafeSegment(segment);
  }
  return segments;
}

/**
 * Delete a leaf without following inherited properties or invoking accessors.
 * Unknown object-valued leaves can be rejected to preserve section semantics.
 */
export function deleteOwnConfigLeaf(
  root: unknown,
  segments: readonly string[],
  options: { readonly rejectObjectLeaf?: boolean } = {},
): ConfigDeletionResult {
  if (segments.length === 0) {
    return { kind: 'unsafe', reason: 'Configuration path has no leaf segment.' };
  }
  for (const segment of segments) {
    assertSafeSegment(segment);
  }

  const parentResult = resolveConfigParent(root, segments.slice(0, -1));
  if ('result' in parentResult) return parentResult.result;
  return deleteOwnLeaf(parentResult.parent, segments.at(-1)!, options.rejectObjectLeaf === true);
}

function resolveConfigParent(
  root: unknown,
  parentSegments: readonly string[],
): { parent: MutableConfigRecord } | { result: ConfigDeletionResult } {
  let current = asAllowedConfigRecord(root);
  if (!current) {
    return { result: { kind: 'unsafe', reason: 'Configuration root is not a plain object.' } };
  }

  for (const segment of parentSegments) {
    const descriptor = Object.getOwnPropertyDescriptor(current, segment);
    if (!descriptor) return { result: { kind: 'missing' } };
    if (!isDataDescriptor(descriptor)) {
      return {
        result: { kind: 'unsafe', reason: 'Configuration path crosses an accessor property.' },
      };
    }

    current = asAllowedConfigRecord(descriptor.value);
    if (!current) {
      return {
        result: { kind: 'unsafe', reason: 'Configuration path crosses a non-plain object.' },
      };
    }
  }

  return { parent: current };
}

function deleteOwnLeaf(
  parent: MutableConfigRecord,
  leaf: string,
  rejectObjectLeaf: boolean,
): ConfigDeletionResult {
  const descriptor = Object.getOwnPropertyDescriptor(parent, leaf);
  if (!descriptor) return { kind: 'missing' };
  if (!isDataDescriptor(descriptor)) {
    return { kind: 'unsafe', reason: 'Configuration leaf is an accessor property.' };
  }
  if (!descriptor.configurable) {
    return { kind: 'unsafe', reason: 'Configuration leaf is not configurable.' };
  }
  if (rejectObjectLeaf && asAllowedConfigRecord(descriptor.value)) {
    return { kind: 'section' };
  }

  if (!Reflect.deleteProperty(parent, leaf)) {
    return { kind: 'unsafe', reason: 'Configuration leaf could not be deleted.' };
  }
  return { kind: 'deleted', previousValue: descriptor.value };
}

function assertSafeSegment(segment: string): void {
  let candidate = segment;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    const canonical = candidate.normalize('NFKC').trim().toLowerCase();
    if (FORBIDDEN_SEGMENTS.has(canonical)) {
      throw new Error(`Forbidden property in configuration path: ${segment}`);
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      // A literal percent sign is valid in a custom config key. Since the
      // segment cannot be decoded, it cannot resolve to a hidden forbidden key.
      return;
    }
    if (decoded === candidate) return;
    candidate = decoded;
  }

  const canonical = candidate.normalize('NFKC').trim().toLowerCase();
  if (FORBIDDEN_SEGMENTS.has(canonical)) {
    throw new Error(`Forbidden property in configuration path: ${segment}`);
  }
}

function asAllowedConfigRecord(value: unknown): MutableConfigRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (isPrototypeObject(value)) return null;
  return value as MutableConfigRecord;
}

function isPrototypeObject(value: object): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, 'constructor');
  return descriptor !== undefined
    && isDataDescriptor(descriptor)
    && typeof descriptor.value === 'function'
    && descriptor.value.prototype === value;
}

function isDataDescriptor(
  descriptor: PropertyDescriptor,
): descriptor is PropertyDescriptor & { value: unknown } {
  return Object.hasOwn(descriptor, 'value')
    && !Object.hasOwn(descriptor, 'get')
    && !Object.hasOwn(descriptor, 'set');
}
