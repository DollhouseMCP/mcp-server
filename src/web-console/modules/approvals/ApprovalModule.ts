import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import type { IRuntimeSessionControlStore } from '../../services/runtime/IRuntimeSessionControlStore.js';
import { ApprovalService } from './ApprovalService.js';
import { projectSessionApproval, projectSessionApprovalList } from './ApprovalPrivacyProjectors.js';
import type { ISessionApprovalEventSink } from './ApprovalEvents.js';
import type { SessionApprovalStore } from './ApprovalStore.js';

const SELF_CAPABILITY = 'console:self';

export interface ApprovalModuleOptions {
  readonly runtimeStore: IRuntimeSessionControlStore;
  readonly approvalStore: SessionApprovalStore;
  readonly eventSink?: ISessionApprovalEventSink | null;
  readonly now?: () => Date;
}

export function createApprovalModule(options: ApprovalModuleOptions): ConsoleModuleDescriptor {
  const service = new ApprovalService(options);
  return {
    id: 'approvals',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    events: [{
      type: 'console.session.approval.decided.v1',
      schemaId: 'console.session.approval.decided.v1',
    }],
    routes: [
      {
        method: 'GET',
        path: '/api/v1/me/sessions/:session_id/approvals',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'not_applicable',
        privacyProjector: projectSessionApprovalList,
        handler: req => withSessionId(req, sessionId => service.list(req, sessionId)),
      },
      {
        method: 'POST',
        path: '/api/v1/me/sessions/:session_id/approvals/:approval_id/approve',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'required',
        privacyProjector: projectSessionApproval,
        handler: req => withApprovalParams(
          req,
          (sessionId, approvalId) => service.decide(req, sessionId, approvalId, 'approved'),
        ),
      },
      {
        method: 'POST',
        path: '/api/v1/me/sessions/:session_id/approvals/:approval_id/deny',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'owned_session',
        elevation: 'none',
        privacyClass: 'self_private',
        idempotency: 'required',
        privacyProjector: projectSessionApproval,
        handler: req => withApprovalParams(
          req,
          (sessionId, approvalId) => service.decide(req, sessionId, approvalId, 'denied'),
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

function withApprovalParams(
  req: ConsoleRequest,
  action: (sessionId: string, approvalId: string) => Promise<ConsoleHandlerResult>,
): Promise<ConsoleHandlerResult> | ConsoleHandlerResult {
  const sessionId = req.params.session_id;
  const approvalId = req.params.approval_id;
  if (typeof sessionId !== 'string' || sessionId.trim() === '' ||
      typeof approvalId !== 'string' || approvalId.trim() === '') {
    return invalidRequest('session_id and approval_id path parameters are required.');
  }
  return action(sessionId, approvalId);
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
