/**
 * Portfolio sync handler for the sync_portfolio MCP tool
 * Manages bi-directional synchronization between local portfolio and GitHub
 * This V2 version works with the actual PortfolioSyncManager implementation
 */

import { PortfolioSyncManager, SyncOperation, SyncResult } from '../portfolio/PortfolioSyncManager.js';
import { ConfigManager } from '../config/ConfigManager.js';
import { SecureErrorHandler } from '../security/errorHandler.js';
import { ElementType } from '../portfolio/PortfolioManager.js';
import { logger } from '../utils/logger.js';

export interface SyncOperationOptions {
  operation: 'list-remote' | 'download' | 'upload' | 'compare' | 'bulk-download' | 'bulk-upload';
  element_name?: string;
  element_type?: ElementType;
  filter?: {
    type?: ElementType;
    author?: string;
    updated_after?: string;
  };
  options?: {
    force?: boolean;
    dry_run?: boolean;
    include_private?: boolean;
  };
}

export class SyncHandler {
  private syncManager: PortfolioSyncManager;
  private configManager: ConfigManager;
  
  constructor() {
    this.syncManager = new PortfolioSyncManager();
    this.configManager = ConfigManager.getInstance();
  }
  
  /**
   * Handle portfolio sync operations
   */
  async handleSyncOperation(options: SyncOperationOptions, indicator: string = '') {
    try {
      await this.configManager.initialize();
      
      // Check if sync is enabled (allow list-remote and compare even when disabled)
      const syncEnabled = this.configManager.getSetting('sync.enabled');
      const readOnlyOperations = ['list-remote', 'compare'];
      if (!syncEnabled && !readOnlyOperations.includes(options.operation)) {
        return {
          content: [{
            type: "text",
            text: `${indicator}⚠️ **Sync is Disabled**\n\n` +
                  `Portfolio sync is currently disabled for privacy.\n\n` +
                  `To enable sync:\n` +
                  `\`dollhouse_config action: "set", setting: "sync.enabled", value: true\`\n\n` +
                  `You can still use \`list-remote\` and \`compare\` to view differences.`
          }]
        };
      }
      
      // Map our operation to PortfolioSyncManager's SyncOperation format
      const syncOp: SyncOperation = {
        operation: this.mapOperation(options.operation),
        element_name: options.element_name,
        element_type: options.element_type || options.filter?.type, // Use filter.type if element_type not provided
        bulk: options.operation.includes('bulk'),
        show_diff: options.operation === 'compare',
        force: options.options?.force,
        confirm: options.options?.force || options.options?.dry_run === false // force implies confirm, dry_run=false means confirm
      };
      
      // Call the unified handleSyncOperation method
      const result = await this.syncManager.handleSyncOperation(syncOp);
      
      // Format the result based on the operation type
      return this.formatResult(result, options, indicator);
      
    } catch (error) {
      const sanitizedError = SecureErrorHandler.sanitizeError(error);
      return {
        content: [{
          type: "text",
          text: `${indicator}❌ Sync operation failed: ${sanitizedError.message}`
        }]
      };
    }
  }
  
  private mapOperation(operation: string): 'download' | 'upload' | 'compare' | 'list-remote' {
    switch (operation) {
      case 'list-remote':
        return 'list-remote';
      case 'download':
      case 'bulk-download':
        return 'download';
      case 'upload':
      case 'bulk-upload':
        return 'upload';
      case 'compare':
        return 'compare';
      default:
        return 'list-remote';
    }
  }
  
  private formatResult(result: SyncResult, options: SyncOperationOptions, indicator: string) {
    if (!result.success) {
      return {
        content: [{
          type: "text",
          text: `${indicator}❌ ${result.message}`
        }]
      };
    }
    
    switch (options.operation) {
      case 'list-remote':
        return this.formatListResult(result, indicator);
      
      case 'download':
      case 'bulk-download':
        return this.formatDownloadResult(result, options, indicator);
      
      case 'upload':
      case 'bulk-upload':
        return this.formatUploadResult(result, options, indicator);
      
      case 'compare':
        return this.formatCompareResult(result, options, indicator);
      
      default:
        return {
          content: [{
            type: "text",
            text: `${indicator}✅ ${result.message}`
          }]
        };
    }
  }
  
