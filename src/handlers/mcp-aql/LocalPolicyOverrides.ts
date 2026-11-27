import { createHmac, randomUUID } from 'node:crypto';
import type { SessionContext } from '../../context/SessionContext.js';
import type { AuditSink } from '../../security/auditSink.js';
import { canonicalJSON, formatToolInputForReview, type AuditHmacResolver } from '../../security/toolRedaction.js';
import type { RateLimiter } from '../../utils/RateLimiter.js';
import { PermissionLevel } from './GatekeeperTypes.js';
import type { OperationRegistry } from './OperationRegistry.js';
import { findConfirmDenyingElement, getGatekeeperDiagnostics, resolveElementPolicy, type ActiveElement } from './policies/ElementPolicies.js';
import { getDefaultPermissionLevel } from './policies/OperationPolicies.js';
import { ElementType, normalizeMCPAQLElementType } from './types.js';

const OVERRIDE_TTL_MS = 60_000;
const DECLINE_COOLDOWN_MS = 30_000;
const MAX_TRACKED_BINDINGS = 50;
const REVIEW_LIMIT = 8_192;

// These routes operate on a local portfolio query, with no mutable named target.
// Other operations need an explicit eligibility review before being added here.
const LOCAL_QUERY_OPERATIONS = new Set(['list_elements', 'search_elements', 'query_elements']);
const DISCRETIONARY_POLICY_SOURCES = new Set(['persona', 'skill', 'ensemble']);
const LOCAL_ELEMENT_TYPES = new Set<string>(Object.values(ElementType));

type OverrideActor = Pick<SessionContext, 'userId' | 'sessionId' | 'tenantId' | 'createdAt'>;
type ActorContext = Pick<SessionContext, 'sessionId'> & Partial<SessionContext>;

export function localOverrideActor(context?: ActorContext): OverrideActor | undefined {
  if (context?.transport !== 'stdio' || !context.userId || !context.sessionId ||
      context.tenantId !== null || typeof context.createdAt !== 'number') return undefined;
  const { userId, sessionId, tenantId, createdAt } = context;
  return { userId, sessionId, tenantId, createdAt };
}

