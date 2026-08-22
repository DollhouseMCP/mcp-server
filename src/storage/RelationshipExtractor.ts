/**
 * Relationship Extractor
 *
 * Parses element frontmatter for relationship-bearing fields and persists
 * to element_relationships and ensemble_members tables. DatabaseStorageLayer
 * invokes replacement inside the element transaction so graph rows cannot lag
 * or be reordered behind a newer element revision.
 *
 * Supported relationships:
 * - Agents: activates.personas[], activates.skills[], etc. → element_relationships
 * - Templates: references[], requires[] → element_relationships
 * - Ensembles: members[] → ensemble_members (richer schema: role, priority, etc.)
 *
 * @since v2.2.0 — Phase 4, Step 4.3
 */

import { eq, and } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import type { DatabaseInstance } from '../database/connection.js';
import { withUserContext } from '../database/rls.js';
import type { UserIdResolver } from '../database/UserContext.js';
import type { DrizzleTx } from '../database/db-utils.js';
import { elementRelationships } from '../database/schema/elements.js';
import { ensembleMembers } from '../database/schema/ensembles.js';

/**
 * Placeholder target type written for template `{{references}}` whose
 * referenced element type cannot be determined from the current context.
 * Treated as a sentinel; downstream joins must handle it explicitly.
 */
export const UNRESOLVED_TARGET_TYPE = 'unknown';

// ── Types ───────────────────────────────────────────────────────────

interface ExtractedRelationship {
  targetName: string;
  targetType: string;
  relationship: string;
}

interface ExtractedEnsembleMember {
  memberName: string;
  memberType: string;
  role: string;
  priority: number;
  activation: string;
  condition?: string;
  purpose?: string;
  dependencies: string[];
}

// ── Implementation ──────────────────────────────────────────────────

export class RelationshipExtractor {
  private readonly db: DatabaseInstance;
  private readonly getCurrentUserId: UserIdResolver;

  constructor(db: DatabaseInstance, getCurrentUserId: UserIdResolver) {
    this.db = db;
    this.getCurrentUserId = getCurrentUserId;
  }

  /** Resolved per call from the active session context. */
  private get userId(): string {
    return this.getCurrentUserId();
  }

