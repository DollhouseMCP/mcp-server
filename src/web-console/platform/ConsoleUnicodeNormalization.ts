import type { RequestHandler } from 'express';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { ConsoleStoreValidationError } from '../stores/ConsoleStoreValidation.js';
import type {
  ConsolePathParamValueNormalization,
  ConsoleQueryParamValueNormalization,
} from './ConsolePlatformTypes.js';

type MutableRecord = Record<string, unknown>;
type StringNormalizationMode = ConsolePathParamValueNormalization | 'preserve';

const MAX_BODY_NORMALIZATION_DEPTH = 64;
const MAX_BODY_NORMALIZATION_NODES = 10_000;
const JSON_OBJECT_RESERVED_KEYS = new Set([
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);
const ROUTE_PARAM_RESERVED_KEYS = new Set([
  ...JSON_OBJECT_RESERVED_KEYS,
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'prototype',
  'toLocaleString',
  'toString',
  'valueOf',
]);

interface ConsoleUnicodeNormalizationOptions {
  readonly params?: boolean;
  readonly pathParamValueNormalization?: Readonly<Record<string, ConsolePathParamValueNormalization>>;
  readonly query?: boolean;
  readonly queryParamValueNormalization?: Readonly<Record<string, ConsoleQueryParamValueNormalization>>;
  readonly body?: 'keys' | 'off';
}

interface NormalizeValueOptions {
  readonly strings: StringNormalizationMode;
  readonly stringModesByKey?: Readonly<Record<string, StringNormalizationMode>>;
  readonly bodyState?: {
    nodes: number;
  };
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

export function createConsoleUnicodeNormalizationMiddleware(
  options: ConsoleUnicodeNormalizationOptions = {},
): RequestHandler {
  const normalizeParams = options.params ?? true;
  const normalizeQuery = options.query ?? true;
  const bodyMode = options.body ?? 'keys';
  const pathParamValueNormalization = options.pathParamValueNormalization;
  const queryParamValueNormalization = options.queryParamValueNormalization;

  return (request, _response, next): void => {
    try {
      if (normalizeParams) {
        Object.defineProperty(request, 'params', {
          value: normalizeRecord(request.params as MutableRecord, {
            strings: 'security',
            stringModesByKey: pathParamValueNormalization,
          }),
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
      if (normalizeQuery) {
        Object.defineProperty(request, 'query', {
          value: normalizeValue(request.query, {
            strings: 'security',
            stringModesByKey: queryParamValueNormalization,
          }),
          configurable: true,
          enumerable: true,
          writable: true,
        });
      }
      if (bodyMode === 'keys') {
        request.body = normalizeValue(request.body, {
          strings: 'preserve',
          bodyState: { nodes: 0 },
          maxDepth: MAX_BODY_NORMALIZATION_DEPTH,
          maxNodes: MAX_BODY_NORMALIZATION_NODES,
        });
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

function normalizeRecord(value: MutableRecord, options: NormalizeValueOptions): MutableRecord {
  const normalized = Object.create(null) as MutableRecord;
  const entries = Object.entries(value);
  const seen = new Set<string>();
  for (const [key, item] of entries) {
    const normalizedKey = UnicodeValidator.normalize(key).normalizedContent;
    assertNoNormalizedKeyCollision(seen, normalizedKey, ROUTE_PARAM_RESERVED_KEYS);
    const normalizedValue = normalizeValue(item, optionsForKey(options, key, normalizedKey), 1);
    defineDataProperty(normalized, normalizedKey, normalizedValue);
  }
  return normalized;
}

function normalizeValue(value: unknown, options: NormalizeValueOptions, depth = 0): unknown {
  checkBodyTraversal(options, depth);
  if (typeof value === 'string') {
    return normalizeString(value, options.strings);
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeValue(item, options, depth + 1));
  }
  if (isPlainObject(value)) {
    return normalizePlainObject(value, options, depth);
  }
  return value;
}

function optionsForKey(
  options: NormalizeValueOptions,
  key: string,
  normalizedKey: string,
): NormalizeValueOptions {
  const mode = options.stringModesByKey?.[key] ?? options.stringModesByKey?.[normalizedKey];
  return mode === undefined ? options : { ...options, strings: mode };
}

function normalizeString(value: string, mode: StringNormalizationMode): string {
  switch (mode) {
    case 'security':
      return UnicodeValidator.normalize(value).normalizedContent;
    case 'nfc':
      return value.normalize('NFC');
    case 'preserve':
      return value;
  }
}

function normalizePlainObject(value: MutableRecord, options: NormalizeValueOptions, depth: number): MutableRecord {
  const normalized = Object.create(null) as MutableRecord;
  const seen = new Set<string>();
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = UnicodeValidator.normalize(key).normalizedContent;
    assertNoNormalizedKeyCollision(seen, normalizedKey, JSON_OBJECT_RESERVED_KEYS);
    defineDataProperty(
      normalized,
      normalizedKey,
      normalizeValue(item, optionsForKey(options, key, normalizedKey), depth + 1),
    );
  }
  return normalized;
}

function checkBodyTraversal(options: NormalizeValueOptions, depth: number): void {
  if (!options.bodyState) return;
  if (depth > (options.maxDepth ?? MAX_BODY_NORMALIZATION_DEPTH)) {
    throw new ConsoleStoreValidationError('Request body exceeds the Unicode normalization nesting limit');
  }
  options.bodyState.nodes += 1;
  if (options.bodyState.nodes > (options.maxNodes ?? MAX_BODY_NORMALIZATION_NODES)) {
    throw new ConsoleStoreValidationError('Request body exceeds the Unicode normalization size limit');
  }
}

function assertNoNormalizedKeyCollision(seen: Set<string>, key: string, reservedKeys: ReadonlySet<string>): void {
  if (reservedKeys.has(key)) {
    throw new ConsoleStoreValidationError('Request contains a reserved Unicode-normalized field');
  }
  if (seen.has(key)) {
    throw new ConsoleStoreValidationError('Request contains duplicate Unicode-equivalent fields');
  }
  seen.add(key);
}

function defineDataProperty(target: MutableRecord, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    configurable: true,
    enumerable: true,
    writable: true,
  });
}

function isPlainObject(value: unknown): value is MutableRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
