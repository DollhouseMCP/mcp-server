import type { IndexEntry } from '../PortfolioIndexManager.js';
import type {
  ActionDefinition,
  ElementDefinition,
  EnhancedIndex,
  Relationship
} from '../types/IndexTypes.js';
import { RelationshipTypes } from '../types/RelationshipTypes.js';

/**
 * Builds normalized element definitions for the enhanced index.
 */
export class ElementDefinitionBuilder {
  public build(
    entry: IndexEntry,
    existingIndex: EnhancedIndex | null
  ): ElementDefinition {
    const entryName = entry.metadata?.name || 'unknown';
    const existing = existingIndex?.elements[entry.elementType]?.[entryName];

    const definition: ElementDefinition = {
      core: {
        name: entryName,
        type: entry.elementType,
        version: entry.metadata?.version,
        description: entry.metadata?.description,
        created: entry.metadata?.created,
        updated: entry.metadata?.updated || new Date().toISOString()
      }
    };

    if (entry.metadata?.keywords || entry.metadata?.tags || entry.metadata?.triggers) {
      definition.search = {
        keywords: entry.metadata?.keywords,
        tags: entry.metadata?.tags,
        triggers: entry.metadata?.triggers
      };

      // Per-element trigger detail available via element inspection;
      // aggregate counts logged in "Enhanced index built" summary
    }

    if (existing?.custom) {
      definition.custom = existing.custom;
    }

    if (existing?.relationships) {
      definition.relationships = existing.relationships;
    }

    // Issue #749: Extract `activates` references from agent metadata as relationships
    const activatesRels = this.extractActivatesRelationships(entry);
    if (activatesRels.length > 0) {
      if (!definition.relationships) {
        definition.relationships = {};
      }
      const existing_uses = definition.relationships[RelationshipTypes.USES] || [];
      definition.relationships[RelationshipTypes.USES] = [...existing_uses, ...activatesRels];
    }

    if (existing?.actions) {
      definition.actions = existing.actions;
    }

    if (!definition.actions) {
      definition.actions = this.generateDefaultActions(entry);
    }

    return definition;
  }

  /**
   * Extract relationships from agent `activates` metadata.
   * Maps `activates: { skills: ['foo'], templates: ['bar'] }` to
   * BaseRelationship entries with type 'uses'.
   */
  private extractActivatesRelationships(entry: IndexEntry): Relationship[] {
    const activates = entry.metadata?.activates;
    if (!activates || typeof activates !== 'object') {
      return [];
    }

    const relationships: Relationship[] = [];
    for (const [elementType, names] of Object.entries(activates)) {
      if (!Array.isArray(names)) continue;
      for (const name of names) {
        if (typeof name === 'string' && name.length > 0) {
          relationships.push({
            element: `${elementType}:${name}`,
            type: RelationshipTypes.USES,
            strength: 1.0
          });
        }
      }
    }

    return relationships;
  }

  private generateDefaultActions(entry: IndexEntry): Record<string, ActionDefinition> | undefined {
    const actions: Record<string, ActionDefinition> = {};
    const entryName = entry.metadata?.name || '';

    if (!entryName) {
      return undefined;
    }

    switch (entry.elementType) {
      case 'personas':
        if (entryName.includes('debug')) {
          actions.debug = { verb: 'debug', behavior: 'activate', confidence: 0.8 };
          actions.fix = { verb: 'fix', behavior: 'activate', confidence: 0.7 };
        }
        if (entryName.includes('creative')) {
          actions.write = { verb: 'write', behavior: 'activate', confidence: 0.8 };
          actions.create = { verb: 'create', behavior: 'activate', confidence: 0.8 };
        }
        break;

      case 'memories':
        if (entryName.includes('session')) {
          actions.recall = { verb: 'recall', behavior: 'retrieve', confidence: 0.7 };
          actions.remember = { verb: 'remember', behavior: 'retrieve', confidence: 0.7 };
        }
        break;

      case 'skills':
        actions.use = { verb: 'use', behavior: 'execute', confidence: 0.6 };
        actions.apply = { verb: 'apply', behavior: 'execute', confidence: 0.6 };
        break;

      default:
        break;
    }

    return Object.keys(actions).length > 0 ? actions : undefined;
  }
}
