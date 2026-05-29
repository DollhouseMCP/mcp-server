import type { ConsoleHandlerResult } from '../../platform/ConsolePlatformTypes.js';
import {
  toPublicHealthDto,
  toPublicReadinessDto,
  type HealthReadinessSnapshot,
} from './HealthDtos.js';

export type HealthReadinessCheck = () => boolean | Promise<boolean>;

export interface HealthReadinessChecks {
  readonly sessionStorageAvailable: HealthReadinessCheck;
  readonly identityResolutionAvailable: HealthReadinessCheck;
  readonly securityInvalidationReady: HealthReadinessCheck;
  readonly runtimeControlAvailable: HealthReadinessCheck;
  readonly databaseAvailable: HealthReadinessCheck;
  readonly authServerAvailable: HealthReadinessCheck;
  readonly apiV1Mounted: HealthReadinessCheck;
}

export class HealthService {
  private readonly now: () => Date;

  constructor(
    private readonly checks: HealthReadinessChecks,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  getHealth(): ConsoleHandlerResult {
    return {
      status: 200,
      body: toPublicHealthDto(this.now()),
    };
  }

  async getReadiness(): Promise<ConsoleHandlerResult> {
    const snapshot = await this.createReadinessSnapshot();
    return {
      status: snapshot.ready ? 200 : 503,
      body: toPublicReadinessDto(snapshot),
    };
  }

  private async createReadinessSnapshot(): Promise<HealthReadinessSnapshot> {
    const ready = await this.isReady();
    return {
      checkedAt: this.now(),
      status: ready ? 'ok' : 'not_ready',
      ready,
    };
  }

  private async isReady(): Promise<boolean> {
    const results = await Promise.all([
      this.checks.sessionStorageAvailable(),
      this.checks.identityResolutionAvailable(),
      this.checks.securityInvalidationReady(),
      this.checks.runtimeControlAvailable(),
      this.checks.databaseAvailable(),
      this.checks.authServerAvailable(),
      this.checks.apiV1Mounted(),
    ]);
    return results.every(Boolean);
  }
}
