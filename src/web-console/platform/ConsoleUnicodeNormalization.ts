import type { RequestHandler } from 'express';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';

type MutableRecord = Record<string, unknown>;

export function createConsoleUnicodeNormalizationMiddleware(): RequestHandler {
  return (request, _response, next): void => {
    normalizeRecordInPlace(request.params as MutableRecord);
    Object.defineProperty(request, 'query', {
      value: normalizeValue(request.query),
      configurable: true,
      enumerable: true,
      writable: true,
    });
    request.body = normalizeValue(request.body);
    next();
  };
}

function normalizeRecordInPlace(value: MutableRecord): void {
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = UnicodeValidator.normalize(key).normalizedContent;
    const normalizedValue = normalizeValue(item);
    if (normalizedKey !== key) {
      delete value[key];
    }
    value[normalizedKey] = normalizedValue;
  }
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return UnicodeValidator.normalize(value).normalizedContent;
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeValue(item));
  }
  if (isPlainObject(value)) {
    return normalizePlainObject(value);
  }
  return value;
}

function normalizePlainObject(value: MutableRecord): MutableRecord {
  const normalized: MutableRecord = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = UnicodeValidator.normalize(key).normalizedContent;
    normalized[normalizedKey] = normalizeValue(item);
  }
  return normalized;
}

function isPlainObject(value: unknown): value is MutableRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
