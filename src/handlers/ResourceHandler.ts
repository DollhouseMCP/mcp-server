/**
 * ResourceHandler - Manages MCP Resources capability
 *
 * Handles registration and serving of MCP resources including:
 * - Capability Index (summary, full, stats variants)
 *
 * Uses dependency injection pattern consistent with refactored architecture.
 * Resources are disabled by default and require explicit configuration.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { CapabilityIndexResource } from '../server/resources/CapabilityIndexResource.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { logger } from '../utils/logger.js';
import { ErrorHandler } from '../utils/ErrorHandler.js';
import { FileOperationsService } from '../services/FileOperationsService.js';
import { FileLockManager } from '../security/fileLockManager.js';

/**
 * Handler for MCP Resources protocol
 */
export class ResourceHandler {
  private capabilityIndexResource?: CapabilityIndexResource;
  private isEnabled: boolean = false;
  private enabledVariants: string[] = [];

  constructor(
    private readonly configManager: ConfigManager
  ) {}

  /**
   * Initialize and register resource handlers with the MCP server
   *
   * This method:
   * 1. Checks configuration to see if resources are enabled
   * 2. Initializes the CapabilityIndexResource
   * 3. Registers ListResourcesRequest and ReadResourceRequest handlers
   *
   * @param server - MCP Server instance to register handlers with
   */
  async initialize(server: Server): Promise<void> {
    try {
      // Check if resources are enabled in configuration
      const resourcesConfig = this.configManager.getSetting<any>('elements.enhanced_index.resources');

      if (!resourcesConfig?.advertise_resources) {
        logger.info('[ResourceHandler] MCP Resources disabled (future-proof implementation, opt-in required)');
        return;
      }

      // Resources are enabled
      this.isEnabled = true;

      // Initialize resource handler with FileOperationsService
      const fileLockManager = new FileLockManager();
      const fileOperations = new FileOperationsService(fileLockManager);
      this.capabilityIndexResource = new CapabilityIndexResource(fileOperations);

      // Determine which variants are enabled
      if (resourcesConfig.variants?.summary) this.enabledVariants.push('summary');
      if (resourcesConfig.variants?.full) this.enabledVariants.push('full');
      if (resourcesConfig.variants?.stats) this.enabledVariants.push('stats');

      logger.info(`[ResourceHandler] MCP Resources enabled: capability-index (variants: ${this.enabledVariants.join(', ') || 'none'})`);

      // Register ListResourcesRequest handler
      server.setRequestHandler(ListResourcesRequestSchema, async () => {
        if (!this.capabilityIndexResource) {
          throw new McpError(ErrorCode.InternalError, 'Resource handler not initialized');
        }
        const result = await this.capabilityIndexResource.listResources();
        return result as any; // Type assertion needed for MCP SDK compatibility
      });

      // Register ReadResourceRequest handler
      server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        if (!this.capabilityIndexResource) {
          throw new McpError(ErrorCode.InternalError, 'Resource handler not initialized');
        }
        const result = await this.capabilityIndexResource.readResource(request.params.uri);
        return result as any; // Type assertion needed for MCP SDK compatibility
      });

      logger.debug('[ResourceHandler] MCP resource handlers registered successfully');
    } catch (error) {
      ErrorHandler.logError('ResourceHandler.initialize', error);
      // Don't throw - resource setup failures shouldn't prevent server startup
      logger.warn('[ResourceHandler] Failed to setup MCP resource handlers, continuing without resources');
      this.isEnabled = false;
    }
  }

  /**
   * Check if resources are currently enabled
   */
  getIsEnabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Get list of enabled resource variants
   */
  getEnabledVariants(): string[] {
    return [...this.enabledVariants];
  }
}
