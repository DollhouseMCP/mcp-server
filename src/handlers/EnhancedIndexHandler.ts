/**
 * Enhanced Index handler for semantic search and relationships
 *
 * Implements the MCP tool handlers for Enhanced Index functionality
 * including similarity search, relationship discovery, and verb-based search.
 *
 * FIXES IMPLEMENTED (Issue #1099):
 * - Uses centralized element ID parsing utilities
 * - Consistent ID format handling
 * - Better error handling for invalid IDs
 */

import { EnhancedIndexManager } from '../portfolio/EnhancedIndexManager.js';
import { ErrorHandler } from '../utils/ErrorHandler.js';
import { SecureErrorHandler } from '../security/errorHandler.js';
import { logger } from '../utils/logger.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { parseElementIdWithFallback, formatElementId } from '../utils/elementId.js';

export class EnhancedIndexHandler {
  private enhancedIndexManager: EnhancedIndexManager;
  private personaIndicator: string;

  constructor(personaIndicator: string = '') {
    this.enhancedIndexManager = EnhancedIndexManager.getInstance();
    this.personaIndicator = personaIndicator;
  }

  /**
   * Find semantically similar elements using NLP scoring
   */
  async findSimilarElements(options: {
    elementName: string;
    elementType?: string;
    limit: number;
    threshold: number;
  }) {
    try {
      // Validate inputs
      if (!options.elementName || typeof options.elementName !== 'string') {
        throw new Error('Element name is required and must be a string');
      }

      // FIX: DMCP-SEC-004 - Normalize Unicode in user input to prevent homograph attacks
      const normalized = UnicodeValidator.normalize(options.elementName);
      if (!normalized.isValid) {
        throw new Error(`Invalid element name: ${normalized.detectedIssues?.join(', ')}`);
      }
      options.elementName = normalized.normalizedContent;

      // Also normalize element type if provided
      if (options.elementType) {
        const normalizedType = UnicodeValidator.normalize(options.elementType);
        if (!normalizedType.isValid) {
          throw new Error(`Invalid element type: ${normalizedType.detectedIssues?.join(', ')}`);
        }
        options.elementType = normalizedType.normalizedContent;
      }
      if (options.limit <= 0 || options.limit > 100) {
        options.limit = 5; // Default to reasonable limit
      }
      if (options.threshold < 0 || options.threshold > 1) {
        options.threshold = 0.3; // Default to reasonable threshold
      }
      // Ensure the enhanced index is available with error handling
      try {
        await this.enhancedIndexManager.getIndex();
      } catch (indexError) {
        logger.error('Failed to get Enhanced Index', indexError);
        // Try to recover by forcing rebuild
        try {
          await this.enhancedIndexManager.getIndex({ forceRebuild: true });
        } catch (rebuildError) {
          throw new Error('Enhanced Index is unavailable. Please try again later.');
        }
      }

      // FIX: DMCP-SEC-006 - Add security audit logging for index operations
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_CREATED',
        severity: 'LOW',
        source: 'EnhancedIndexHandler.findSimilarElements',
        details: `Similarity search performed for element: ${options.elementName}`,
        additionalData: {
          elementType: options.elementType,
          limit: options.limit,
          threshold: options.threshold
        }
      });

      // Find the element
      const elementId = options.elementType ?
        `${options.elementType}/${options.elementName}` :
        options.elementName;

      // Get connected elements (similar/related)
      const connectedMap = await this.enhancedIndexManager.getConnectedElements(
        elementId,
        {
          maxDepth: 1,  // Direct relationships only
          minStrength: options.threshold
        }
      );

