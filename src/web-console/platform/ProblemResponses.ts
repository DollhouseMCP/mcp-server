import type { Response } from 'express';

const PROBLEM_TYPE_BASE_URI = 'https://dollhousemcp.com/errors/';
const RESERVED_PROBLEM_MEMBERS = new Set([
  'type',
  'title',
  'status',
  'detail',
  'instance',
  'code',
]);

export type ConsoleProblemExtension = string | number | boolean | null | readonly string[];

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
