import type { ConsoleCapability, ConsoleRequest } from '../../platform/ConsolePlatformTypes.js';
import type { ConsoleAdminRole } from '../../stores/IConsoleAccountAdminStore.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';

const ROLE_GRANT_CAPABILITIES: Readonly<Record<ConsoleAdminRole, readonly ConsoleCapability[]>> = {
  admin: ['console:admin:accounts', 'console:admin:operate', 'console:admin:audit', 'console:admin:security'],
  account_admin: ['console:admin:accounts'],
  operator: ['console:admin:operate'],
  auditor: ['console:admin:audit'],
  security_admin: ['console:admin:security'],
};

export function rolesActorMayNotManage(
  req: ConsoleRequest,
  roles: readonly ConsoleAdminRole[],
): readonly ConsoleAdminRole[] {
  const actor = requireConsoleAuthentication(req);
  return roles.filter(role => {
    const requiredCapabilities = ROLE_GRANT_CAPABILITIES[role];
    return requiredCapabilities.some(capability => !actor.grantedCapabilities.includes(capability));
  });
}
