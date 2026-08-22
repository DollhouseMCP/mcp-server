import type { ConsoleRequest } from '../../platform/ConsolePlatformTypes.js';
import type { ConsoleAdminRole } from '../../stores/IConsoleAccountAdminStore.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import { ROLE_GRANT_CAPABILITIES } from '../../platform/ConsoleRoleCapabilities.js';

export { ROLE_GRANT_CAPABILITIES, capabilitiesForRoles } from '../../platform/ConsoleRoleCapabilities.js';

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
