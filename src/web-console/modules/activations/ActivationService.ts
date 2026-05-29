import type { IRuntimeSessionControlStore } from '../../services/runtime/IRuntimeSessionControlStore.js';
import {
  canonicalizePortfolioElementName,
  type ConsolePortfolioElementDetailRecord,
  type IPortfolioElementStore,
} from '../../stores/IPortfolioElementStore.js';
import type { ConsoleHandlerResult, ConsoleRequest } from '../../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type {
  SessionActivationDto,
  SessionActivationListDto,
  SessionDeactivationDto,
} from './ActivationDtos.js';
import type { ISessionActivationEventSink } from './ActivationEvents.js';
import type { ISessionActivationStateAdapter, SessionActivationRecord } from './SessionActivationStateAdapter.js';
import { isConsoleActivatableElementType } from './ActivationTypes.js';
import type { ConsoleActivatableElementType } from './ActivationTypes.js';

export class ActivationService {
  constructor(private readonly options: {
    readonly runtimeStore: IRuntimeSessionControlStore;
    readonly portfolioStore: IPortfolioElementStore;
    readonly activationState: ISessionActivationStateAdapter;
    readonly eventSink?: ISessionActivationEventSink | null;
    readonly now?: () => Date;
  }) {}

  async list(req: ConsoleRequest, sessionId: string): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    if (!await this.isOwnedActiveSession(actor.userId, sessionId)) return notFound();
    const records = await this.options.activationState.list(sessionId);
    const body: SessionActivationListDto = {
      activations: records.map(record => toActivationDto(record, null)),
    };
    return { status: 200, body };
  }

  async activate(req: ConsoleRequest, sessionId: string): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    if (!await this.isOwnedActiveSession(actor.userId, sessionId)) return notFound();
    const parsed = parseActivationBody(req.body);
    if (parsed.kind === 'invalid') return validationProblem(parsed.detail);
    const element = await this.options.portfolioStore.findByName(
      actor.userId,
      parsed.type,
      canonicalizePortfolioElementName(parsed.name),
    );
    if (!element) return notFound('Portfolio element was not found.');
    if (!isConsoleActivatableElementType(element.type)) return validationProblem('type must be a stateful activatable element type.');
    const result = await this.options.activationState.activate(sessionId, element.type, element.canonicalName);
    if (result.changed) await this.recordEvent(actor.userId, sessionId, result.record.type, result.record.name, 'activated');
    return { status: 200, body: toActivationDto(result.record, element) };
  }

  async deactivate(
    req: ConsoleRequest,
    sessionId: string,
    type: string,
    name: string,
  ): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    if (!await this.isOwnedActiveSession(actor.userId, sessionId)) return notFound();
    if (!isConsoleActivatableElementType(type)) return validationProblem('type must be a stateful activatable element type.');
    const canonicalName = canonicalizePortfolioElementName(name);
    if (!canonicalName) return validationProblem('name must have a canonical form.');
    const changed = await this.options.activationState.deactivate(sessionId, type, canonicalName);
    if (changed) await this.recordEvent(actor.userId, sessionId, type, canonicalName, 'deactivated');
    const body: SessionDeactivationDto = {
      deactivated: true,
      type,
      name: canonicalName,
      deactivated_at: this.now().toISOString(),
    };
    return { status: 200, body };
  }

  private async isOwnedActiveSession(userId: string, sessionId: string): Promise<boolean> {
    const session = await this.options.runtimeStore.findPresence(sessionId, this.now());
    return session?.userId === userId;
  }

  private async recordEvent(
    userId: string,
    sessionId: string,
    elementType: ConsoleActivatableElementType,
    elementName: string,
    action: 'activated' | 'deactivated',
  ): Promise<void> {
    await this.options.eventSink?.recordActivationChanged({
      type: 'console.session.activation.changed.v1',
      userId,
      sessionId,
      elementType,
      elementName,
      action,
      occurredAt: this.now(),
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

type ParsedActivationBody =
  | { readonly kind: 'valid'; readonly type: ConsoleActivatableElementType; readonly name: string }
  | { readonly kind: 'invalid'; readonly detail: string };

function parseActivationBody(body: unknown): ParsedActivationBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'invalid', detail: 'Request body must be a JSON object.' };
  }
  const record = body as Record<string, unknown>;
  if (typeof record.type !== 'string' || !isConsoleActivatableElementType(record.type)) {
    return { kind: 'invalid', detail: 'type must be a stateful activatable element type.' };
  }
  if (typeof record.name !== 'string' || !canonicalizePortfolioElementName(record.name)) {
    return { kind: 'invalid', detail: 'name must have a canonical form.' };
  }
  return { kind: 'valid', type: record.type, name: record.name };
}

function toActivationDto(
  record: SessionActivationRecord,
  element: ConsolePortfolioElementDetailRecord | null,
): SessionActivationDto {
  return {
    type: record.type,
    name: record.name,
    display_name: element?.displayName ?? null,
    activated_at: record.activatedAt.toISOString(),
  };
}

function notFound(detail = 'Runtime session was not found.'): ConsoleHandlerResult {
  return {
    status: 404,
    body: {
      type: 'about:blank',
      title: 'Not found',
      status: 404,
      code: 'not_found',
      detail,
    },
  };
}

function validationProblem(detail: string): ConsoleHandlerResult {
  return {
    status: 422,
    body: {
      type: 'about:blank',
      title: 'Validation failed',
      status: 422,
      code: 'validation_failed',
      detail,
    },
  };
}
