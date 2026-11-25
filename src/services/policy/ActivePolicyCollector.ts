/**
 * ActivePolicyCollector - Collects active elements and ensemble members for policy evaluation.
 *
 * Uses managers and callbacks bound to one handler instance. Snapshot coalescing,
 * session scoping, and operation lifetime checks remain with the caller.
 */

import type { PersonaManager } from '../../persona/PersonaManager.js';
import type { SkillManager } from '../../elements/skills/SkillManager.js';
import type { AgentManager } from '../../elements/agents/AgentManager.js';
import type { EnsembleManager } from '../../elements/ensembles/EnsembleManager.js';
import type { Ensemble } from '../../elements/ensembles/Ensemble.js';
import type { ActiveReferenceFreshness, BaseElementManager } from '../../elements/base/BaseElementManager.js';
import { ElementType } from '../../portfolio/PortfolioManager.js';
import { normalizeElementTypeLenient } from '../../utils/elementTypeNormalization.js';
import { PolicyUnavailableError } from './PolicyUnavailableError.js';
import { requireCompletePolicyReport, type PolicyReport, type PolicyReadFailure } from './PolicyReport.js';
import { visitSequentially } from '../../utils/visitSequentially.js';
import { clientReadFailureReason } from '../../elements/base/ElementReadError.js';

export type PolicyElement = {
  type: string;
  name: string;
  metadata: Record<string, unknown>;
  storageIdentity?: string;
};

export type PolicyMemberElement = {
  metadata?: Record<string, unknown>;
  filePath?: string;
  filename?: string;
};

/** Index freshness for one policy read; an advisory read (the coalesced digest) may refresh more cheaply. */
export type PolicyIndexOptions = { freshAfterInFlight?: boolean; freshness?: ActiveReferenceFreshness };
export type IndexedPolicyManagers = Map<string, Promise<BaseElementManager<any>>>;
type PolicyMemberCandidate = { type: string; name: string; key: string };

const ACTIVE_POLICY_LOOKUP_CONCURRENCY = 8;

