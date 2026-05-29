import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import type { IRuntimeSessionControlStore } from '../../services/runtime/IRuntimeSessionControlStore.js';
import type { IPortfolioElementStore } from '../../stores/IPortfolioElementStore.js';
import { ActivationService } from './ActivationService.js';
import {
  projectSessionActivation,
  projectSessionActivationList,
  projectSessionDeactivation,
} from './ActivationPrivacyProjectors.js';
import type { ISessionActivationEventSink } from './ActivationEvents.js';
import type { ISessionActivationStateAdapter } from './SessionActivationStateAdapter.js';

const SELF_CAPABILITY = 'console:self';

export interface ActivationModuleOptions {
  readonly runtimeStore: IRuntimeSessionControlStore;
  readonly portfolioStore: IPortfolioElementStore;
  readonly activationState: ISessionActivationStateAdapter;
  readonly eventSink?: ISessionActivationEventSink | null;
  readonly now?: () => Date;
}

export function createActivationModule(options: ActivationModuleOptions): ConsoleModuleDescriptor {
  const service = new ActivationService(options);
  return {
    id: 'activations',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    events: [{
      type: 'console.session.activation.changed.v1',
      schemaId: 'console.session.activation.changed.v1',
    }],
    routes: [
      {
        method: 'GET',
        path: '/api/v1/me/sessions/:session_id/activations',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectSessionActivationList,
        handler: req => withSessionId(req, sessionId => service.list(req, sessionId)),
      },
      {
        method: 'POST',
        path: '/api/v1/me/sessions/:session_id/activations',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'required',
        privacyProjector: projectSessionActivation,
        handler: req => withSessionId(req, sessionId => service.activate(req, sessionId)),
      },
      {
        method: 'DELETE',
        path: '/api/v1/me/sessions/:session_id/activations/:type/:name',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'required',
        privacyProjector: projectSessionDeactivation,
        handler: req => withActivationParams(
          req,
          (sessionId, type, name) => service.deactivate(req, sessionId, type, name),
        ),
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

function withActivationParams(
  req: ConsoleRequest,
  action: (sessionId: string, type: string, name: string) => Promise<ConsoleHandlerResult>,
): Promise<ConsoleHandlerResult> | ConsoleHandlerResult {
  const sessionId = req.params.session_id;
  const type = req.params.type;
  const name = req.params.name;
  if (typeof sessionId !== 'string' || sessionId.trim() === '' ||
      typeof type !== 'string' || type.trim() === '' ||
      typeof name !== 'string' || name.trim() === '') {
    return invalidRequest('session_id, type, and name path parameters are required.');
  }
  return action(sessionId, type, name);
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
