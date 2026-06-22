import { createHash } from 'node:crypto';

import { requireConsoleAuthentication } from './ConsoleAuthentication.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import type { ConsoleAdminAuditResult } from '../audit/IAdminAuditWriter.js';
import type {
  ConsoleHandlerResult,
  ConsolePathParamValueNormalization,
  ConsoleRequest,
  ConsoleRouteDefinition,
} from '../platform/ConsolePlatformTypes.js';
import type { ConsoleProblemInput } from '../platform/ProblemResponses.js';
import type { IIdempotencyStore } from '../stores/IIdempotencyStore.js';
import { ConsoleStoreValidationError, assertUuid } from '../stores/ConsoleStoreValidation.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;
export const MAX_IDEMPOTENCY_BODY_DEPTH = 64;
export const MAX_IDEMPOTENCY_BODY_BYTES = 1024 * 1024;

export type ConsoleIdempotentExecution =
  | {
    readonly kind: 'result';
    readonly result: ConsoleHandlerResult;
    readonly interceptedAuditResult?: ConsoleAdminAuditResult;
  }
  | {
    readonly kind: 'problem';
    readonly problem: ConsoleProblemInput;
    readonly interceptedAuditResult?: ConsoleAdminAuditResult;
  };

export async function executeWithConsoleIdempotency(
  route: ConsoleRouteDefinition,
  req: ConsoleRequest,
  store: IIdempotencyStore,
  execute: () => Promise<ConsoleHandlerResult>,
  now: Date,
): Promise<ConsoleIdempotentExecution> {
  if (route.idempotency !== 'required') {
    return { kind: 'result', result: await execute() };
  }
  const idempotencyKey = singleHeader(req.headers['idempotency-key']);
  if (!idempotencyKey) return validationProblem('This operation requires a single Idempotency-Key header.');
  try {
    assertUuid(idempotencyKey, 'idempotencyKey');
  } catch (error) {
    if (error instanceof ConsoleStoreValidationError) {
      return validationProblem('Idempotency-Key must be a valid UUID.');
    }
    throw error;
  }

  let requestFingerprint;
  try {
    requestFingerprint = fingerprintBody(req.body);
  } catch (error) {
    if (error instanceof ConsoleStoreValidationError) {
      return validationProblem('Request body must be valid JSON for idempotency.');
    }
    throw error;
  }
  const claimed = await store.claim({
    consoleSessionIdHash: requireConsoleAuthentication(req).sessionIdHash,
    idempotencyKey,
    httpMethod: route.method,
    canonicalTarget: canonicalRequestTarget(req, route),
    requestFingerprint,
    createdAt: now,
    expiresAt: new Date(now.getTime() + RETENTION_MS),
  });

  switch (claimed.kind) {
    case 'replay':
      return {
        kind: 'result',
        interceptedAuditResult: 'replayed',
        result: {
          status: claimed.record.responseStatus,
          ...(claimed.record.responseBodyPresent ? { body: claimed.record.responseBody } : {}),
        },
      };
    case 'mismatch':
      return {
        kind: 'problem',
        problem: {
          status: 422,
          code: 'idempotency_key_mismatch',
          title: 'Idempotency key mismatch',
          detail: 'The idempotency key was previously used for a different request.',
          extensions: { mismatch_field: claimed.mismatchField },
        },
        interceptedAuditResult: 'rejected',
      };
    case 'in_progress':
      return {
        kind: 'problem',
        problem: {
          status: 409,
          code: 'conflict',
          title: 'Operation already in progress',
          detail: 'An operation using this idempotency key is already in progress.',
        },
        interceptedAuditResult: 'conflict',
      };
    case 'claimed': {
      const result = await execute();
      await store.complete(claimed.claim, {
        responseStatus: result.status,
        responseBodyPresent: result.body !== undefined,
        responseBody: result.body ?? null,
      });
      return { kind: 'result', result };
    }
  }
}

export function canonicalRequestTarget(req: ConsoleRequest, route?: ConsoleRouteDefinition): string {
  const parsed = new URL(req.originalUrl, 'https://console.invalid');
  const sortedQuery = canonicalQueryEntries(parsed)
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      compareCodeUnits(leftName, rightName) || compareCodeUnits(leftValue, rightValue));
  const search = new URLSearchParams(sortedQuery).toString();
  const pathname = route ? canonicalPathname(req, route, parsed.pathname) : parsed.pathname;
  return search ? `${pathname}?${search}` : pathname;
}

export function fingerprintBody(body: unknown): Buffer {
  const canonical = canonicalJson(body ?? null, 0);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_IDEMPOTENCY_BODY_BYTES) {
    throw new ConsoleStoreValidationError('Request body exceeds the idempotency fingerprint limit');
  }
  return createHash('sha256').update(canonical).digest();
}

function canonicalJson(value: unknown, depth: number): string {
  if (depth > MAX_IDEMPOTENCY_BODY_DEPTH) {
    throw new ConsoleStoreValidationError('Request body exceeds the idempotency nesting limit');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item, depth + 1)).join(',')}]`;
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const members = Object.keys(object).sort(compareCodeUnits)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key], depth + 1)}`);
    return `{${members.join(',')}}`;
  }
  throw new ConsoleStoreValidationError('Request body must be valid JSON for idempotency');
}

function validationProblem(detail: string): ConsoleIdempotentExecution {
  return {
    kind: 'problem',
    problem: {
      status: 422,
      code: 'validation_failed',
      title: 'Validation failed',
      detail,
    },
    interceptedAuditResult: 'rejected',
  };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function canonicalPathname(req: ConsoleRequest, route: ConsoleRouteDefinition, fallbackPathname: string): string {
  const routeSegments = route.path.split('/');
  const fallbackSegments = fallbackPathname.split('/');
  if (routeSegments.length !== fallbackSegments.length) return fallbackPathname;
  return routeSegments.map((routeSegment, index) => {
    if (!routeSegment.startsWith(':')) return fallbackSegments[index];
    const paramName = routeParamName(routeSegment);
    const value = typeof req.params[paramName] === 'string'
      ? req.params[paramName]
      : decodePathSegment(fallbackSegments[index]);
    const mode = route.pathParamValueNormalization?.[paramName] ?? 'security';
    return encodeURIComponent(normalizePathParamValue(value, mode));
  }).join('/');
}

function routeParamName(routeSegment: string): string {
  return routeSegment.slice(1).replace(/\?$/, '');
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function normalizePathParamValue(value: string, mode: ConsolePathParamValueNormalization): string {
  return mode === 'nfc'
    ? value.normalize('NFC')
    : UnicodeValidator.normalize(value).normalizedContent;
}

function canonicalQueryEntries(parsed: URL): [string, string][] {
  return [...parsed.searchParams.entries()]
    .map(([key, value]) => [
      UnicodeValidator.normalize(key).normalizedContent,
      UnicodeValidator.normalize(value).normalizedContent,
    ]);
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
