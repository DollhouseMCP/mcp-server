import type { ConsoleHandlerResult, ConsoleSseEvent } from '../../platform/ConsolePlatformTypes.js';
import type {
  OperationHealthComponent,
  OperationHealthComponentDto,
  OperationHealthStatus,
} from './OperationsDtos.js';
import {
  evaluateOperationHealthComponent,
  type OperationsHealthChecks,
} from './OperationsHealth.js';
import type {
  IConsoleTelemetryQuery,
  OperationalLogQuery,
  OperationalMetricQuery,
} from './OperationsTelemetry.js';

export class OperationsService {
  private readonly now: () => Date;

  constructor(
    private readonly healthChecks: OperationsHealthChecks,
    private readonly telemetry: IConsoleTelemetryQuery,
    now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  async getHealth(): Promise<ConsoleHandlerResult> {
    const checkedAt = this.now();
    const components = await Promise.all([
      this.getHealthComponent('database', checkedAt),
      this.getHealthComponent('auth_server', checkedAt),
      this.getHealthComponent('gatekeeper', checkedAt),
      this.getHealthComponent('runtime_control', checkedAt),
      this.getHealthComponent('security_invalidation', checkedAt),
      this.getHealthComponent('api_mount', checkedAt),
    ]);
    const status = summarizeStatus(components);
    return {
      status: status === 'unavailable' ? 503 : 200,
      body: {
        status,
        checked_at: checkedAt.toISOString(),
        components,
      },
    };
  }

  async getDatabaseHealth(): Promise<ConsoleHandlerResult> {
    return this.getSingleHealthComponent('database');
  }

  async getAuthServerHealth(): Promise<ConsoleHandlerResult> {
    return this.getSingleHealthComponent('auth_server');
  }

  async getGatekeeperHealth(): Promise<ConsoleHandlerResult> {
    return this.getSingleHealthComponent('gatekeeper');
  }

  async queryLogs(query: OperationalLogQuery): Promise<ConsoleHandlerResult> {
    return { status: 200, body: await this.telemetry.queryOperationalLogs(query) };
  }

  async queryMetrics(query: OperationalMetricQuery): Promise<ConsoleHandlerResult> {
    return { status: 200, body: await this.telemetry.queryOperationalMetrics(query) };
  }

  streamLogs(query: OperationalLogQuery, init: unknown): ConsoleHandlerResult {
    return {
      status: 200,
      stream: {
        init,
        events: streamLogEvents(this.telemetry.streamOperationalLogs(query)),
      },
    };
  }

  private async getSingleHealthComponent(component: OperationHealthComponent): Promise<ConsoleHandlerResult> {
    const checkedAt = this.now();
    const body = await this.getHealthComponent(component, checkedAt);
    return {
      status: body.status === 'unavailable' ? 503 : 200,
      body,
    };
  }

  private async getHealthComponent(
    component: OperationHealthComponent,
    checkedAt: Date,
  ): Promise<OperationHealthComponentDto> {
    switch (component) {
      case 'database':
        return evaluateOperationHealthComponent(component, this.healthChecks.database, checkedAt);
      case 'auth_server':
        return evaluateOperationHealthComponent(component, this.healthChecks.authServer, checkedAt);
      case 'gatekeeper':
        return evaluateOperationHealthComponent(component, this.healthChecks.gatekeeper, checkedAt);
      case 'runtime_control':
        return evaluateOperationHealthComponent(component, this.healthChecks.runtimeControl, checkedAt);
      case 'security_invalidation':
        return evaluateOperationHealthComponent(component, this.healthChecks.securityInvalidation, checkedAt);
      case 'api_mount':
        return evaluateOperationHealthComponent(component, this.healthChecks.apiMount, checkedAt);
    }
  }
}

async function* streamLogEvents(logs: AsyncIterable<unknown>): AsyncIterable<ConsoleSseEvent> {
  for await (const log of logs) {
    yield {
      event: 'update',
      data: log,
    };
  }
  yield {
    event: 'end',
    data: {
      status: 'complete',
    },
  };
}

function summarizeStatus(components: readonly OperationHealthComponentDto[]): OperationHealthStatus {
  if (components.some(component => component.status === 'unavailable')) return 'unavailable';
  if (components.some(component => component.status === 'degraded' || component.status === 'not_ready')) return 'degraded';
  return 'ok';
}
