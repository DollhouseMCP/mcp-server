import type {
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import type { ISigningKeyStore } from '../../../storage/signingKeys/ISigningKeyStore.js';
import type { IConsoleFactorStore } from '../../stores/IConsoleFactorStore.js';
import type { IConsoleAuthPolicyStore } from '../../stores/IConsoleAuthPolicyStore.js';
import type { IConsoleSecurityInvalidationStore } from '../../services/invalidation/IConsoleSecurityInvalidationStore.js';
import { SecurityAdminService } from './SecurityAdminService.js';
import {
  projectSecurityAuthPolicy,
  projectSecuritySigningKeyJob,
  projectSecuritySigningKeyKind,
  projectSecuritySigningKeyList,
  projectSecurityTotpReset,
} from './SecurityAdminPrivacyProjectors.js';

const SECURITY_CAPABILITY = 'console:admin:security';
const SECURITY_AUDIT_IDS = [
  'security.signing_keys.list',
  'security.signing_keys.show',
  'security.signing_keys.rotate',
  'security.signing_keys.retire',
  'security.signing_keys.delete',
  'security.signing_keys.jobs.show',
  'security.auth_policy.show',
  'security.auth_policy.update',
  'security.users.totp.reset',
] as const;

export interface SecurityAdminModuleOptions {
  readonly signingKeyStore: ISigningKeyStore;
  readonly factorStore: IConsoleFactorStore;
  readonly invalidationStore: IConsoleSecurityInvalidationStore;
  readonly authPolicyStore: IConsoleAuthPolicyStore;
  readonly now?: () => Date;
}

export function createSecurityAdminModule(options: SecurityAdminModuleOptions): ConsoleModuleDescriptor {
  const service = new SecurityAdminService(
    options.signingKeyStore,
    options.factorStore,
    options.invalidationStore,
    options.authPolicyStore,
    undefined,
    options.now,
  );
  return {
    id: 'security-admin',
    apiVersion: 'v1',
    capabilities: [SECURITY_CAPABILITY],
    routes: [
      {
        method: 'GET',
        path: '/api/v1/admin/security/signing-keys',
        audience: 'admin',
        requiredCapability: SECURITY_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'security_metadata',
        idempotency: 'not_applicable',
        auditOperation: 'security.signing_keys.list',
        privacyProjector: projectSecuritySigningKeyList,
        handler: () => service.listSigningKeys(),
      },
      {
        method: 'GET',
        path: '/api/v1/admin/security/signing-keys/:kind',
        audience: 'admin',
        requiredCapability: SECURITY_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'security_metadata',
        idempotency: 'not_applicable',
        auditOperation: 'security.signing_keys.show',
        privacyProjector: projectSecuritySigningKeyKind,
        handler: req => service.getSigningKeyKind(firstString(req.params.kind) ?? ''),
      },
      {
        method: 'POST',
        path: '/api/v1/admin/security/signing-keys/:kind/rotate',
        audience: 'admin',
        requiredCapability: SECURITY_CAPABILITY,
        elevation: 'admin_5m',
        privacyClass: 'security_metadata',
        idempotency: 'required',
        auditOperation: 'security.signing_keys.rotate',
        privacyProjector: projectSecuritySigningKeyJob,
        handler: req => service.rotateSigningKey(firstString(req.params.kind) ?? ''),
      },
      {
        method: 'POST',
        path: '/api/v1/admin/security/signing-keys/:kind/:kid/retire',
        audience: 'admin',
        requiredCapability: SECURITY_CAPABILITY,
        elevation: 'admin_5m',
        privacyClass: 'security_metadata',
        idempotency: 'required',
        auditOperation: 'security.signing_keys.retire',
        privacyProjector: projectSecuritySigningKeyJob,
        handler: req => service.retireSigningKey(
          firstString(req.params.kind) ?? '',
          firstString(req.params.kid) ?? '',
        ),
      },
      {
        method: 'DELETE',
        path: '/api/v1/admin/security/signing-keys/:kind/:kid',
        audience: 'admin',
        requiredCapability: SECURITY_CAPABILITY,
        elevation: 'admin_5m',
        privacyClass: 'security_metadata',
        idempotency: 'required',
        auditOperation: 'security.signing_keys.delete',
        privacyProjector: projectSecuritySigningKeyJob,
        handler: req => service.deleteSigningKey(
          firstString(req.params.kind) ?? '',
          firstString(req.params.kid) ?? '',
          req.body,
        ),
      },
      {
        method: 'GET',
        path: '/api/v1/admin/security/signing-keys/jobs/:id',
        audience: 'admin',
        requiredCapability: SECURITY_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'security_metadata',
        idempotency: 'not_applicable',
        auditOperation: 'security.signing_keys.jobs.show',
        privacyProjector: projectSecuritySigningKeyJob,
        handler: req => service.getSigningKeyJob(firstString(req.params.id) ?? ''),
      },
      {
        method: 'GET',
        path: '/api/v1/admin/security/auth-policy',
        audience: 'admin',
        requiredCapability: SECURITY_CAPABILITY,
        elevation: 'admin_30m',
        privacyClass: 'security_metadata',
        idempotency: 'not_applicable',
        auditOperation: 'security.auth_policy.show',
        privacyProjector: projectSecurityAuthPolicy,
        handler: () => service.getAuthPolicy(),
      },
      {
        method: 'PUT',
        path: '/api/v1/admin/security/auth-policy',
        audience: 'admin',
        requiredCapability: SECURITY_CAPABILITY,
        elevation: 'admin_5m',
        privacyClass: 'security_metadata',
        idempotency: 'required',
        auditOperation: 'security.auth_policy.update',
        privacyProjector: projectSecurityAuthPolicy,
        handler: req => service.putAuthPolicy(req.body, firstString(req.headers['if-match'])),
      },
      {
        method: 'POST',
        path: '/api/v1/admin/security/users/:user_id/factors/totp/reset',
        audience: 'admin',
        requiredCapability: SECURITY_CAPABILITY,
        elevation: 'admin_5m',
        privacyClass: 'security_metadata',
        idempotency: 'required',
        auditOperation: 'security.users.totp.reset',
        privacyProjector: projectSecurityTotpReset,
        handler: req => service.resetTotp(
          firstString(req.params.user_id) ?? '',
          req.consoleAuthentication?.userId ?? null,
        ),
      },
    ],
    auditOperations: SECURITY_AUDIT_IDS.map(id => ({ id })),
  };
}

function firstString(value: ConsoleRequest['params'][string] | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
