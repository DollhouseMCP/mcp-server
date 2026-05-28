import type { ConsoleHandlerResult, ConsoleRequest } from '../../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import {
  CONSOLE_CSRF_COOKIE,
  CONSOLE_LOGIN_STATE_COOKIE,
  CONSOLE_SESSION_COOKIE,
} from '../../middleware/ConsoleCookies.js';
import type { IConsoleFactorStore } from '../../stores/IConsoleFactorStore.js';
import type { IConsoleSessionStore } from '../../stores/IConsoleSessionStore.js';
import {
  decodeSessionId,
  encodeSessionId,
  serializeSelfSecurityFactors,
  serializeSelfSecuritySessions,
} from './SelfSecurityDtos.js';

const TOTP_ENROLL_PATH = '/auth/totp/enroll';
const TOTP_DISABLE_PATH = '/auth/totp/disable';
const SESSION_LIST_LIMIT = 100;

export class SelfSecurityService {
  constructor(
    private readonly factorStore: IConsoleFactorStore,
    private readonly sessionStore: IConsoleSessionStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getFactors(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const status = await this.factorStore.getTotpStatus(actor.userId);
    return {
      status: 200,
      body: serializeSelfSecurityFactors(status),
    };
  }

  enrollTotp(req: ConsoleRequest): ConsoleHandlerResult {
    requireConsoleAuthentication(req);
    return {
      status: 302,
      redirectTo: TOTP_ENROLL_PATH,
    };
  }

  disableTotp(req: ConsoleRequest): ConsoleHandlerResult {
    requireConsoleAuthentication(req);
    return {
      status: 302,
      redirectTo: TOTP_DISABLE_PATH,
    };
  }

  async listSessions(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const sessions = await this.sessionStore.listActiveForUser(actor.userId, this.now(), SESSION_LIST_LIMIT + 1);
    const visibleSessions = sessions.slice(0, SESSION_LIST_LIMIT);
    return {
      status: 200,
      body: serializeSelfSecuritySessions(visibleSessions, actor.sessionIdHash, {
        truncated: sessions.length > SESSION_LIST_LIMIT,
        limit: SESSION_LIST_LIMIT,
      }),
    };
  }

  async revokeSession(req: ConsoleRequest, sessionId: string): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const idHash = decodeSessionId(sessionId);
    if (!idHash) return invalidSessionId();
    const revoked = await this.sessionStore.revokeForUserSession(actor.userId, idHash, this.now());
    if (!revoked) {
      return {
        status: 404,
        body: {
          type: 'about:blank',
          title: 'Session not found',
          status: 404,
          code: 'session_not_found',
          detail: 'The requested console session was not found.',
        },
      };
    }
    const currentSessionRevoked = idHash.equals(actor.sessionIdHash);
    return {
      status: 200,
      body: {
        session_id: encodeSessionId(idHash),
        revoked,
        current_session_revoked: currentSessionRevoked,
      },
      cookies: currentSessionRevoked ? clearSessionCookies() : undefined,
    };
  }

  async revokeAllOtherSessions(req: ConsoleRequest): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    const revoked = await this.sessionStore.revokeForUserExcept(actor.userId, actor.sessionIdHash, this.now());
    return {
      status: 200,
      body: { revoked },
    };
  }
}

function invalidSessionId(): ConsoleHandlerResult {
  return {
    status: 400,
    body: {
      type: 'about:blank',
      title: 'Invalid request',
      status: 400,
      code: 'invalid_session_id',
      detail: 'session_id path parameter is invalid.',
    },
  };
}

function clearSessionCookies(): ConsoleHandlerResult['cookies'] {
  return [
    { operation: 'clear', name: CONSOLE_SESSION_COOKIE },
    { operation: 'clear', name: CONSOLE_CSRF_COOKIE },
    { operation: 'clear', name: CONSOLE_LOGIN_STATE_COOKIE },
  ];
}
