import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import { parseConsoleLastEventId } from '../../platform/ConsoleSseStream.js';
import { ConsoleStoreValidationError } from '../../stores/ConsoleStoreValidation.js';
import type { IRuntimeSessionControlStore } from '../../services/runtime/IRuntimeSessionControlStore.js';
import { ExecutionService } from './ExecutionService.js';
import type { SessionExecutionReader, SessionGatekeeperReader } from './ExecutionStore.js';
import {
  projectSessionExecution,
  projectSessionExecutionList,
  projectSessionGatekeeper,
} from './ExecutionPrivacyProjectors.js';

const SELF_CAPABILITY = 'console:self';
const EXECUTION_STREAM_POLICY = {
  lastEventId: 'unsupported',
  heartbeatMs: 15_000,
  revalidateMs: 15_000,
  maxEventBytes: 64 * 1024,
  maxLastEventIdBytes: 512,
} as const;

export interface ExecutionModuleOptions {
  readonly runtimeStore: IRuntimeSessionControlStore;
  readonly executionReader: SessionExecutionReader;
  readonly gatekeeperReader: SessionGatekeeperReader;
  readonly now?: () => Date;
}

export function createExecutionModule(options: ExecutionModuleOptions): ConsoleModuleDescriptor {
  const service = new ExecutionService(options);
  return {
    id: 'executions',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    routes: [
      {
        method: 'GET',
        path: '/api/v1/me/sessions/:session_id/executions',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectSessionExecutionList,
        handler: req => withSessionId(req, sessionId => service.list(req, sessionId)),
      },
      {
        method: 'GET',
        path: '/api/v1/me/sessions/:session_id/executions/:goal_id',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectSessionExecution,
        handler: req => withExecutionParams(req, (sessionId, goalId) => service.get(req, sessionId, goalId)),
      },
      {
        method: 'GET',
        path: '/api/v1/me/sessions/:session_id/executions/:goal_id/stream',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        responseKind: 'sse',
        streamPolicy: EXECUTION_STREAM_POLICY,
        privacyProjector: projectSessionExecution,
        streamEventProjectors: {
          init: projectExecutionStreamInit,
          update: projectSessionExecution,
          end: projectExecutionStreamEnd,
        },
        handler: req => withExecutionParams(req, (sessionId, goalId) => {
          const lastEventId = parseConsoleLastEventId(req, EXECUTION_STREAM_POLICY);
          if (!lastEventId.ok) {
            throw new ConsoleStoreValidationError('Invalid Last-Event-ID header for this stream.');
          }
          return service.stream(req, sessionId, goalId, {
            stream_id: `me.sessions.${sessionId}.executions.${goalId}`,
            stream_type: 'session_execution',
            resume_supported: false,
            session_id: sessionId,
            goal_id: goalId,
          });
        }),
      },
      {
        method: 'GET',
        path: '/api/v1/me/sessions/:session_id/gatekeeper',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectSessionGatekeeper,
        handler: req => withSessionId(req, sessionId => service.gatekeeper(req, sessionId)),
      },
    ],
  };
}

function projectExecutionStreamInit(value: unknown): unknown {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    connected_at: typeof record.connected_at === 'string' ? record.connected_at : null,
    stream_id: typeof record.stream_id === 'string' ? record.stream_id : '',
    stream_type: 'session_execution',
    resume_supported: record.resume_supported === true,
    session_id: typeof record.session_id === 'string' ? record.session_id : '',
    goal_id: typeof record.goal_id === 'string' ? record.goal_id : '',
  };
}

function projectExecutionStreamEnd(value: unknown): unknown {
  const end = value && typeof value === 'object' ? value as { readonly status?: unknown } : {};
  return { status: end.status === 'complete' ? 'complete' : 'closed' };
}

function withSessionId(
  req: ConsoleRequest,
  action: (sessionId: string) => Promise<ConsoleHandlerResult>,
): Promise<ConsoleHandlerResult> | ConsoleHandlerResult {
  const sessionId = req.params.session_id;
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return invalidRequest('session_id path parameter is required.');
  }
  return action(sessionId);
}

function withExecutionParams(
  req: ConsoleRequest,
  action: (sessionId: string, goalId: string) => Promise<ConsoleHandlerResult>,
): Promise<ConsoleHandlerResult> | ConsoleHandlerResult {
  const sessionId = req.params.session_id;
  const goalId = req.params.goal_id;
  if (typeof sessionId !== 'string' || sessionId.trim() === '' ||
      typeof goalId !== 'string' || goalId.trim() === '') {
    return invalidRequest('session_id and goal_id path parameters are required.');
  }
  return action(sessionId, goalId);
}

function invalidRequest(detail: string): ConsoleHandlerResult {
  return {
    status: 400,
    body: {
      type: 'about:blank',
      title: 'Invalid request',
      status: 400,
      code: 'invalid_request',
      detail,
    },
  };
}
