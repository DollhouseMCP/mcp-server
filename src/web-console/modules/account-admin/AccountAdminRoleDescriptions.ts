import type { ConsoleAdminRole } from '../../stores/IConsoleAccountAdminStore.js';

export interface ConsoleRoleDescription {
  readonly name: string;
  readonly summary: string;
  readonly sensitivePowers: string;
}

/** Product copy shared by every role editor through the server role catalog. */
export const ROLE_DESCRIPTIONS: Readonly<Record<ConsoleAdminRole, ConsoleRoleDescription>> = {
  admin: {
    name: 'Administrator',
    summary: 'Manage accounts, server operations, audit records, and security settings.',
    sensitivePowers: 'Combines all administrative powers, including account deletion and signing-key management. Assign only to trusted server administrators.',
  },
  account_admin: {
    name: 'Account administrator',
    summary: 'Invite and manage users, linked logins, roles, and account sessions.',
    sensitivePowers: 'Can disable or delete accounts and revoke credentials. Role changes are limited to powers the administrator already holds.',
  },
  operator: {
    name: 'Operator',
    summary: 'Monitor server health, logs, and metrics, and manage exposed operational configuration.',
    sensitivePowers: 'Can change server configuration and read operational logs. Does not grant account or security administration.',
  },
  auditor: {
    name: 'Auditor',
    summary: 'Read administrative, approval, and authentication audit records.',
    sensitivePowers: 'Can inspect and export administrative audit history, which may contain sensitive account activity. Does not grant account changes.',
  },
  security_admin: {
    name: 'Security administrator',
    summary: 'Manage signing keys, authentication policy, and administrator authenticator recovery.',
    sensitivePowers: 'Can rotate or retire signing keys, change authentication policy, and reset user TOTP factors. Does not grant account administration.',
  },
};

export const ROLE_GUIDANCE = {
  noAdministrativeRoles: 'With no administrative roles, an active account can use its own permitted console and MCP features, but cannot administer other accounts or the server.',
  elevation: 'Administrative actions require an enrolled TOTP authenticator and an elevated session; assigning a role does not bypass these checks.',
  management: 'Changing roles requires account administration and all powers of the role being changed. You cannot grant additional roles to yourself. Server policy also protects the last usable administrator.',
} as const;
