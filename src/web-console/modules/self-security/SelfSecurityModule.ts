import type {
  ConsoleHandlerResult,
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import type { IConsoleFactorStore } from '../../stores/IConsoleFactorStore.js';
import type { IConsoleSessionStore } from '../../stores/IConsoleSessionStore.js';
import { SelfSecurityService } from './SelfSecurityService.js';
import {
  projectSelfSecurityFactors,
  projectSelfSecurityRevokeOthers,
  projectSelfSecuritySessionRevocation,
  projectSelfSecuritySessions,
} from './SelfSecurityPrivacyProjectors.js';

const SELF_CAPABILITY = 'console:self';

export interface SelfSecurityModuleOptions {
  readonly factorStore: IConsoleFactorStore;
  readonly sessionStore: IConsoleSessionStore;
  readonly now?: () => Date;
}

export function createSelfSecurityModule(options: SelfSecurityModuleOptions): ConsoleModuleDescriptor {
  const service = new SelfSecurityService(options.factorStore, options.sessionStore, options.now);
  return {
    id: 'selfSecurity',
    apiVersion: 'v1',
    capabilities: [SELF_CAPABILITY],
    events: [
      { type: 'self_security.factor_deep_link.v1', schemaId: 'self_security.factor_deep_link.v1' },
    ],
    routes: [
      {
        method: 'GET',
        path: '/api/v1/me/security/factors',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_security',
        idempotency: 'not_applicable',
        privacyProjector: projectSelfSecurityFactors,
        handler: req => service.getFactors(req),
      },
      {
        method: 'GET',
        path: '/api/v1/me/security/sessions',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_security',
        idempotency: 'not_applicable',
        privacyProjector: projectSelfSecuritySessions,
        handler: req => service.listSessions(req),
      },
      {
        // These revocation routes intentionally require only the existing
        // session: users must be able to recover by logging out lost devices
        // even when no fresh administrative proof is available.
        method: 'DELETE',
        path: '/api/v1/me/security/sessions/:session_id',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_security',
        idempotency: 'required',
        privacyProjector: projectSelfSecuritySessionRevocation,
        handler: req => withSessionId(req, sessionId => service.revokeSession(req, sessionId)),
      },
      {
        // These revocation routes intentionally require only the existing
        // session: users must be able to recover by logging out lost devices
        // even when no fresh administrative proof is available.
        method: 'POST',
        path: '/api/v1/me/security/sessions/revoke-all-others',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_security',
        idempotency: 'required',
        privacyProjector: projectSelfSecurityRevokeOthers,
        handler: req => service.revokeAllOtherSessions(req),
      },
      {
        // Redirect shim only: AS-owned interaction routes require explicit
        // confirmation before enrollment or disablement state changes.
        method: 'GET',
        path: '/api/v1/me/security/factors/enroll/totp',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_security',
        idempotency: 'not_applicable',
        handler: req => service.enrollTotp(req),
      },
      {
        // Redirect shim only: AS-owned interaction routes require explicit
        // confirmation before enrollment or disablement state changes.
        method: 'GET',
        path: '/api/v1/me/security/factors/disable/totp',
        audience: 'self',
        requiredCapability: SELF_CAPABILITY,
        ownership: 'authenticated_user',
        elevation: 'none',
        privacyClass: 'self_security',
        idempotency: 'not_applicable',
        handler: req => service.disableTotp(req),
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
    return {
      status: 400,
      body: {
        type: 'about:blank',
        title: 'Invalid request',
        status: 400,
        code: 'invalid_request',
        detail: 'session_id path parameter is required.',
      },
    };
  }
  return action(sessionId);
}
