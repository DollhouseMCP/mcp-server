import type {
  ConsoleModuleDescriptor,
} from '../../platform/ConsolePlatformTypes.js';
import type { IConsoleFactorStore } from '../../stores/IConsoleFactorStore.js';
import { SelfSecurityService } from './SelfSecurityService.js';
import { projectSelfSecurityFactors } from './SelfSecurityPrivacyProjectors.js';

const SELF_CAPABILITY = 'console:self';

export interface SelfSecurityModuleOptions {
  readonly factorStore: IConsoleFactorStore;
}

export function createSelfSecurityModule(options: SelfSecurityModuleOptions): ConsoleModuleDescriptor {
  const service = new SelfSecurityService(options.factorStore);
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