  private formatListResult(result: SyncResult, indicator: string) {
    if (!result.elements || result.elements.length === 0) {
      return {
        content: [{
          type: "text",
          text: `${indicator}📋 **GitHub Portfolio is Empty**\n\n` +
                `No elements found in your GitHub portfolio.\n\n` +
                `Upload elements using:\n` +
                `\`sync_portfolio operation: "upload", element_name: "name", element_type: "type"\``
        }]
      };
    }
    
    let text = `${indicator}📋 **GitHub Portfolio Contents**\n\n`;
    text += `Found ${result.elements.length} elements:\n\n`;
    
    // Group by type
    const byType: Record<string, any[]> = {};
    for (const element of result.elements) {
      if (!byType[element.type]) {
        byType[element.type] = [];
      }
      byType[element.type].push(element);
    }
    
    for (const [type, elements] of Object.entries(byType)) {
      text += `**${type}** (${elements.length}):\n`;
      for (const element of elements) {
        text += `  • ${element.name}`;
        if (element.remoteVersion) {
          text += ` v${element.remoteVersion}`;
        }
        if (element.status) {
          text += ` (${element.status})`;
        }
        text += '\n';
      }
      text += '\n';
    }
    
    return {
      content: [{
        type: "text",
        text
      }]
    };
  }
  
  private formatDownloadResult(result: SyncResult, options: SyncOperationOptions, indicator: string) {
    if (options.operation === 'bulk-download') {
      const elements = result.elements || [];
      const downloaded = elements.filter(e => e.action === 'download').length;
      const skipped = elements.filter(e => e.action === 'skip').length;
      
      return {
        content: [{
          type: "text",
          text: `${indicator}✅ **Bulk Download Complete**\n\n` +
                `Downloaded: ${downloaded} elements\n` +
                `Skipped: ${skipped} elements\n\n` +
                result.message
        }]
      };
    }
    
    return {
      content: [{
        type: "text",
        text: `${indicator}✅ **Element Downloaded**\n\n` +
              `Element: ${options.element_name} (${options.element_type})\n\n` +
              result.message
      }]
    };
  }
  
  private formatUploadResult(result: SyncResult, options: SyncOperationOptions, indicator: string) {
    if (options.operation === 'bulk-upload') {
      const elements = result.elements || [];
      const uploaded = elements.filter(e => e.action === 'upload').length;
      const skipped = elements.filter(e => e.action === 'skip').length;
      
      return {
        content: [{
          type: "text",
          text: `${indicator}✅ **Bulk Upload Complete**\n\n` +
                `Uploaded: ${uploaded} elements\n` +
                `Skipped: ${skipped} elements\n\n` +
                result.message
        }]
      };
    }
    
    return {
      content: [{
        type: "text",
        text: `${indicator}✅ **Element Uploaded**\n\n` +
              `Element: ${options.element_name} (${options.element_type})\n\n` +
              result.message
      }]
    };
  }
  
  private formatCompareResult(result: SyncResult, options: SyncOperationOptions, indicator: string) {
    let text = `${indicator}🔍 **Version Comparison**\n\n`;
    text += `Element: ${options.element_name} (${options.element_type})\n\n`;
    
    if (result.data) {
      // If we have detailed comparison data
      const data = result.data;
      if (data.local) {
        text += `**Local Version**: ${data.local.version}\n`;
        text += `  Modified: ${new Date(data.local.timestamp).toLocaleString()}\n`;
      } else {
        text += `**Local Version**: Not found\n`;
      }
      
      if (data.remote) {
        text += `\n**Remote Version**: ${data.remote.version}\n`;
        text += `  Modified: ${new Date(data.remote.timestamp).toLocaleString()}\n`;
      } else {
        text += `\n**Remote Version**: Not found\n`;
      }
      
      if (data.diff) {
        text += `\n**Differences**:\n${data.diff}`;
      }
    }
    
    text += `\n\n${result.message}`;
    
    return {
      content: [{
        type: "text",
        text
      }]
    };
  }
}