export interface OverrideAction {
  readonly operation: string;
  readonly elementType?: string;
  readonly portfolio: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface OverrideRule {
  readonly element: string;
  readonly elementKind: string;
  readonly policies: unknown;
}

export function isLocalOverrideOperation(operation: string): boolean {
  return LOCAL_QUERY_OPERATIONS.has(operation);
}

function hasReviewableQuery(action: OverrideAction): boolean {
  const { elementType, operation, params } = action;
  if (!elementType || !LOCAL_ELEMENT_TYPES.has(elementType) || Array.isArray(params)) return false;
  if (operation === 'search_elements' &&
      (typeof params.query !== 'string' || !params.query.trim() || params.query.trim().length > 1_000)) return false;
  return Object.entries(params).every(([name, value]) => {
    switch (name) {
      case 'element_type':
        return typeof value === 'string' && normalizeMCPAQLElementType(value) === elementType;
      case 'page':
        return operation !== 'query_elements' && typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
      case 'pageSize':
        return operation !== 'query_elements' && typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100;
      case 'nameContains':
        return operation === 'list_elements' && typeof value === 'string';
      case 'query':
        return operation === 'search_elements';
      default:
        return false;
    }
  });
}

/** Resolve only a single explicit denial, with every remaining policy still enforced. */
export function resolveOverrideRule(
  action: OverrideAction,
  elements: ActiveElement[],
  operations: OperationRegistry,
): OverrideRule | undefined {
  if (!isLocalOverrideOperation(action.operation) || !hasReviewableQuery(action) ||
      operations.getRoute(action.operation)?.endpoint !== 'READ' ||
      getDefaultPermissionLevel(action.operation, operations) !== PermissionLevel.AUTO_APPROVE ||
      findConfirmDenyingElement(elements) ||
      elements.some(element => getGatekeeperDiagnostics(element.metadata))) return undefined;

  const denying = elements.filter(element => element.metadata.gatekeeper?.deny?.includes(action.operation));
  const source = denying[0];
  // Executing agents can have synthesized denies from their tools allowlist.
  if (denying.length !== 1 || !DISCRETIONARY_POLICY_SOURCES.has(source.type)) return undefined;
  const remaining = elements.map(element => element === source ? withoutDeny(element, action.operation) : element);
  if (resolveElementPolicy(action.operation, remaining, action.elementType, operations).permissionLevel !== PermissionLevel.AUTO_APPROVE) {
    return undefined;
  }
  return {
    element: source.name,
    elementKind: source.type,
    policies: elements.map(element => [element.type, element.name, element.executionIdentity, element.metadata.gatekeeper]),
  };
}

function withoutDeny(element: ActiveElement, operation: string): ActiveElement {
  const gatekeeper = element.metadata.gatekeeper!;
  return {
    ...element,
    metadata: { ...element.metadata, gatekeeper: { ...gatekeeper, deny: gatekeeper.deny?.filter(name => name !== operation) } },
  };
}

interface Binding {
  readonly digest: string;
  readonly parameterDigest: string;
  readonly policyRevision: string;
  readonly rule: { readonly element: string; readonly elementKind: string };
}

export interface LocalOverrideReview {
  readonly id: string;
  readonly actor: OverrideActor;
  readonly action: OverrideAction;
  readonly binding: Binding;
  readonly reviewDetails: string;
  readonly expiresAt: number;
}

interface RecordState {
  readonly review: LocalOverrideReview;
  phase: 'issuing' | 'pending' | 'reviewing' | 'approved' | 'consuming';
  expiresAt: number;
}

type DenialOutcome = { status: 'consumed' } | { status: 'pending'; requestId: string } | { status: 'unavailable' };

/** Pending reviews and grants are owned by this local server process. */
export class LocalPolicyOverrides {
  private readonly records = new Map<string, RecordState>();
  private readonly declinedBindings = new Map<string, { sessionId: string; expiresAt: number }>();

  constructor(private readonly hmac: AuditHmacResolver, private readonly audit: AuditSink) {}

  async handleDenial(
    actor: OverrideActor, action: OverrideAction, rule: OverrideRule, limiter: RateLimiter,
    currentRule: (action: OverrideAction) => Promise<OverrideRule | undefined>,
  ): Promise<DenialOutcome> {
    const reviewDetails = formatToolInputForReview('MCP-AQL', { ...action }, REVIEW_LIMIT);
    if (reviewDetails === undefined) return { status: 'unavailable' };
    const binding = await this.bind(actor, action, rule);
    if (!binding) return { status: 'unavailable' };

    this.prune();
    if (this.declinedBindings.has(binding.digest)) return { status: 'unavailable' };
    const existing = [...this.records.values()].find(record => record.review.binding.digest === binding.digest);
    if (existing?.phase === 'approved') {
      return this.consume(existing, currentRule);
    }
    if (existing) {
      return existing.phase === 'pending' || existing.phase === 'reviewing'
        ? { status: 'pending', requestId: existing.review.id } : { status: 'unavailable' };
    }
    if (this.records.size + this.declinedBindings.size >= MAX_TRACKED_BINDINGS ||
        !limiter.checkLimit().allowed) return { status: 'unavailable' };
    limiter.consumeToken();
    const review = { id: randomUUID(), actor, action, binding, reviewDetails, expiresAt: Date.now() + OVERRIDE_TTL_MS };
    const record: RecordState = { review, phase: 'issuing', expiresAt: review.expiresAt };
    this.records.set(review.id, record);
    if (!await this.writeAudit('requested', review, 'pending') || this.records.get(review.id) !== record ||
        record.expiresAt <= Date.now()) {
      this.records.delete(review.id);
      return { status: 'unavailable' };
    }
    record.phase = 'pending';
    return { status: 'pending', requestId: review.id };
  }

