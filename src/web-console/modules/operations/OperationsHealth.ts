import type {
  OperationHealthComponent,
  OperationHealthComponentDto,
  OperationHealthStatus,
} from './OperationsDtos.js';

export type OperationHealthCheck = () => boolean | OperationHealthComponentDto | Promise<boolean | OperationHealthComponentDto>;

export interface OperationsHealthChecks {
  readonly database: OperationHealthCheck;
  readonly authServer: OperationHealthCheck;
  readonly gatekeeper: OperationHealthCheck;
  readonly runtimeControl: OperationHealthCheck;
  readonly securityInvalidation: OperationHealthCheck;
  readonly apiMount: OperationHealthCheck;
}

export const OPERATION_HEALTH_COMPONENTS: readonly OperationHealthComponent[] = [
  'database',
  'auth_server',
  'gatekeeper',
  'runtime_control',
  'security_invalidation',
  'api_mount',
];

export async function evaluateOperationHealthComponent(
  component: OperationHealthComponent,
  check: OperationHealthCheck,
  checkedAt: Date,
): Promise<OperationHealthComponentDto> {
  try {
    const result = await check();
    if (typeof result === 'boolean') {
      return {
        component,
        status: result ? 'ok' : 'unavailable',
        checked_at: checkedAt.toISOString(),
        failure_codes: result ? [] : [`${component}_unavailable`],
      };
    }
    return normalizeHealthComponent(component, result, checkedAt);
  } catch {
    return {
      component,
      status: 'unavailable',
      checked_at: checkedAt.toISOString(),
      failure_codes: [`${component}_check_failed`],
    };
  }
}

function normalizeHealthComponent(
  component: OperationHealthComponent,
  dto: OperationHealthComponentDto,
  checkedAt: Date,
): OperationHealthComponentDto {
  return {
    component,
    status: normalizeStatus(dto.status),
    checked_at: checkedAt.toISOString(),
    failure_codes: dto.failure_codes
      .filter(code => typeof code === 'string' && code.trim() !== '')
      .slice(0, 8),
  };
}

function normalizeStatus(status: OperationHealthStatus): OperationHealthStatus {
  return ['ok', 'degraded', 'unavailable', 'not_ready'].includes(status) ? status : 'unavailable';
}