      // Convert to array and sort by relationship strength
      const similarElements = Array.from(connectedMap.entries())
        .map(([id, path]) => {
          const [type, name] = id.split('/');
          return {
            type,
            name,
            score: path.totalStrength || 0,
            relationships: path.relationships || []  // relationships is already an array of strings
          };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, options.limit);

      // Format results
      let text = `${this.personaIndicator}🔍 **Similar Elements**\n\n`;
      text += `**Reference**: ${options.elementName}\n`;
      if (options.elementType) {
        text += `**Type**: ${options.elementType}\n`;
      }
      text += `**Found**: ${similarElements.length} similar elements\n\n`;

      if (similarElements.length === 0) {
        text += `No similar elements found with similarity score >= ${options.threshold}\n`;
      } else {
        for (const element of similarElements) {
          const icon = this.getElementIcon(element.type);
          text += `${icon} **${element.name}** (${element.type})\n`;
          text += `   📊 Similarity: ${(element.score * 100).toFixed(1)}%\n`;
          if (element.relationships && element.relationships.length > 0) {
            text += `   🔗 Relationships: ${element.relationships.join(', ')}\n`;
          }
          text += '\n';
        }
      }

      return {
        content: [{
          type: "text",
          text
        }]
      };
    } catch (error: any) {
      ErrorHandler.logError('EnhancedIndexHandler.findSimilarElements', error, options);
      return {
        content: [{
          type: "text",
          text: `${this.personaIndicator}❌ Failed to find similar elements: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Get all relationships for a specific element
   */
  async getElementRelationships(options: {
    elementName: string;
    elementType?: string;
    relationshipTypes?: string[];
  }) {
    try {
      // FIX: DMCP-SEC-004 - Normalize Unicode in user input
      const normalized = UnicodeValidator.normalize(options.elementName);
      if (!normalized.isValid) {
        throw new Error(`Invalid element name: ${normalized.detectedIssues?.join(', ')}`);
      }
      options.elementName = normalized.normalizedContent;

      if (options.elementType) {
        const normalizedType = UnicodeValidator.normalize(options.elementType);
        if (!normalizedType.isValid) {
          throw new Error(`Invalid element type: ${normalizedType.detectedIssues?.join(', ')}`);
        }
        options.elementType = normalizedType.normalizedContent;
      }

      // Get the index with error handling
      await this.enhancedIndexManager.getIndex().catch(async (error) => {
        logger.error('Failed to get Enhanced Index, attempting rebuild', error);
        return this.enhancedIndexManager.getIndex({ forceRebuild: true });
      });

      // FIX: DMCP-SEC-006 - Add security audit logging
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_CREATED',
        severity: 'LOW',
        source: 'EnhancedIndexHandler.getElementRelationships',
        details: `Relationship query performed for element: ${options.elementName}`,
        additionalData: {
          elementType: options.elementType,
          relationshipTypes: options.relationshipTypes
        }
      });

      // FIX: Use centralized element ID formatting
      // If no element type provided, use full element name as-is (may already include type)
      const elementId = options.elementType ?
        formatElementId(options.elementType, options.elementName) :
        options.elementName;

      const relationships = await this.enhancedIndexManager.getElementRelationships(elementId);

      // Filter by type if requested
      let filteredRelationships = relationships;
      if (options.relationshipTypes && options.relationshipTypes.length > 0) {
        filteredRelationships = {};
        for (const type of options.relationshipTypes) {
          if (relationships[type]) {
            filteredRelationships[type] = relationships[type];
          }
        }
      }

      // Format results
      let text = `${this.personaIndicator}🔗 **Element Relationships**\n\n`;
      text += `**Element**: ${options.elementName}\n`;
      if (options.elementType) {
        text += `**Type**: ${options.elementType}\n`;
      }
      text += '\n';

      const relationshipCount = Object.values(filteredRelationships)
        .reduce((sum, rels) => sum + (Array.isArray(rels) ? rels.length : 0), 0);

      if (relationshipCount === 0) {
        text += `No relationships found for this element.\n`;
      } else {
        for (const [relType, relations] of Object.entries(filteredRelationships)) {
          if (Array.isArray(relations) && relations.length > 0) {
            text += `**${relType.charAt(0).toUpperCase() + relType.slice(1)} (${relations.length})**\n`;
            for (const rel of relations) {
              // FIX: Use centralized element ID parsing
              const parsed = parseElementIdWithFallback(rel.element);
              const icon = this.getElementIcon(parsed.type);
              text += `  ${icon} ${parsed.name}`;
              if (rel.strength) {
                text += ` (strength: ${(rel.strength * 100).toFixed(0)}%)`;
              }
              text += '\n';
            }
            text += '\n';
          }
        }
      }

      return {
        content: [{
          type: "text",
          text
        }]
      };
    } catch (error: any) {
      ErrorHandler.logError('EnhancedIndexHandler.getElementRelationships', error, options);
      return {
        content: [{
          type: "text",
          text: `${this.personaIndicator}❌ Failed to get relationships: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Search for elements by action verb
   */
  async searchByVerb(options: {
    verb: string;
    limit: number;
  }) {
    try {
      // FIX: DMCP-SEC-004 - Normalize Unicode in user input
      const normalized = UnicodeValidator.normalize(options.verb);
      if (!normalized.isValid) {
        throw new Error(`Invalid verb: ${normalized.detectedIssues?.join(', ')}`);
      }
      options.verb = normalized.normalizedContent;

      // Get the index with error handling
      await this.enhancedIndexManager.getIndex().catch(async (error) => {
        logger.error('Failed to get Enhanced Index, attempting rebuild', error);
        return this.enhancedIndexManager.getIndex({ forceRebuild: true });
      });

      // FIX: DMCP-SEC-006 - Add security audit logging
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_CREATED',
        severity: 'LOW',
        source: 'EnhancedIndexHandler.searchByVerb',
        details: `Verb search performed for action: ${options.verb}`,
        additionalData: {
          verb: options.verb,
          limit: options.limit
        }
      });

      // Search by verb
      const results = await this.enhancedIndexManager.getElementsByAction(options.verb);

      // Limit results
      const limited = results.slice(0, options.limit);

      // Format results
      let text = `${this.personaIndicator}🎯 **Elements for Action: "${options.verb}"**\n\n`;
      text += `**Found**: ${limited.length} element${limited.length === 1 ? '' : 's'}\n\n`;

      if (limited.length === 0) {
        text += `No elements found that can handle the action "${options.verb}".\n\n`;
        text += `**Tips:**\n`;
        text += `• Try related verbs (e.g., "analyze" → "review", "examine")\n`;
        text += `• Use common action verbs like "create", "debug", "optimize"\n`;
        text += `• Check element descriptions for supported actions\n`;
      } else {
        for (const elementName of limited) {
          // FIX: Use centralized element ID parsing
          // Note: getElementsByAction returns names in "type/name" format for legacy reasons
          const parsed = elementName.includes('/') ?
            { type: elementName.split('/')[0], name: elementName.split('/')[1] } :
            parseElementIdWithFallback(elementName);

          const icon = this.getElementIcon(parsed.type);
          text += `${icon} **${parsed.name}** (${parsed.type})\n`;
        }
      }

      return {
        content: [{
          type: "text",
          text
        }]
      };
    } catch (error: any) {
      ErrorHandler.logError('EnhancedIndexHandler.searchByVerb', error, options);
      return {
        content: [{
          type: "text",
          text: `${this.personaIndicator}❌ Failed to search by verb: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Get statistics about the Enhanced Index relationships
   */
  async getRelationshipStats() {
    try {
      // Get the index with error handling
      await this.enhancedIndexManager.getIndex().catch(async (error) => {
        logger.error('Failed to get Enhanced Index, attempting rebuild', error);
        return this.enhancedIndexManager.getIndex({ forceRebuild: true });
      });

      // FIX: DMCP-SEC-006 - Add security audit logging
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_CREATED',
        severity: 'LOW',
        source: 'EnhancedIndexHandler.getRelationshipStats',
        details: 'Enhanced Index statistics retrieved',
        additionalData: {}
      });

      // Get stats
      const stats = await this.enhancedIndexManager.getRelationshipStats();

      // Get the index for additional info
      const index = await this.enhancedIndexManager.getIndex();

      // Format results
      let text = `${this.personaIndicator}📊 **Enhanced Index Statistics**\n\n`;
      text += `**Index Metadata:**\n`;
      text += `• Version: ${index.metadata.version}\n`;
      text += `• Last Updated: ${new Date(index.metadata.last_updated).toLocaleString()}\n`;
      text += `• Total Elements: ${index.metadata.total_elements}\n\n`;

      text += `**Relationship Statistics:**\n`;
      for (const [type, count] of Object.entries(stats)) {
        text += `• ${type}: ${count}\n`;
      }

      // Count verb triggers
      const verbCount = Object.keys(index.action_triggers || {}).length;
      text += `\n**Verb Triggers:** ${verbCount} verbs mapped\n`;

      // Show top verbs if any
      if (verbCount > 0) {
        const topVerbs = Object.entries(index.action_triggers)
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 5);
        text += `**Top Action Verbs:**\n`;
        for (const [verb, elements] of topVerbs) {
          text += `• ${verb}: ${elements.length} elements\n`;
        }
      }

      return {
        content: [{
          type: "text",
          text
        }]
      };
    } catch (error: any) {
      ErrorHandler.logError('EnhancedIndexHandler.getRelationshipStats', error);
      return {
        content: [{
          type: "text",
          text: `${this.personaIndicator}❌ Failed to get stats: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Get icon for element type
   */
  private getElementIcon(type: string): string {
    const icons: { [key: string]: string } = {
      personas: '🎭',
      skills: '🛠️',
      templates: '📄',
      agents: '🤖',
      memories: '🧠',
      ensembles: '🎨',
      unknown: '📦'
    };
    return icons[type] || icons.unknown;
  }
}