  private async consume(
    record: RecordState, currentRule: (action: OverrideAction) => Promise<OverrideRule | undefined>,
  ): Promise<DenialOutcome> {
    record.phase = 'consuming'; // Reserve the only use before awaiting any I/O.
    const { review } = record;
    try {
      const authorized = await this.writeAudit('consumed', review, 'single_use') &&
        await this.isCurrent(review, currentRule) && this.records.get(review.id) === record &&
        record.expiresAt > Date.now();
      return { status: authorized ? 'consumed' : 'unavailable' };
    } finally {
      this.records.delete(review.id);
    }
  }

  beginReview(id: string, actor: OverrideActor): LocalOverrideReview | undefined {
    this.prune();
    const record = this.records.get(id);
    if (record?.phase !== 'pending' || canonicalJSON(record.review.actor) !== canonicalJSON(actor)) return undefined;
    record.phase = 'reviewing';
    return record.review;
  }

  async isCurrent(review: LocalOverrideReview, currentRule: (action: OverrideAction) => Promise<OverrideRule | undefined>): Promise<boolean> {
    try {
      const rule = await currentRule(review.action);
      return rule !== undefined && (await this.bind(review.actor, review.action, rule))?.digest === review.binding.digest;
    } catch {
      return false;
    }
  }

  async approve(review: LocalOverrideReview): Promise<boolean> {
    const record = this.records.get(review.id);
    if (record?.phase !== 'reviewing' || record.review !== review || record.expiresAt <= Date.now()) return false;
    if (!await this.writeAudit('decision', review, 'approved') ||
        this.records.get(review.id) !== record || record.expiresAt <= Date.now()) return false;
    record.phase = 'approved';
    record.expiresAt = Date.now() + OVERRIDE_TTL_MS;
    return true;
  }

  async refuse(review: LocalOverrideReview, reason: string): Promise<void> {
    const record = this.records.get(review.id);
    if (record?.phase !== 'reviewing' || record.review !== review) return;
    this.records.delete(review.id);
    if (reason === 'declined') {
      this.declinedBindings.set(review.binding.digest, {
        sessionId: review.actor.sessionId, expiresAt: Date.now() + DECLINE_COOLDOWN_MS,
      });
    }
    await this.writeAudit('decision', review, reason);
  }

  disposeSession(sessionId: string): void {
    for (const [id, record] of this.records) {
      if (record.review.actor.sessionId === sessionId) this.records.delete(id);
    }
    for (const [digest, declined] of this.declinedBindings) {
      if (declined.sessionId === sessionId) this.declinedBindings.delete(digest);
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(id);
    }
    for (const [digest, declined] of this.declinedBindings) {
      if (declined.expiresAt <= now) this.declinedBindings.delete(digest);
    }
  }

  private async bind(actor: OverrideActor, action: OverrideAction, rule: OverrideRule): Promise<Binding | undefined> {
    try {
      const { key, keyId } = await this.hmac.resolve();
      const hash = (domain: string, data: unknown) =>
        `${keyId}:${createHmac('sha256', key).update(canonicalJSON(['local-policy-override', domain, data])).digest('hex')}`;
      const parameterDigest = hash('parameters', action.params);
      const policyRevision = hash('policy', rule.policies);
      const ruleIdentity = { element: rule.element, elementKind: rule.elementKind };
      const digest = hash('binding', [actor, 'READ', action.operation, action.elementType, action.portfolio, parameterDigest, policyRevision, ruleIdentity]);
      return { digest, parameterDigest, policyRevision, rule: ruleIdentity };
    } catch {
      return undefined;
    }
  }

  private async writeAudit(phase: string, review: LocalOverrideReview, result: string): Promise<boolean> {
    try {
      await this.audit.write({
        eventType: `security.local_policy_override.${phase}`,
        actorId: review.actor.userId,
        targetId: review.id,
        metadata: {
          operation: review.action.operation,
          rule: review.binding.rule,
          policyRevision: review.binding.policyRevision,
          parameterDigest: review.binding.parameterDigest,
          sessionId: review.actor.sessionId,
          tenantId: review.actor.tenantId,
          result,
        },
      });
      return true;
    } catch {
      return false;
    }
  }
}
