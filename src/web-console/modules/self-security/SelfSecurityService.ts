import type { ConsoleHandlerResult, ConsoleRequest } from '../../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { IConsoleFactorStore } from '../../stores/IConsoleFactorStore.js';
import { serializeSelfSecurityFactors } from './SelfSecurityDtos.js';

const TOTP_ENROLL_PATH = '/auth/totp/enroll';
const TOTP_DISABLE_PATH = '/auth/totp/disable';

export class SelfSecurityService {
  constructor(private readonly factorStore: IConsoleFactorStore) {}

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
}
