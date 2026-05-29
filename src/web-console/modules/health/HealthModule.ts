import type { ConsoleModuleDescriptor } from '../../platform/ConsolePlatformTypes.js';
import { HealthService, type HealthReadinessChecks } from './HealthService.js';

export interface HealthModuleOptions {
  readonly readiness: HealthReadinessChecks;
  readonly now?: () => Date;
}

export function createHealthModule(options: HealthModuleOptions): ConsoleModuleDescriptor {
  const service = new HealthService(options.readiness, options.now);
  return {
    id: 'health',
    apiVersion: 'v1',
    capabilities: [],
    routes: [
      {
        method: 'GET',
        path: '/api/v1/health',
        audience: 'public',
        requiredCapability: 'none',
        ownership: 'none',
        elevation: 'none',
        privacyClass: 'operational_allowlist',
        idempotency: 'not_applicable',
        handler: () => service.getHealth(),
      },
      {
        method: 'GET',
        path: '/api/v1/health/ready',
        audience: 'public',
        requiredCapability: 'none',
        ownership: 'none',
        elevation: 'none',
        privacyClass: 'operational_allowlist',
        idempotency: 'not_applicable',
        handler: () => service.getReadiness(),
      },
    ],
  };
}
