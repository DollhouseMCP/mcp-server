/**
 * MemoryActivationStrategy - Strategy for memory element activation
 *
 * Handles activation, deactivation, and status tracking for memory elements.
 * Issue #18 Phase 4: Context-loading strategy with state management
 */

import { MemoryManager } from '../../elements/memories/MemoryManager.js';
import { BaseActivationStrategy } from './BaseActivationStrategy.js';
import { ElementActivationStrategy, MCPResponse } from './ElementActivationStrategy.js';

export class MemoryActivationStrategy extends BaseActivationStrategy implements ElementActivationStrategy {
  constructor(private readonly memoryManager: MemoryManager) {
    super();
  }

  /**
   * Activate a memory
   * Issue #18 Phase 4: Context-loading activation strategy
   * - Load memory entries into active context
   * - Apply retention policies if configured
   * - Track activation in manager's active set
   */
  async activate(name: string, context?: Record<string, any>): Promise<MCPResponse> {
    // Use the manager's activation method which tracks active memories
    const result = await this.memoryManager.activateMemory(name);

    if (!result.success || !result.memory) {
      return this.createNotFoundResponse(name, 'Memory');
    }

    const memory = result.memory;

    // Get memory statistics for context loading information
    const stats = memory.getStats();
    const retentionDays = (memory.metadata as any).retentionDays || 'permanent';
    const tags = (memory.metadata as any).tags?.join(', ') || 'none';

    // Build activation response with context-loading information
    const parts = [
      `✅ Memory '${memory.metadata.name}' activated - ${stats.totalEntries} entries loaded into context`,
      ''
    ];

    // Check if context was provided for additional activation options
    const hasActivationContext = context && Object.keys(context).length > 0;
    const autoLoadRequested = context?.autoLoad === true;

    if (autoLoadRequested) {
      // Auto-load activation context
      parts.push('Memory activates and automatically loads entries');
    } else if (hasActivationContext) {
      // Other activation contexts
      parts.push('Memory context loaded and applied with specified options');
    } else {
      // Default activation
      parts.push('Memory becomes active, context loaded into working set');
    }

    parts.push('');
    parts.push(`**Retention**: ${retentionDays} days`);
    parts.push(`**Tags**: ${tags}`);
    parts.push(`**Entries**: ${stats.totalEntries}`);

    if (stats.totalSize > 0) {
      parts.push(`**Size**: ${stats.totalSize} bytes`);
    }

    parts.push('');
    parts.push('This memory is now available for context and will be used to enhance responses.');

    const gatekeeperWarning = this.formatGatekeeperValidityWarning(memory.metadata as unknown as Record<string, unknown>);
    if (gatekeeperWarning) {
      parts.push(gatekeeperWarning);
    }

    return {
      content: [{
        type: "text",
        text: parts.join('\n')
      }]
    };
  }

  /**
   * Deactivate a memory
   * Issue #18 Phase 4: Use manager's deactivation method
   *
   * @throws {ElementNotFoundError} When memory does not exist
   * @see Issue #275 - Handlers return success=true for missing elements
   */
  async deactivate(name: string): Promise<MCPResponse> {
    const result = await this.memoryManager.deactivateMemory(name);

    if (!result.success) {
      this.throwNotFoundError(name, 'Memory');
    }

    return this.createSuccessResponse(result.message);
  }

  /**
   * Get all active memories
   * Issue #18 Phase 4: Use manager's getActiveMemories method
   */
  async getActiveElements(): Promise<MCPResponse> {
    // Use the manager's method to get active memories directly
    const activeMemories = await this.memoryManager.getActiveMemories();

    if (activeMemories.length === 0) {
      return {
        content: [{
          type: "text",
          text: "🧠 No active memories"
        }]
      };
    }

    const memoryList = activeMemories.map(m => {
      const tags = (m.metadata as any).tags?.join(', ') || 'none';
      const retentionDays = (m.metadata as any).retentionDays || 'permanent';
      return `🧠 ${m.metadata.name} (Tags: ${tags}) - ${retentionDays} days retention`;
    }).join('\n');

    return {
      content: [{
        type: "text",
        text: `Active memories:\n${memoryList}`
      }]
    };
  }

  /**
   * Get detailed information about a memory
   * Extracted from ElementCRUDHandler.ts lines 772-805
   *
   * @throws {ElementNotFoundError} When memory does not exist
   * @see Issue #275 - Handlers return success=true for missing elements
   */
  async getElementDetails(name: string): Promise<MCPResponse> {
    // Use flexible finding to support both display name and filename
    const allMemories = await this.memoryManager.list();
    const memory = await this.findElementFlexibly(name, allMemories);
    if (!memory) {
      this.throwNotFoundError(name, 'Memory');
    }

    const details = [
      `🧠 **${memory.metadata.name}**`,
      `${memory.metadata.description}`,
      ``,
      `**Status**: ${memory.getStatus()}`,
      `**Retention**: ${(memory.metadata as any).retentionDays || 'permanent'} days`,
      `**Tags**: ${(memory.metadata as any).tags?.join(', ') || 'none'}`,
      `**Storage Backend**: ${(memory.metadata as any).storageBackend || 'file'}`,
      `**Privacy Level**: ${(memory.metadata as any).privacyLevel || 'private'}`,
      ``,
      `**Content**:`,
      memory.content || 'No content stored'
    ];

    return {
      content: [{
        type: "text",
        text: details.join('\n')
      }]
    };
  }
}
