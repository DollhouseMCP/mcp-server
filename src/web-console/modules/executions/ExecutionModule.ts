import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import type { IRuntimeSessionControlStore } from '../../services/runtime/IRuntimeSessionControlStore.js';
import { ExecutionService } from './ExecutionService.js';
import type { SessionExecutionReader, SessionGatekeeperReader } from './ExecutionStore.js';
import {
  projectSessionExecution,
  projectSessionExecutionList,
  projectSessionGatekeeper,
} from './ExecutionPrivacyProjectors.js';

const SELF_CAPABILITY = 'console:self';

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
