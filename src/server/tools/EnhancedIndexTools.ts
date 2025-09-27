/**
 * Enhanced Index tool definitions and handlers
 *
 * Provides MCP tools for accessing semantic relationships, similarity search,
 * and verb-based discovery features of the Enhanced Capability Index.
 *
 * FIXES IMPLEMENTED (Issue #1100):
 * - Uses configuration for default values instead of hardcoded numbers
 */

import { ToolDefinition } from './ToolRegistry.js';
import { IToolHandler } from '../types.js';
import { IndexConfigManager } from '../../portfolio/config/IndexConfig.js';

// Tool argument interfaces
interface FindSimilarElementsArgs {
  element_name: string;
  element_type?: string;
  limit?: number;
  threshold?: number;
}

interface GetElementRelationshipsArgs {
  element_name: string;
  element_type?: string;
  relationship_types?: string[];
}

interface SearchByVerbArgs {
  verb: string;
  limit?: number;
}

// Tool handler function type
type ToolHandler<T> = (args: T) => Promise<any>;

export function getEnhancedIndexTools(server: IToolHandler): Array<{ tool: ToolDefinition; handler: ToolHandler<any> }> {
  // FIX: Get configuration for default values
  const config = IndexConfigManager.getInstance().getConfig();
  const tools: Array<{ tool: ToolDefinition; handler: ToolHandler<any> }> = [
    {
      tool: {
        name: "find_similar_elements",
        description: "Find elements that are semantically similar to a given element using NLP scoring (Jaccard similarity and Shannon entropy). Returns elements with similarity scores and relationships.",
        inputSchema: {
          type: "object",
          properties: {
            element_name: {
              type: "string",
              description: "Name of the element to find similar items for",
            },
            element_type: {
              type: "string",
              enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"],
              description: "Type of the element. If not specified, searches all types.",
            },
            limit: {
              type: "number",
              description: `Maximum number of similar elements to return. Defaults to ${config.performance.defaultSimilarLimit}.`,
            },
            threshold: {
              type: "number",
              description: `Minimum similarity score (0-1) to include. Defaults to ${config.performance.defaultSimilarityThreshold}.`,
            },
          },
          required: ["element_name"],
        },
      },
      handler: (args: FindSimilarElementsArgs) => server.findSimilarElements({
        elementName: args.element_name,
        elementType: args.element_type,
        limit: args.limit || config.performance.defaultSimilarLimit,
        threshold: args.threshold || config.performance.defaultSimilarityThreshold
      })
    },
    {
      tool: {
        name: "get_element_relationships",
        description: "Get all relationships for a specific element, including semantic similarities, verb-based connections, and cross-element references.",
        inputSchema: {
          type: "object",
          properties: {
            element_name: {
              type: "string",
              description: "Name of the element to get relationships for",
            },
            element_type: {
              type: "string",
              enum: ["personas", "skills", "templates", "agents", "memories", "ensembles"],
              description: "Type of the element. If not specified, searches all types.",
            },
            relationship_types: {
              type: "array",
              items: {
                type: "string",
                enum: ["similar", "uses", "extends", "requires", "complements", "verb-based"]
              },
              description: "Filter by specific relationship types. If not specified, returns all types.",
            },
          },
          required: ["element_name"],
        },
      },
      handler: (args: GetElementRelationshipsArgs) => server.getElementRelationships({
        elementName: args.element_name,
        elementType: args.element_type,
        relationshipTypes: args.relationship_types
      })
    },
    {
      tool: {
        name: "search_by_verb",
        description: "Search for elements that can handle a specific action verb (e.g., 'analyze', 'create', 'debug'). Uses verb trigger patterns to find matching elements.",
        inputSchema: {
          type: "object",
          properties: {
            verb: {
              type: "string",
              description: "Action verb to search for (e.g., 'analyze', 'create', 'debug', 'review')",
            },
            limit: {
              type: "number",
              description: `Maximum number of results to return. Defaults to ${config.performance.defaultVerbSearchLimit}.`,
            },
          },
          required: ["verb"],
        },
      },
      handler: (args: SearchByVerbArgs) => server.searchByVerb({
        verb: args.verb,
        limit: args.limit || config.performance.defaultVerbSearchLimit
      })
    },
    {
      tool: {
        name: "get_relationship_stats",
        description: "Get statistics about the Enhanced Index relationships, including total counts by type, most connected elements, and index health metrics.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      handler: () => server.getRelationshipStats()
    }
  ];

  return tools;
}