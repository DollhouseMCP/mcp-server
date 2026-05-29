import type { ConsoleHandlerResult, ConsoleRequest } from '../../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { IRuntimeSessionControlStore } from '../../services/runtime/IRuntimeSessionControlStore.js';
import type { SessionExecutionListDto } from './ExecutionDtos.js';
import type { SessionExecutionReader, SessionGatekeeperReader } from './ExecutionStore.js';

export class ExecutionService {
  constructor(private readonly options: {
    readonly runtimeStore: IRuntimeSessionControlStore;
    readonly executionReader: SessionExecutionReader;
    readonly gatekeeperReader: SessionGatekeeperReader;
    readonly now?: () => Date;
  }) {}

  async list(req: ConsoleRequest, sessionId: string): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    if (!await this.isOwnedActiveSession(actor.userId, sessionId)) return notFound();
    const executions = await this.options.executionReader.list(actor.userId, sessionId);
    const body: SessionExecutionListDto = { executions };
    return { status: 200, body };
  }

  async get(req: ConsoleRequest, sessionId: string, goalId: string): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    if (!await this.isOwnedActiveSession(actor.userId, sessionId)) return notFound();
    if (!isGoalId(goalId)) return validationProblem('goal_id path parameter is invalid.');
    const execution = await this.options.executionReader.find(actor.userId, sessionId, goalId);
    if (!execution) return notFound('Execution was not found.');
    return { status: 200, body: execution };
  }

  async gatekeeper(req: ConsoleRequest, sessionId: string): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    if (!await this.isOwnedActiveSession(actor.userId, sessionId)) return notFound();
    return { status: 200, body: await this.options.gatekeeperReader.get(actor.userId, sessionId) };
  }

  private async isOwnedActiveSession(userId: string, sessionId: string): Promise<boolean> {
    const session = await this.options.runtimeStore.findPresence(sessionId, this.now());
    return session?.userId === userId;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function isGoalId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function notFound(detail = 'Runtime session was not found.'): ConsoleHandlerResult {
  return {
    status: 404,
    body: {
      type: 'about:blank',
      title: 'Not found',
      status: 404,
      code: 'not_found',
      detail,
    },
  };
}

function validationProblem(detail: string): ConsoleHandlerResult {
  return {
    status: 422,
    body: {
      type: 'about:blank',
      title: 'Validation failed',
      status: 422,
      code: 'validation_failed',
      detail,
    },
  };
}
