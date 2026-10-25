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
import type { BaseElementManager } from '../../elements/base/BaseElementManager.js';
import { ElementType } from '../../portfolio/PortfolioManager.js';
import { normalizeElementTypeLenient } from '../../utils/elementTypeNormalization.js';
import { logger } from '../../utils/logger.js';

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

export type PolicyIndexOptions = { freshAfterInFlight?: boolean };
export type IndexedPolicyManagers = Map<string, Promise<BaseElementManager<any> | undefined>>;
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
  personaManager: Pick<PersonaManager, 'getActivePersonas' | 'resolveActivePersonas'>;
  skillManager: Pick<SkillManager, 'getActiveSkills'>;
  agentManager: Pick<AgentManager, 'getActiveAgents' | 'getActivationIdentity'>;
  ensembleManager: Pick<EnsembleManager, 'getActiveEnsembles'>;
  getManagerForType: (type: string) => BaseElementManager<any> | undefined;
  ensureInitialized: () => Promise<void>;
}

export type ActivePolicyCollectorFactory = (deps: ActivePolicyCollectorDeps) => ActivePolicyCollector;

export const createActivePolicyCollector: ActivePolicyCollectorFactory = deps => new ActivePolicyCollector(deps);

/** Collect policies using the managers bound to one handler instance. */
export class ActivePolicyCollector {
  constructor(private readonly deps: ActivePolicyCollectorDeps) {}

  async collectActiveElementsForPolicy(
    indexOptions: PolicyIndexOptions = {},
  ): Promise<PolicyElement[]> {
    await this.deps.ensureInitialized();

    const result: PolicyElement[] = [];
    const seen = new Set<string>();
    const indexedManagers: IndexedPolicyManagers = new Map();
    const requiresFreshIndex = indexOptions.freshAfterInFlight === true;

    if (requiresFreshIndex) {
      await Promise.all([
        this.getIndexedPolicyManager(ElementType.PERSONA, indexedManagers, indexOptions),
        this.getIndexedPolicyManager(ElementType.SKILL, indexedManagers, indexOptions),
        this.getIndexedPolicyManager(ElementType.ENSEMBLE, indexedManagers, indexOptions),
      ]);
    }

    await this.appendActivePersonas(result, seen, requiresFreshIndex);
    await this.appendActiveSkills(result, seen);
    await this.appendActiveAgents(result, seen, indexOptions);
    await this.appendActiveEnsembles(result, seen, indexOptions, indexedManagers);

    return result;
  }

  private async appendActivePersonas(
    result: PolicyElement[],
    seen: Set<string>,
    resolveFromStorage: boolean,
  ): Promise<void> {
    try {
      const personas = resolveFromStorage
        ? await this.deps.personaManager.resolveActivePersonas()
        : this.deps.personaManager.getActivePersonas();
      for (const persona of personas) {
        const storageIdentity = normalizeLookupValue(persona.filename) || undefined;
        seen.add(policyElementKey('persona', persona.metadata.name, storageIdentity));
        result.push({
          type: 'persona',
          name: persona.metadata.name,
          metadata: persona.metadata as unknown as Record<string, unknown>,
          ...(storageIdentity ? { storageIdentity } : {}),
        });
      }
    } catch (error) {
      logger.warn('Failed to gather active personas for policy evaluation', { error });
    }
  }

  private async appendActiveSkills(result: PolicyElement[], seen: Set<string>): Promise<void> {
    try {
      for (const skill of await this.deps.skillManager.getActiveSkills()) {
        seen.add(policyElementKey('skill', skill.metadata.name));
        result.push({
          type: 'skill',
          name: skill.metadata.name,
          metadata: skill.metadata as unknown as Record<string, unknown>,
        });
      }
    } catch (error) {
      logger.warn('Failed to gather active skills for policy evaluation', { error });
    }
  }

  private async appendActiveAgents(
    result: PolicyElement[],
    seen: Set<string>,
    indexOptions: PolicyIndexOptions,
  ): Promise<void> {
    try {
      for (const agent of await this.deps.agentManager.getActiveAgents(indexOptions)) {
        const storageIdentity = this.deps.agentManager.getActivationIdentity(agent)?.value;
        seen.add(policyElementKey('agent', agent.metadata.name, storageIdentity));
        result.push({
          type: 'agent',
          name: agent.metadata.name,
          metadata: agent.metadata as unknown as Record<string, unknown>,
          ...(storageIdentity ? { storageIdentity } : {}),
        });
      }
    } catch (error) {
      logger.warn('Failed to gather active agents for policy evaluation', { error });
    }
  }

  private async appendActiveEnsembles(
    result: PolicyElement[],
    seen: Set<string>,
    indexOptions: PolicyIndexOptions,
    indexedManagers: IndexedPolicyManagers,
  ): Promise<void> {
    try {
      const ensembles = await this.deps.ensembleManager.getActiveEnsembles();
      const candidates = this.appendEnsemblesAndCollectMembers(ensembles, result, seen);
      const resolvedMembers = await this.resolvePolicyMembers(candidates, indexOptions, indexedManagers);
      this.appendResolvedPolicyMembers(resolvedMembers, result, seen);
    } catch (error) {
      logger.warn('Failed to gather active ensembles for policy evaluation', { error });
    }
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

  private async resolvePolicyMembers(
    candidates: PolicyMemberCandidate[],
    indexOptions: PolicyIndexOptions,
    indexedManagers: IndexedPolicyManagers,
  ): Promise<Array<PolicyElement | undefined>> {
    const memberLookups = new Map<string, Promise<PolicyMemberElement | undefined>>();
    return mapPolicyLookups(candidates, async (candidate) => {
      try {
        const found = await this.findPolicyMember(
          candidate,
          indexedManagers,
          memberLookups,
          indexOptions,
        );
        if (found?.metadata?.['gatekeeper']) {
          return {
            type: toPolicyElementType(candidate.type),
            name: candidate.name,
            metadata: found.metadata,
          };
        }
      } catch {
        // A malformed or missing member must not break evaluation of others.
      }
      return undefined;
    });
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
      .then(async (manager) => manager
        ? manager.findByName(candidate.name) as Promise<PolicyMemberElement | undefined>
        : undefined);
    memberLookups.set(candidate.key, lookup);
    return lookup;
  }

  /** The handler's policy report merge also calls this index resolver directly. */
  getIndexedPolicyManager(
    type: string,
    indexedManagers: IndexedPolicyManagers,
    indexOptions: PolicyIndexOptions,
  ): Promise<BaseElementManager<any> | undefined> {
    const normalizedType = normalizeElementTypeLenient(type);
    const existing = indexedManagers.get(normalizedType);
    if (existing) return existing;

    const manager = this.deps.getManagerForType(normalizedType);
    const indexed = manager
      ? manager.refreshIndex(indexOptions).then(() => manager)
      : Promise.resolve(undefined);
    indexedManagers.set(normalizedType, indexed);
    return indexed;
  }
}
