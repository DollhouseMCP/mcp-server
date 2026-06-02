import type { ConsoleCapability, ConsoleRequest } from '../../platform/ConsolePlatformTypes.js';
import type { ConsoleAdminRole } from '../../stores/IConsoleAccountAdminStore.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';

export const ROLE_GRANT_CAPABILITIES: Readonly<Record<ConsoleAdminRole, readonly ConsoleCapability[]>> = {
  admin: ['console:admin:accounts', 'console:admin:operate', 'console:admin:audit', 'console:admin:security'],
  account_admin: ['console:admin:accounts'],
  operator: ['console:admin:operate'],
  auditor: ['console:admin:audit'],
  security_admin: ['console:admin:security'],
};

/**
 * The de-duplicated set of admin capabilities a set of role names entitles a
 * principal to. Unknown role names are ignored. Used so a single admin step-up
 * elevates a session to the principal's FULL role-entitled capability set
 * (e.g. an `admin` gets operate + accounts + audit + security at once) rather
 * than forcing a separate step-up per capability.
 */
export function capabilitiesForRoles(roles: readonly string[]): readonly ConsoleCapability[] {
  const granted = new Set<ConsoleCapability>();
  for (const role of roles) {
    // Unknown role names are ignored; hasOwn is a real runtime guard (the Record
    // index type would otherwise claim the lookup is always present).
    if (Object.hasOwn(ROLE_GRANT_CAPABILITIES, role)) {
      for (const capability of ROLE_GRANT_CAPABILITIES[role as ConsoleAdminRole]) granted.add(capability);
    }
  }
  return [...granted];
}

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
