import type { Response } from 'express';
import { ConsoleStoreValidationError } from '../stores/ConsoleStoreValidation.js';

const PROBLEM_TYPE_BASE_URI = 'https://dollhousemcp.com/errors/';
const RESERVED_PROBLEM_MEMBERS = new Set([
  'type',
  'title',
  'status',
  'detail',
  'instance',
  'code',
]);

export type ConsoleProblemExtension =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  // Structured extension members (e.g. a validation `issues` array) — RFC 9457
  // permits arbitrary JSON extension members alongside the required ones.
  | readonly Readonly<Record<string, unknown>>[]
  | Readonly<Record<string, unknown>>;

export interface ConsoleProblemInput {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  readonly extensions?: Readonly<Record<string, ConsoleProblemExtension>>;
}

export interface ConsoleProblemDetails extends Record<string, unknown> {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: string;
}

function assertExtensionsDoNotReplaceRequiredMembers(
  extensions: ConsoleProblemInput['extensions'],
): void {
  for (const member of Object.keys(extensions ?? {})) {
    if (RESERVED_PROBLEM_MEMBERS.has(member)) {
      throw new Error(`Problem extension member "${member}" is reserved`);
    }
  }
}

export function createProblemDetails(
  problem: ConsoleProblemInput,
  correlationId: string,
): ConsoleProblemDetails {
  assertExtensionsDoNotReplaceRequiredMembers(problem.extensions);

  return {
    type: `${PROBLEM_TYPE_BASE_URI}${problem.code}`,
    title: problem.title,
    status: problem.status,
    detail: problem.detail,
    instance: correlationId,
    code: problem.code,
    ...problem.extensions,
  };
}

export function sendProblemResponse(
  res: Response,
  problem: ConsoleProblemInput,
  correlationId: string,
): void {
  res
    .status(problem.status)
    .type('application/problem+json')
    .json(createProblemDetails(problem, correlationId));
}

/**
 * Recognize a handler-returned problem body and lift it into a
 * ConsoleProblemInput so the kernel can emit it as a real RFC 9457 problem
 * document (typed `type` URI, `instance` correlation id,
 * `application/problem+json`) instead of the handlers' plain-JSON
 * `type: "about:blank"` shape. Non-problem bodies return null and are sent
 * unchanged. Extension members (e.g. validation `issues`) are carried over;
 * the reserved members are re-derived, never copied.
 */
export function problemInputFromHandlerBody(body: unknown, status: number): ConsoleProblemInput | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (
    typeof record.code !== 'string' ||
    typeof record.title !== 'string' ||
    typeof record.detail !== 'string' ||
    record.status !== status
  ) {
    return null;
  }
  const extensions: Record<string, ConsoleProblemExtension> = {};
  for (const [member, value] of Object.entries(record)) {
    if (!RESERVED_PROBLEM_MEMBERS.has(member)) {
      // Extension values arrive from handler-authored JSON response bodies, so
      // they are JSON-serializable by construction — a non-serializable value
      // (Buffer, class instance) would have misbehaved identically in the
      // pre-lift res.json() path. The cast records that provenance; it is not
      // a validation point.
      extensions[member] = value as ConsoleProblemExtension;
    }
  }
  return {
    status,
    code: record.code,
    title: record.title,
    detail: record.detail,
    extensions: Object.keys(extensions).length > 0 ? extensions : undefined,
  };
}

export function problemForConsoleError(error: unknown): ConsoleProblemInput | null {
  if (error instanceof ConsoleStoreValidationError) {
    return {
      status: 400,
      code: 'invalid_request',
      title: 'Invalid request',
      detail: error.message,
    };
  }
  return null;
}
