import type {
  ConsoleModuleDescriptor,
  ConsoleRequest,
} from '../../platform/ConsolePlatformTypes.js';
import type { ISigningKeyStore, SigningKeyKind } from '../../../storage/signingKeys/ISigningKeyStore.js';
import type { IConsoleFactorStore } from '../../stores/IConsoleFactorStore.js';
import type { IConsoleAuthPolicyStore } from '../../stores/IConsoleAuthPolicyStore.js';
import type { IConsoleSecurityInvalidationStore } from '../../services/invalidation/IConsoleSecurityInvalidationStore.js';
import type { IAccountAdminMutationTransactionRunner } from '../account-admin/AccountAdminMutationTransaction.js';
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
  'security.auth_policy.show',
  'security.auth_policy.update',
  'security.users.totp.reset',
] as const;

export interface SecurityAdminModuleOptions {
  readonly signingKeyStore: ISigningKeyStore;
  readonly factorStore: IConsoleFactorStore;
  readonly invalidationStore: IConsoleSecurityInvalidationStore;
  readonly authPolicyStore: IConsoleAuthPolicyStore;
  readonly transactionRunner: IAccountAdminMutationTransactionRunner;
  readonly now?: () => Date;
  /** Test/embedding seam; production derives operator ownership from env configuration. */
  readonly isOperatorManagedSigningKey?: (kind: SigningKeyKind) => boolean;
}

export function createSecurityAdminModule(options: SecurityAdminModuleOptions): ConsoleModuleDescriptor {
  const service = new SecurityAdminService(
    options.signingKeyStore,
    options.authPolicyStore,
    options.transactionRunner,
    options.now,
    options.isOperatorManagedSigningKey,
  );
  let rotateRoute: ConsoleModuleDescriptor['routes'][number];
  let retireRoute: ConsoleModuleDescriptor['routes'][number];
  let deleteRoute: ConsoleModuleDescriptor['routes'][number];
  let putAuthPolicyRoute: ConsoleModuleDescriptor['routes'][number];
  let resetTotpRoute: ConsoleModuleDescriptor['routes'][number];
  rotateRoute = {
    method: 'POST', path: '/api/v1/admin/security/signing-keys/:kind/rotate', audience: 'admin',
    requiredCapability: SECURITY_CAPABILITY, elevation: 'admin_fresh', privacyClass: 'security_metadata',
    idempotency: 'required', auditOperation: 'security.signing_keys.rotate', auditExecution: 'handler_transaction',
    privacyProjector: projectSecuritySigningKeyJob,
    handler: req => service.rotateSigningKey(req, rotateRoute, firstString(req.params.kind) ?? ''),
  };
  retireRoute = {
    method: 'POST', path: '/api/v1/admin/security/signing-keys/:kind/:kid/retire', audience: 'admin',
    requiredCapability: SECURITY_CAPABILITY, elevation: 'admin_fresh', privacyClass: 'security_metadata',
    idempotency: 'required', auditOperation: 'security.signing_keys.retire', auditExecution: 'handler_transaction',
    privacyProjector: projectSecuritySigningKeyJob,
    handler: req => service.retireSigningKey(req, retireRoute, firstString(req.params.kind) ?? '', firstString(req.params.kid) ?? ''),
  };
  deleteRoute = {
    method: 'DELETE', path: '/api/v1/admin/security/signing-keys/:kind/:kid', audience: 'admin',
    requiredCapability: SECURITY_CAPABILITY, elevation: 'admin_fresh', privacyClass: 'security_metadata',
    idempotency: 'required', auditOperation: 'security.signing_keys.delete', auditExecution: 'handler_transaction',
    privacyProjector: projectSecuritySigningKeyJob,
    handler: req => service.deleteSigningKey(req, deleteRoute, firstString(req.params.kind) ?? '', firstString(req.params.kid) ?? '', req.body),
  };
  putAuthPolicyRoute = {
    method: 'PUT', path: '/api/v1/admin/security/auth-policy', audience: 'admin',
    requiredCapability: SECURITY_CAPABILITY, elevation: 'admin_fresh', privacyClass: 'security_metadata',
    idempotency: 'required', auditOperation: 'security.auth_policy.update', auditExecution: 'handler_transaction',
    privacyProjector: projectSecurityAuthPolicy,
    handler: req => service.putAuthPolicy(req, putAuthPolicyRoute, req.body, firstString(req.headers['if-match'])),
  };
  resetTotpRoute = {
    method: 'POST', path: '/api/v1/admin/security/users/:user_id/factors/totp/reset', audience: 'admin',
    requiredCapability: SECURITY_CAPABILITY, elevation: 'admin_5m', privacyClass: 'security_metadata',
    idempotency: 'required', auditOperation: 'security.users.totp.reset', auditExecution: 'handler_transaction',
    privacyProjector: projectSecurityTotpReset,
    handler: req => service.resetTotp(req, resetTotpRoute, firstString(req.params.user_id) ?? '', req.consoleAuthentication?.userId ?? null),
  };
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
      rotateRoute,
      retireRoute,
      deleteRoute,
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
      putAuthPolicyRoute,
      resetTotpRoute,
    ],
    auditOperations: SECURITY_AUDIT_IDS.map(id => ({ id })),
  };
}

function firstString(value: ConsoleRequest['params'][string] | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