export async function mapPolicyLookups<TInput, TOutput>(
  candidates: readonly TInput[],
  lookup: (candidate: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const resolved = new Array<TOutput>(candidates.length);
  let nextCandidateIndex = 0;

  const resolveNext = async (): Promise<void> => {
    if (nextCandidateIndex >= candidates.length) return;
    const candidateIndex = nextCandidateIndex++;
    resolved[candidateIndex] = await lookup(candidates[candidateIndex], candidateIndex);
    await resolveNext();
  };

  const workerCount = Math.min(ACTIVE_POLICY_LOOKUP_CONCURRENCY, candidates.length);
  await Promise.all(Array.from({ length: workerCount }, () => resolveNext()));
  return resolved;
}

export function normalizeLookupValue(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFC').trim()
    : '';
}

export function toPolicyElementType(type: string): string {
  const normalizedType = normalizeLookupValue(type).toLowerCase();
  switch (normalizedType) {
    case 'personas':
      return 'persona';
    case 'skills':
      return 'skill';
    case 'templates':
      return 'template';
    case 'agents':
      return 'agent';
    case 'memories':
      return 'memory';
    case 'ensembles':
      return 'ensemble';
    default:
      return normalizedType;
  }
}

export function policyElementKey(type: string, name: string, storageIdentity?: string): string {
  const normalizedType = toPolicyElementType(normalizeElementTypeLenient(type));
  const identity = normalizeLookupValue(storageIdentity);
  return identity
    ? `${normalizedType}:identity:${identity}`
    : `${normalizedType}:name:${normalizeLookupValue(name)}`;
}

export interface ActivePolicyCollectorDeps {
  personaManager: Pick<PersonaManager, 'getActivePersonas' | 'resolveActivePersonas' | 'getActiveReferenceReport'>;
  skillManager: Pick<SkillManager, 'getActiveSkills' | 'getActiveReferenceReport'>;
  agentManager: Pick<AgentManager, 'getActiveAgents' | 'getActivationIdentity' | 'getActiveReferenceReport'>;
  ensembleManager: Pick<EnsembleManager, 'getActiveEnsembles' | 'getActiveReferenceReport'>;
  getManagerForType: (type: string) => BaseElementManager<any> | undefined;
  ensureInitialized: () => Promise<void>;
}

export type ActivePolicyCollectorFactory = (deps: ActivePolicyCollectorDeps) => ActivePolicyCollector;

export const createActivePolicyCollector: ActivePolicyCollectorFactory = deps => new ActivePolicyCollector(deps);

/** Collect policies using the managers bound to one handler instance. */
export class ActivePolicyCollector {
  constructor(private readonly deps: ActivePolicyCollectorDeps) {}

  async collectActiveElementsForReport(indexOptions: PolicyIndexOptions = {}): Promise<PolicyReport<PolicyElement>> {
    const items: PolicyElement[] = [];
    const failures: PolicyReadFailure[] = [];
    try {
      await this.deps.ensureInitialized();
    } catch (cause) {
      return { items, failures: [{ type: 'collection', reason: this.failureReason(cause) }], complete: false };
    }
    const types = [ElementType.PERSONA, ElementType.SKILL, ElementType.AGENT, ElementType.ENSEMBLE];
    const seen = new Set<string>();
    const indexedManagers: IndexedPolicyManagers = new Map();
    let complete = true;
    await visitSequentially(types.values(), async type => {
      try {
        if (type === ElementType.ENSEMBLE) {
          const report = await this.collectEnsemblePolicies(indexOptions, indexedManagers, seen);
          this.appendResolvedPolicyMembers(report.items, items, seen);
          failures.push(...report.failures);
          complete &&= report.complete;
          return;
        }
        const manager = this.activeManager(type);
        if (!manager) throw new PolicyUnavailableError('Policy manager is unavailable');
        const report = await manager.getActiveReferenceReport({ scanOptions: indexOptions, freshness: indexOptions.freshness });
        complete &&= report.complete;
        failures.push(...report.failures.map(failure => ({ type, reference: failure.reference, reason: failure.error.message })));
        for (const element of report.items) {
          let storageIdentity: string | undefined;
          if (type === ElementType.PERSONA) storageIdentity = element.filename;
          if (type === ElementType.AGENT) storageIdentity = this.deps.agentManager.getActivationIdentity(element)?.value;
          items.push({ type: toPolicyElementType(type), name: element.metadata.name, metadata: element.metadata, storageIdentity });
          seen.add(policyElementKey(type, element.metadata.name, storageIdentity));
        }
      } catch (cause) {
        complete = false;
        failures.push({ type, reason: this.failureReason(cause) });
      }
    });
    return { items, failures, complete };
  }

  private failureReason(cause: unknown): string { return clientReadFailureReason(cause); }

  private async collectEnsemblePolicies(indexOptions: PolicyIndexOptions, indexedManagers: IndexedPolicyManagers,
    seen: Set<string>): Promise<PolicyReport<PolicyElement>> {
    const staged = new Map<Ensemble, PolicyReport<PolicyElement>>();
    const memberLookups = new Map<string, Promise<PolicyMemberElement | undefined>>();
    const active = await this.deps.ensembleManager.getActiveReferenceReport({ scanOptions: indexOptions, freshness: indexOptions.freshness,
      afterLookup: async (ensemble, reference) => {
        const items: PolicyElement[] = [];
        const failures: PolicyReadFailure[] = [];
        let complete = true;
        const localSeen = new Set(seen);
        // Definition members are bounded to this visit; activation membership stays live across awaits.
        const candidates = this.appendEnsemblesAndCollectMembers([ensemble], items, localSeen);
        const members = await mapPolicyLookups(candidates, async candidate => {
          try {
            const member = await this.findPolicyMember(candidate, indexedManagers, memberLookups, indexOptions);
            // A member the index certifies absent contributes no policy; that is not a failure.
            if (!member) return undefined;
            return member.metadata?.['gatekeeper']
              ? { type: toPolicyElementType(candidate.type), name: candidate.name, metadata: member.metadata } : undefined;
          } catch (cause) {
            complete = false;
            failures.push({ type: ElementType.ENSEMBLE, reference,
              reason: `Member ${JSON.stringify(candidate.name)}: ${this.failureReason(cause)}` });
            return undefined;
          }
        });
        this.appendResolvedPolicyMembers(members, items, localSeen);
        staged.set(ensemble, { items, failures, complete });
      },
    });
    const items: PolicyElement[] = [];
    const failures: PolicyReadFailure[] = active.failures.map(failure => ({ type: ElementType.ENSEMBLE,
      reference: failure.reference, reason: failure.error.message }));
    const memberItems: PolicyElement[] = [];
    let complete = active.complete;
    for (const ensemble of active.items) {
      const report = staged.get(ensemble);
      if (!report) throw new PolicyUnavailableError('Ensemble member report is unavailable');
      complete &&= report.complete;
      const [parent, ...members] = report.items;
      items.push(parent);
      memberItems.push(...members);
      failures.push(...report.failures);
    }
    items.push(...memberItems);
    return { items, failures, complete };
  }

  private activeManager(type: ElementType): Pick<BaseElementManager<any>, 'getActiveReferenceReport'> | undefined {
    switch (type) {
      case ElementType.PERSONA: return this.deps.personaManager;
      case ElementType.SKILL: return this.deps.skillManager;
      case ElementType.AGENT: return this.deps.agentManager;
      case ElementType.ENSEMBLE: return this.deps.ensembleManager;
      default: return undefined;
    }
  }

  async collectActiveElementsForPolicy(indexOptions: PolicyIndexOptions = {}): Promise<PolicyElement[]> {
    return requireCompletePolicyReport(await this.collectActiveElementsForReport(indexOptions));
  }

  private appendEnsemblesAndCollectMembers(
    ensembles: Awaited<ReturnType<EnsembleManager['getActiveEnsembles']>>,
    result: PolicyElement[],
    seen: Set<string>,
  ): PolicyMemberCandidate[] {
    const candidates: PolicyMemberCandidate[] = [];
    const queuedMemberKeys = new Set<string>();

    for (const ensemble of ensembles) {
      seen.add(policyElementKey('ensemble', ensemble.metadata.name));
      result.push({
        type: 'ensemble',
        name: ensemble.metadata.name,
        metadata: ensemble.metadata as unknown as Record<string, unknown>,
      });

      const members = (ensemble.metadata as unknown as Record<string, unknown>)?.elements as
        Array<{ element_name: string; element_type: string }> | undefined;
      if (!Array.isArray(members)) continue;

      for (const member of members) {
        const normalizedType = normalizeElementTypeLenient(member.element_type);
        const normalizedName = normalizeLookupValue(member.element_name);
        if (normalizedType === '' || normalizedName === '') continue;

        const key = policyElementKey(normalizedType, normalizedName);
        if (seen.has(key) || queuedMemberKeys.has(key)) continue;
        queuedMemberKeys.add(key);
        candidates.push({ type: normalizedType, name: normalizedName, key });
      }
    }
    return candidates;
  }

  private appendResolvedPolicyMembers(
    resolvedMembers: Array<PolicyElement | undefined>,
    result: PolicyElement[],
    seen: Set<string>,
  ): void {
    for (const resolved of resolvedMembers) {
      if (!resolved) continue;
      const key = policyElementKey(resolved.type, resolved.name);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(resolved);
    }
  }

  private findPolicyMember(
    candidate: PolicyMemberCandidate,
    indexedManagers: IndexedPolicyManagers,
    memberLookups: Map<string, Promise<PolicyMemberElement | undefined>>,
    indexOptions: PolicyIndexOptions,
  ): Promise<PolicyMemberElement | undefined> {
    const existing = memberLookups.get(candidate.key);
    if (existing) return existing;

    const lookup = this.getIndexedPolicyManager(candidate.type, indexedManagers, indexOptions)
      // The member's manager was refreshed for this report just before the lookup.
      .then(manager => manager.findByName(candidate.name, { refreshed: true }) as Promise<PolicyMemberElement | undefined>);
    memberLookups.set(candidate.key, lookup);
    return lookup;
  }

  /** The handler's policy report merge also calls this index resolver directly. */
  getIndexedPolicyManager(
    type: string,
    indexedManagers: IndexedPolicyManagers,
    indexOptions: PolicyIndexOptions,
  ): Promise<BaseElementManager<any>> {
    const normalizedType = normalizeElementTypeLenient(type);
    const existing = indexedManagers.get(normalizedType);
    if (existing) return existing;

    const indexed = Promise.resolve().then(async () => {
      const manager = this.managerFor(normalizedType);
      await manager.refreshForFreshness(indexOptions.freshness, indexOptions);
      return manager;
    });
    indexedManagers.set(normalizedType, indexed);
    return indexed;
  }

  /**
   * The throwing manager lookup (as ElementManagerLookup): a member of an unknown element type is a
   * typed failure that leaves the report incomplete, never an absent member.
   */
  private managerFor(type: string): BaseElementManager<any> {
    const manager = this.deps.getManagerForType(type);
    if (!manager) throw new PolicyUnavailableError(`No element manager is registered for type ${JSON.stringify(type)}`);
    return manager;
  }
}
