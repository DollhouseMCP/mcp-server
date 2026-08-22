import type { ConsoleAdminRole } from '../stores/IConsoleAccountAdminStore.js';
import type { ConsoleCapability } from './ConsolePlatformTypes.js';

export const ROLE_GRANT_CAPABILITIES: Readonly<Record<ConsoleAdminRole, readonly ConsoleCapability[]>> = {
  admin: ['console:admin:accounts', 'console:admin:operate', 'console:admin:audit', 'console:admin:security'],
  account_admin: ['console:admin:accounts'],
  operator: ['console:admin:operate'],
  auditor: ['console:admin:audit'],
  security_admin: ['console:admin:security'],
};

const ADMIN_CAPABILITIES = new Set<ConsoleCapability>(Object.values(ROLE_GRANT_CAPABILITIES).flat());

/** Return the de-duplicated administrative capabilities granted by active roles. */
export function capabilitiesForRoles(roles: readonly string[]): readonly ConsoleCapability[] {
  const granted = new Set<ConsoleCapability>();
  for (const role of roles) {
    if (Object.hasOwn(ROLE_GRANT_CAPABILITIES, role)) {
      for (const capability of ROLE_GRANT_CAPABILITIES[role as ConsoleAdminRole]) granted.add(capability);
    }
  }
  return [...granted];
}

export function isAdministrativeCapability(capability: ConsoleCapability): boolean {
  return ADMIN_CAPABILITIES.has(capability);
}
