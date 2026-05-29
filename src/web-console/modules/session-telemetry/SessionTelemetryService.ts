import type { ConsoleHandlerResult, ConsoleRequest, ConsoleSseEvent } from '../../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { IRuntimeSessionControlStore } from '../../services/runtime/IRuntimeSessionControlStore.js';
import type { ActivityQuery, IOwnedActivityQuery } from './OwnedActivityQuery.js';
import type { IOwnedMetricQuery, MetricQuery } from './OwnedMetricQuery.js';
import {
  projectUserActivityPage,
  projectUserMetrics,
} from './SessionTelemetryProjectors.js';

export class SessionTelemetryService {
  constructor(private readonly options: {
    readonly runtimeStore: IRuntimeSessionControlStore;
    readonly ownedActivityQuery: IOwnedActivityQuery;
    readonly ownedMetricQuery: IOwnedMetricQuery;
    readonly now?: () => Date;
  }) {}

  async queryLogs(req: ConsoleRequest, sessionId: string, query: ActivityQuery): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    if (!await this.isOwnedActiveSession(actor.userId, sessionId)) return notFound();
    return {
      status: 200,
      body: projectUserActivityPage(await this.options.ownedActivityQuery.queryOwnedActivity(actor.userId, sessionId, query)),
    };
  }

  async streamLogs(
    req: ConsoleRequest,
    sessionId: string,
    query: ActivityQuery,
    init: unknown,
  ): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    if (!await this.isOwnedActiveSession(actor.userId, sessionId)) return notFound();
    return {
      status: 200,
      stream: {
        init,
        events: streamActivityEvents(this.options.ownedActivityQuery.streamOwnedActivity(actor.userId, sessionId, query)),
        revalidate: () => this.isOwnedActiveSession(actor.userId, sessionId),
      },
    };
  }

  async queryMetrics(req: ConsoleRequest, sessionId: string, query: MetricQuery): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    if (!await this.isOwnedActiveSession(actor.userId, sessionId)) return notFound();
    return {
      status: 200,
      body: projectUserMetrics(await this.options.ownedMetricQuery.queryOwnedMetrics(actor.userId, sessionId, query)),
    };
  }

  async streamMetrics(
    req: ConsoleRequest,
    sessionId: string,
    query: MetricQuery,
    init: unknown,
  ): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    if (!await this.isOwnedActiveSession(actor.userId, sessionId)) return notFound();
    return {
      status: 200,
      stream: {
        init,
        events: streamTelemetryEvents(this.options.ownedMetricQuery.streamOwnedMetrics(actor.userId, sessionId, query)),
        revalidate: () => this.isOwnedActiveSession(actor.userId, sessionId),
      },
    };
  }

  private async isOwnedActiveSession(userId: string, sessionId: string): Promise<boolean> {
    const session = await this.options.runtimeStore.findPresence(sessionId, this.now());
    return session?.userId === userId;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

async function* streamActivityEvents(activity: AsyncIterable<unknown>): AsyncIterable<ConsoleSseEvent> {
  yield* streamTelemetryEvents(activity);
}

async function* streamTelemetryEvents(items: AsyncIterable<unknown>): AsyncIterable<ConsoleSseEvent> {
  for await (const item of items) {
    yield {
      event: 'update',
      data: item,
    };
  }
  yield {
    event: 'end',
    data: {
      status: 'complete',
    },
  };
}

function notFound(): ConsoleHandlerResult {
  return {
    status: 404,
    body: {
      type: 'about:blank',
      title: 'Not found',
      status: 404,
      code: 'not_found',
      detail: 'Runtime session was not found.',
    },
  };
}