  /**
   * Extract and persist relationships from element frontmatter.
   * Runs in its own transaction — failure is logged, not thrown.
   * Call this AFTER the core element save transaction has committed.
   */
  async extractAndPersist(
    elementId: string,
    elementType: string,
    frontmatterData: Record<string, unknown>,
  ): Promise<void> {
    try {
      const relationships = this.extractRelationships(elementType, frontmatterData);
      const ensembleEntries = elementType === 'ensembles'
        ? this.extractEnsembleMembers(frontmatterData)
        : [];

      const userId = this.userId;
      await withUserContext(this.db, userId, tx =>
        this.replaceInTransaction(tx, userId, elementId, elementType, relationships, ensembleEntries));
    } catch (error) {
      // Soft integrity: log warning, do not throw.
      // The element is already saved — relationships are stale until next save.
      logger.warn('[RelationshipExtractor] Failed to extract relationships', {
        elementId,
        elementType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async replaceForElementInTransaction(
    tx: DrizzleTx,
    userId: string,
    elementId: string,
    elementType: string,
    frontmatterData: Record<string, unknown>,
  ): Promise<void> {
    await this.replaceInTransaction(
      tx,
      userId,
      elementId,
      elementType,
      this.extractRelationships(elementType, frontmatterData),
      elementType === 'ensembles' ? this.extractEnsembleMembers(frontmatterData) : [],
    );
  }

  private async replaceInTransaction(
    tx: DrizzleTx,
    userId: string,
    elementId: string,
    elementType: string,
    relationships: ExtractedRelationship[],
    ensembleEntries: ExtractedEnsembleMember[],
  ): Promise<void> {
    await tx.delete(elementRelationships).where(and(
      eq(elementRelationships.userId, userId),
      eq(elementRelationships.sourceId, elementId),
    ));
    if (relationships.length > 0) {
      await tx.insert(elementRelationships).values(relationships.map(relationship => ({
        sourceId: elementId,
        userId,
        ...relationship,
      })));
    }

    if (elementType !== 'ensembles') return;
    await tx.delete(ensembleMembers).where(and(
      eq(ensembleMembers.userId, userId),
      eq(ensembleMembers.ensembleId, elementId),
    ));
    if (ensembleEntries.length > 0) {
      await tx.insert(ensembleMembers).values(ensembleEntries.map(member => ({
        ensembleId: elementId,
        userId,
        memberName: member.memberName,
        memberType: member.memberType,
        role: member.role,
        priority: member.priority,
        activation: member.activation,
        condition: member.condition ?? null,
        purpose: member.purpose ?? null,
        dependencies: member.dependencies,
      })));
    }
  }

  // ── Private Extraction ────────────────────────────────────────────

  private extractRelationships(
    elementType: string,
    data: Record<string, unknown>,
  ): ExtractedRelationship[] {
    const relationships: ExtractedRelationship[] = [];

    if (elementType === 'agents') {
      this.extractAgentActivations(data, relationships);
    } else if (elementType === 'templates') {
      this.extractTemplateReferences(data, relationships);
    }

    return relationships;
  }

  private extractAgentActivations(
    data: Record<string, unknown>,
    out: ExtractedRelationship[],
  ): void {
    const activates = data.activates;
    if (!activates || typeof activates !== 'object' || Array.isArray(activates)) return;

    const activatesMap = activates as Record<string, unknown>;
    const typeMap: Record<string, string> = {
      personas: 'personas',
      skills: 'skills',
      memories: 'memories',
      templates: 'templates',
    };

    for (const [key, targetType] of Object.entries(typeMap)) {
      const names = activatesMap[key];
      if (!Array.isArray(names)) continue;
      for (const name of names) {
        if (typeof name === 'string' && name.trim()) {
          out.push({ targetName: name.trim(), targetType, relationship: 'activates' });
        }
      }
    }
  }

  private extractTemplateReferences(
    data: Record<string, unknown>,
    out: ExtractedRelationship[],
  ): void {
    const refs = data.references;
    if (Array.isArray(refs)) {
      for (const ref of refs) {
        if (typeof ref === 'string' && ref.trim()) {
          out.push({ targetName: ref.trim(), targetType: UNRESOLVED_TARGET_TYPE, relationship: 'references' });
        }
      }
    }

    const reqs = data.requires;
    if (Array.isArray(reqs)) {
      for (const req of reqs) {
        if (typeof req === 'string' && req.trim()) {
          out.push({ targetName: req.trim(), targetType: UNRESOLVED_TARGET_TYPE, relationship: 'requires' });
        }
      }
    }
  }

  private extractEnsembleMembers(
    data: Record<string, unknown>,
  ): ExtractedEnsembleMember[] {
    const members = data.members;
    if (!Array.isArray(members)) return [];

    return members.flatMap((member): ExtractedEnsembleMember[] => {
      if (!member || typeof member !== 'object') return [];
      const m = member as Record<string, unknown>;

      const memberName = typeof m.name === 'string' ? m.name.trim() : '';
      const memberType = typeof m.type === 'string' ? m.type.trim() : '';
      if (!memberName || !memberType) return [];

      return [{
        memberName,
        memberType,
        role: typeof m.role === 'string' ? m.role : 'core',
        priority: typeof m.priority === 'number' ? m.priority : 0,
        activation: typeof m.activation === 'string' ? m.activation : 'always',
        condition: typeof m.condition === 'string' ? m.condition : undefined,
        purpose: typeof m.purpose === 'string' ? m.purpose : undefined,
        dependencies: Array.isArray(m.dependencies)
          ? m.dependencies.filter((d): d is string => typeof d === 'string')
          : [],
      }];
    });
  }
}
