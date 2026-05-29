import type { CliApprovalRecord } from '../../../handlers/mcp-aql/GatekeeperTypes.js';
import type { ConsoleHandlerResult, ConsoleRequest } from '../../platform/ConsolePlatformTypes.js';
import { requireConsoleAuthentication } from '../../middleware/ConsoleAuthentication.js';
import type { IRuntimeSessionControlStore } from '../../services/runtime/IRuntimeSessionControlStore.js';
import type { ConsoleApprovalScope, ConsoleApprovalStatus, SessionApprovalDto, SessionApprovalListDto } from './ApprovalDtos.js';
import type { ISessionApprovalEventSink } from './ApprovalEvents.js';
import type { SessionApprovalStore } from './ApprovalStore.js';
import { toCliApprovalScope } from './ApprovalStore.js';

const DEFAULT_APPROVAL_TTL_MS = 300_000;

export class ApprovalService {
  constructor(private readonly options: {
    readonly runtimeStore: IRuntimeSessionControlStore;
    readonly approvalStore: SessionApprovalStore;
    readonly eventSink?: ISessionApprovalEventSink | null;
    readonly now?: () => Date;
  }) {}

  async list(req: ConsoleRequest, sessionId: string): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    if (!await this.isOwnedActiveSession(actor.userId, sessionId)) return notFound();
    const records = await this.options.approvalStore.list(actor.userId, sessionId);
    const body: SessionApprovalListDto = {
      approvals: records.map(record => this.toDto(sessionId, record)),
    };
    return { status: 200, body };
  }

  async decide(
    req: ConsoleRequest,
    sessionId: string,
    approvalId: string,
    decision: 'approved' | 'denied',
  ): Promise<ConsoleHandlerResult> {
    const actor = requireConsoleAuthentication(req);
    if (!await this.isOwnedActiveSession(actor.userId, sessionId)) return notFound();
    if (!isApprovalId(approvalId)) return validationProblem('approval_id path parameter is invalid.');
    const parsed = parseDecisionBody(req.body);
    if (parsed.kind === 'invalid') return validationProblem(parsed.detail);

    const record = await this.options.approvalStore.find(actor.userId, sessionId, approvalId);
    if (!record) return notFound('Approval was not found.');
    const currentStatus = this.statusOf(record);
    if (currentStatus !== 'pending') {
      return { status: 200, body: this.toDto(sessionId, record) };
    }

    const decidedAt = this.now().toISOString();
    const updated: CliApprovalRecord = decision === 'approved'
      ? {
        ...record,
        approvedAt: decidedAt,
        scope: toCliApprovalScope(parsed.scope),
      }
      : {
        ...record,
        deniedAt: decidedAt,
      };
    await this.options.approvalStore.save(actor.userId, sessionId, approvalId, updated);
    await this.recordEvent(actor.userId, sessionId, approvalId, decision, parsed.scope);
    return { status: 200, body: this.toDto(sessionId, updated) };
  }

  private async isOwnedActiveSession(userId: string, sessionId: string): Promise<boolean> {
    const session = await this.options.runtimeStore.findPresence(sessionId, this.now());
    return session?.userId === userId;
  }

  private statusOf(record: CliApprovalRecord): ConsoleApprovalStatus {
    if (record.cancelledAt) return 'cancelled_session_terminated';
    if (record.deniedAt) return 'denied';
    if (record.approvedAt) return 'approved';
    if (record.expiredAt) return 'expired';
    if (this.expiresAt(record).getTime() <= this.now().getTime()) return 'expired';
    return 'pending';
  }

  private toDto(sessionId: string, record: CliApprovalRecord): SessionApprovalDto {
    const status = this.statusOf(record);
    return {
      approval_id: record.requestId,
      session_id: sessionId,
      status,
      tool_name: record.toolName,
      tool_input_digest: record.toolInputDigest,
      tool_input_detail: record.toolInputDetail ?? null,
      risk_level: record.riskLevel,
      risk_score: record.riskScore,
      irreversible: record.irreversible,
      reason: record.denyReason,
      policy_source: record.policySource ?? null,
      scope: record.scope === 'tool_session' ? 'session' : 'once',
      requested_at: record.requestedAt,
      expires_at: this.expiresAt(record).toISOString(),
      decided_at: record.approvedAt ?? record.deniedAt ?? record.expiredAt ?? record.cancelledAt ?? null,
    };
  }

  private expiresAt(record: CliApprovalRecord): Date {
    return new Date(new Date(record.requestedAt).getTime() + (record.ttlMs ?? DEFAULT_APPROVAL_TTL_MS));
  }

  private async recordEvent(
    userId: string,
    sessionId: string,
    approvalId: string,
    decision: 'approved' | 'denied',
    scope: ConsoleApprovalScope,
  ): Promise<void> {
    await this.options.eventSink?.recordApprovalDecision({
      type: 'console.session.approval.decided.v1',
      userId,
      sessionId,
      approvalId,
      decision,
      scope,
      occurredAt: this.now(),
    });
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

type ParsedDecisionBody =
  | { readonly kind: 'valid'; readonly scope: ConsoleApprovalScope }
  | { readonly kind: 'invalid'; readonly detail: string };

function parseDecisionBody(body: unknown): ParsedDecisionBody {
  if (body === undefined || body === null) return { kind: 'valid', scope: 'once' };
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'invalid', detail: 'Request body must be a JSON object when provided.' };
  }
  const scope = (body as Record<string, unknown>).scope;
  if (scope === undefined) return { kind: 'valid', scope: 'once' };
  if (scope !== 'once' && scope !== 'session') {
    return { kind: 'invalid', detail: 'scope must be "once" or "session".' };
  }
  return { kind: 'valid', scope };
}

function isApprovalId(value: string): boolean {
  return /^cli-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
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
