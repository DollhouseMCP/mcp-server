/**
 * Capability Index Resource Handler
 *
 * Exposes the capability index as an MCP resource for injection into LLM context.
 * Provides both summary (action_triggers only) and full index variants.
 *
 * ⚠️ CURRENT STATUS: NON-FUNCTIONAL IN CLAUDE CODE (October 2025)
 *
 * This is a FUTURE-PROOF implementation. MCP Resources are currently:
 * - ✅ Fully implemented and MCP specification compliant
 * - ❌ NOT working in Claude Code (discovery only, never read)
 * - ⚠️ Manual attachment only in Claude Desktop/VS Code
 *
 * WHY IMPLEMENT NOW?
 * - Early adopter advantage when clients add full support
 * - Manual attachment works in Claude Desktop/VS Code
 * - Zero overhead when disabled (default configuration)
 *
 * DEFAULT: DISABLED FOR SAFETY
 * Resources are disabled by default to avoid token overhead and ensure
 * no surprises for users. Must be explicitly enabled in configuration.
 *
 * WHEN WILL THIS BE USEFUL?
 * When Claude Code and other MCP clients implement the missing
 * resources/read functionality and automatic resource injection.
 * Expected timeline: Unknown.
 *
 * For detailed research, see:
 * docs/development/MCP_RESOURCES_SUPPORT_RESEARCH_2025-10-16.md
 *
 * For user documentation, see:
 * docs/configuration/MCP_RESOURCES.md
 */

import fs from 'fs/promises';
import path from 'path';
import yaml from 'js-yaml';
import os from 'os';
import { logger } from '../../utils/logger.js';

/**
 * Metadata about the capability index
 */
interface CapabilityIndexMetadata {
  version: string;
  created: string;
  last_updated: string;
  total_elements: number;
}

/**
 * Full capability index structure
 */
interface CapabilityIndex {
  metadata: CapabilityIndexMetadata;
  action_triggers: Record<string, string[]>;
  elements?: any; // Large section we might exclude in summary
}

/**
 * Statistics about the capability index size and token estimates
 */
interface CapabilityIndexStatistics {
  summarySize: number;
  summaryWords: number;
  summaryLines: number;
  fullSize: number;
  fullWords: number;
  fullLines: number;
  estimatedSummaryTokens: number;
  estimatedFullTokens: number;
}

/**
 * MCP Resource structure
 */
interface MCPResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

/**
 * MCP Resource list response
 */
interface MCPResourceListResponse {
  resources: MCPResource[];
}

/**
 * MCP Resource content item
 */
interface MCPResourceContent {
  uri: string;
  mimeType: string;
  text: string;
}

/**
 * MCP Resource read response
 */
interface MCPResourceReadResponse {
  contents: MCPResourceContent[];
}

/**
 * Capability Index Resource Handler
 *
 * Provides three MCP resources:
 * 1. Summary (~2.5-3.5K tokens) - action_triggers only
 * 2. Full (~35-45K tokens) - complete index with all details
 * 3. Stats (JSON) - size metrics and token estimates
 *
 * WHY DISABLED BY DEFAULT:
 * 1. Current MCP clients don't actually read resources (Claude Code discovery only)
 * 2. Avoids unexpected token overhead when clients do implement reading
 * 3. Provides opt-in behavior for users who want to test manually in Claude Desktop
 *
 * TO ENABLE:
 * Set in config: resources.enabled = true
 * Or environment: DOLLHOUSE_RESOURCES_ENABLED=true
 *
 * NOTE: This class always provides resource handlers for MCP protocol compliance,
 * but the resources are only registered with the MCP server if explicitly enabled.
 */
export class CapabilityIndexResource {
  private readonly capabilityIndexPath: string;
  private cachedIndex: CapabilityIndex | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL = 60000; // 60 seconds

  constructor() {
    // Default path to capability index
    this.capabilityIndexPath = path.join(
      os.homedir(),
      '.dollhouse',
      'portfolio',
      'capability-index.yaml'
    );
  }

  /**
   * Load and parse capability index from filesystem
   * Uses 60-second cache to avoid excessive file reads
   *
   * @returns Parsed capability index
   * @throws Error if file cannot be read or parsed
   */
  private async loadCapabilityIndex(): Promise<CapabilityIndex> {
    const now = Date.now();

    // Return cached version if still valid
    if (this.cachedIndex && (now - this.cacheTimestamp) < this.CACHE_TTL) {
      return this.cachedIndex;
    }

    try {
      // Check if file exists
      await fs.access(this.capabilityIndexPath);

      // Read and parse YAML with safe schema to prevent code execution
      const content = await fs.readFile(this.capabilityIndexPath, 'utf-8');
      const parsed = yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA }) as CapabilityIndex;

      // Cache the result
      this.cachedIndex = parsed;
      this.cacheTimestamp = now;

      logger.info(`Loaded capability index: ${parsed.metadata.total_elements} elements`);

      return parsed;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to load capability index: ${errorMessage}`);
      throw new Error(`Capability index not available: ${errorMessage}`);
    }
  }

  /**
   * Generate summary version of capability index (metadata + action_triggers only)
   * Estimated: 2,500-3,500 tokens
   *
   * @returns YAML string with header and summary content
   */
  async generateSummary(): Promise<string> {
    const index = await this.loadCapabilityIndex();

    const summary = {
      metadata: index.metadata,
      action_triggers: index.action_triggers
    };

    // Convert to YAML for readability
    const yamlContent = yaml.dump(summary, {
      indent: 2,
      lineWidth: 120,
      noRefs: true
    });

    // Add header comment
    const header = `# Capability Index Summary
# This is a lightweight summary of the capability index for LLM context injection.
# Contains action verb → element mappings for quick tool selection guidance.
# Full index available at: dollhouse://capability-index/full
# Total elements: ${index.metadata.total_elements}

`;

    return header + yamlContent;
  }

  /**
   * Generate full capability index
   * Estimated: 35,000-45,000 tokens
   *
   * @returns YAML string with header and full index content
   */
  async generateFull(): Promise<string> {
    const index = await this.loadCapabilityIndex();

    // Convert to YAML for readability
    const yamlContent = yaml.dump(index, {
      indent: 2,
      lineWidth: 120,
      noRefs: true
    });

    // Add header comment
    const header = `# Capability Index (Full)
# Complete capability index including all element details, relationships, and semantic data.
# This is a large resource (~35-45K tokens) - use only with large context models.
# Summary version available at: dollhouse://capability-index/summary
# Total elements: ${index.metadata.total_elements}

`;

    return header + yamlContent;
  }

  /**
   * Get statistics about the capability index for measurement
   * Provides size metrics and rough token estimates using:
   * (chars/4 + words*1.3)/2 formula
   *
   * @returns Statistics object with size and token estimates
   */
  async getStatistics(): Promise<CapabilityIndexStatistics> {
    const summary = await this.generateSummary();
    const full = await this.generateFull();

    return {
      summarySize: summary.length,
      summaryWords: summary.split(/\s+/).length,
      summaryLines: summary.split('\n').length,
      fullSize: full.length,
      fullWords: full.split(/\s+/).length,
      fullLines: full.split('\n').length,
      // Rough token estimates (chars/4 + words*1.3)/2
      estimatedSummaryTokens: Math.round((summary.length / 4 + summary.split(/\s+/).length * 1.3) / 2),
      estimatedFullTokens: Math.round((full.length / 4 + full.split(/\s+/).length * 1.3) / 2)
    };
  }

  /**
   * MCP Resource Handler: List available resources
   *
   * Returns three resources:
   * - summary: Lightweight index (~2.5-3.5K tokens)
   * - full: Complete index (~35-45K tokens)
   * - stats: Size and token metrics (JSON)
   *
   * @returns Resource list with URIs, names, descriptions, and MIME types
   */
  async listResources(): Promise<MCPResourceListResponse> {
    return {
      resources: [
        {
          uri: 'dollhouse://capability-index/summary',
          name: 'Capability Index Summary',
          description: 'Lightweight capability index with action verb → element mappings. Estimated ~2.5-3.5K tokens. Recommended for models with 200K+ context.',
          mimeType: 'text/yaml'
        },
        {
          uri: 'dollhouse://capability-index/full',
          name: 'Capability Index (Full)',
          description: 'Complete capability index with all element details, relationships, and semantic data. Estimated ~35-45K tokens. Recommended for models with 500K+ context.',
          mimeType: 'text/yaml'
        },
        {
          uri: 'dollhouse://capability-index/stats',
          name: 'Capability Index Statistics',
          description: 'Measurement data about capability index size and token estimates.',
          mimeType: 'application/json'
        }
      ]
    };
  }

  /**
   * MCP Resource Handler: Read a specific resource
   *
   * @param uri - Resource URI to read (must match one from listResources)
   * @returns Resource content with URI, MIME type, and text
   * @throws Error if URI is not recognized
   */
  async readResource(uri: string): Promise<MCPResourceReadResponse> {
    let content: string;
    let mimeType: string;

    switch (uri) {
      case 'dollhouse://capability-index/summary':
        content = await this.generateSummary();
        mimeType = 'text/yaml';
        break;

      case 'dollhouse://capability-index/full':
        content = await this.generateFull();
        mimeType = 'text/yaml';
        break;

      case 'dollhouse://capability-index/stats':
        const stats = await this.getStatistics();
        content = JSON.stringify(stats, null, 2);
        mimeType = 'application/json';
        break;

      default:
        throw new Error(`Unknown capability index resource: ${uri}`);
    }

    return {
      contents: [
        {
          uri,
          mimeType,
          text: content
        }
      ]
    };
  }
}
