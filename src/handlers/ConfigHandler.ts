/**
 * Configuration handler for the dollhouse_config MCP tool
 * Provides unified interface for all configuration management operations
 */

import { ConfigManager } from '../config/ConfigManager.js';
import { SecureErrorHandler } from '../security/errorHandler.js';
import { getFriendlyNullValue } from '../config/wizardTemplates.js';
import {
  getSourcePriorityConfig,
  saveSourcePriorityConfig,
  validateSourcePriority,
  parseSourcePriorityOrder,
  getSourceDisplayName,
  DEFAULT_SOURCE_PRIORITY,
  type SourcePriorityConfig
} from '../config/sourcePriority.js';
// WizardTemplateBuilder imported for future full template migration
// import { WizardTemplateBuilder } from '../config/wizardTemplates.js';
import * as yaml from 'js-yaml';

export interface ConfigOperationOptions {
  action: 'get' | 'set' | 'reset' | 'export' | 'import' | 'wizard';
  setting?: string;
  value?: any;
  section?: string;
  format?: 'yaml' | 'json';
  data?: string;
}

export class ConfigHandler {
  private configManager: ConfigManager;
  
  constructor() {
    this.configManager = ConfigManager.getInstance();
  }
  
  /**
   * Handle configuration operations via the dollhouse_config tool
   * 
   * @param options - Configuration operation options
   * @param options.action - The action to perform (get, set, reset, export, import, wizard)
   * @param options.setting - Optional setting path for get/set operations
   * @param options.value - Optional value for set operations
   * @param options.section - Optional section for filtering
   * @param options.format - Optional format for export (yaml or json)
   * @param options.data - Optional data for import operations
   * @param indicator - Optional indicator string for persona context
   * @returns Promise resolving to content object with operation result
   * @async
   * 
   * @note The wizard action is async and will await the handleWizard method
   * @since v1.4.0 - handleWizard made async for better config fetching
   */
  async handleConfigOperation(options: ConfigOperationOptions, indicator: string = '') {
    try {
      await this.configManager.initialize();
      
      switch (options.action) {
        case 'get':
          return this.handleGet(options, indicator);
        
        case 'set':
          return this.handleSet(options, indicator);
        
        case 'reset':
          return this.handleReset(options, indicator);
        
        case 'export':
          return this.handleExport(options, indicator);
        
        case 'import':
          return this.handleImport(options, indicator);
        
        case 'wizard':
          return await this.handleWizard(indicator);
        
        default:
          return {
            content: [{
              type: "text",
              text: `${indicator}❌ Invalid action '${options.action}'.\n\n` +
                    `Valid actions: get, set, reset, export, import, wizard`
            }]
          };
      }
      
    } catch (error) {
      const sanitizedError = SecureErrorHandler.sanitizeError(error);
      return {
        content: [{
          type: "text",
          text: `${indicator}❌ Configuration operation failed: ${sanitizedError.message}`
        }]
      };
    }
  }
  
  private async handleGet(options: ConfigOperationOptions, indicator: string) {
    // Get a specific setting or all settings
    if (options.setting) {
      // Handle source_priority as a special case
      if (options.setting === 'source_priority' || options.setting === 'source.priority') {
        const config = getSourcePriorityConfig();
        return {
          content: [{
            type: "text",
            text: this.formatSourcePriorityConfig(config, indicator)
          }]
        };
      }

      const value = this.configManager.getSetting(options.setting);
      if (value === undefined) {
        return {
          content: [{
            type: "text",
            text: `${indicator}❌ Setting '${options.setting}' not found.\n\n` +
                  `Use \`dollhouse_config action: "get"\` to see all available settings.`
          }]
        };
      }

      return {
        content: [{
          type: "text",
          text: `${indicator}⚙️ **Configuration Setting**\n\n` +
                `**${options.setting}**: ${this.formatValue(value)}`
        }]
      };
    }

    // Get all settings - make them user-friendly
    const config = this.configManager.getConfig();
    const friendlyConfig = this.makeFriendlyConfig(config);

    // Add source_priority to the output if not already present
    if (!friendlyConfig.source_priority) {
      const sourcePriorityConfig = getSourcePriorityConfig();
      friendlyConfig.source_priority = {
        order: sourcePriorityConfig.priority,
        stop_on_first: sourcePriorityConfig.stopOnFirst,
        check_all_for_updates: sourcePriorityConfig.checkAllForUpdates,
        fallback_on_error: sourcePriorityConfig.fallbackOnError
      };
    }

    return {
      content: [{
        type: "text",
        text: `${indicator}⚙️ **DollhouseMCP Configuration**\n\n` +
              `\`\`\`yaml\n${yaml.dump(friendlyConfig, { lineWidth: -1 })}\`\`\``
      }]
    };
  }
  
  private async handleSet(options: ConfigOperationOptions, indicator: string) {
    // Set a configuration value
    if (!options.setting || options.value === undefined) {
      return {
        content: [{
          type: "text",
          text: `${indicator}❌ Both 'setting' and 'value' are required for set operation.\n\n` +
                `Example: \`dollhouse_config action: "set", setting: "sync.enabled", value: true\``
        }]
      };
    }

    // Handle source_priority settings
    if (options.setting.startsWith('source_priority') || options.setting.startsWith('source.priority')) {
      return await this.handleSourcePrioritySet(options, indicator);
    }

    // Type coercion for common string-to-type conversions
    let coercedValue = options.value;

    // Convert string booleans to actual booleans
    if (typeof coercedValue === 'string') {
      const lowerValue = coercedValue.toLowerCase();
      if (lowerValue === 'true') {
        coercedValue = true;
      } else if (lowerValue === 'false') {
        coercedValue = false;
      } else if (/^\d+$/.test(coercedValue)) {
        // Convert numeric strings to numbers
        const numValue = Number.parseInt(coercedValue, 10);
        if (!Number.isNaN(numValue)) {
          coercedValue = numValue;
        }
      }
    }

    await this.configManager.updateSetting(options.setting, coercedValue);

    return {
      content: [{
        type: "text",
        text: `${indicator}✅ **Configuration Updated**\n\n` +
              `**${options.setting}** set to: ${JSON.stringify(coercedValue, null, 2)}\n\n` +
              `Changes have been saved to the configuration file.`
      }]
    };
  }
  
  private async handleReset(options: ConfigOperationOptions, indicator: string) {
    // Reset configuration to defaults
    if (options.section) {
      // Handle source_priority reset
      if (options.section === 'source_priority' || options.section === 'source.priority') {
        await saveSourcePriorityConfig(DEFAULT_SOURCE_PRIORITY);
        return {
          content: [{
            type: "text",
            text: `${indicator}🔄 **Source Priority Reset**\n\n` +
                  `Source priority has been reset to default values:\n\n` +
                  this.formatSourcePriorityConfig(DEFAULT_SOURCE_PRIORITY, '')
          }]
        };
      }

      await this.configManager.resetConfig(options.section);
      return {
        content: [{
          type: "text",
          text: `${indicator}🔄 **Configuration Reset**\n\n` +
                `Section '${options.section}' has been reset to default values.`
        }]
      };
    }

    // Reset all configuration (including source_priority)
    await this.configManager.resetConfig();

    // Also reset source_priority to defaults
    await saveSourcePriorityConfig(DEFAULT_SOURCE_PRIORITY);

    return {
      content: [{
        type: "text",
        text: `${indicator}🔄 **Configuration Reset**\n\n` +
              `All settings have been reset to default values.\n\n` +
              `Note: User identity and GitHub authentication are preserved.`
      }]
    };
  }
  
  private async handleExport(options: ConfigOperationOptions, indicator: string) {
    // Export configuration
    const format = options.format || 'yaml';
    const exported = await this.configManager.exportConfig(format);
    
    return {
      content: [{
        type: "text",
        text: `${indicator}📤 **Configuration Export**\n\n` +
              `\`\`\`${format}\n${exported}\`\`\`\n\n` +
              `You can save this configuration and import it later.`
      }]
    };
  }
  
  private async handleImport(options: ConfigOperationOptions, indicator: string) {
    // Import configuration
    if (!options.data) {
      return {
        content: [{
          type: "text",
          text: `${indicator}❌ Configuration data is required for import.\n\n` +
                `Provide YAML or JSON configuration in the 'data' parameter.`
        }]
      };
    }
    
    await this.configManager.importConfig(options.data);
    
    return {
      content: [{
        type: "text",
        text: `${indicator}✅ **Configuration Imported**\n\n` +
              `Configuration has been successfully imported and saved.`
      }]
    };
  }
  
  /**
   * Handle the configuration wizard
   * @returns Promise with wizard interface content
   * @async
   */
  private async handleWizard(indicator: string) {
    // Get current configuration to show the user
    const config = this.configManager.getConfig();
    const friendlyConfig = this.makeFriendlyConfig(config);
    
    // Build wizard content using templates
    // Note: Template builder is imported for future use when we fully migrate to template system
    const wizardContent = `${indicator}🧙 **Configuration Wizard - Let's Set Up DollhouseMCP!**

I'll help you configure DollhouseMCP step by step. First, let me show you your current settings:

**📊 Current Configuration:**
\`\`\`yaml
${yaml.dump(friendlyConfig, { lineWidth: -1 })}
\`\`\`

**Now, let's configure your settings one by one!**

🎯 **Step 1: User Identity**
This tags your creations so you can find them later. Everything is saved locally on your computer.
- To set a username: Say "Set my username to [your-name]"
- To stay anonymous: Say "I'll stay anonymous"
- Current: ${friendlyConfig.user?.username || '(not set - anonymous mode)'}

🔐 **Step 2: GitHub Integration (Optional)**
Connect to GitHub to share your creations and browse community content.
- To connect GitHub: Say "Connect my GitHub account"
- To skip: Say "Skip GitHub for now"
- Current: ${friendlyConfig.github?.auth_token ? 'Connected' : '(not connected)'}

🔄 **Step 3: Portfolio Sync (Optional)**
Automatically backup your creations to GitHub.
- To enable: Say "Enable auto-sync"
- To keep manual: Say "I'll sync manually"
- Current: ${friendlyConfig.portfolio?.auto_sync ? 'Enabled' : 'Manual'}

🎨 **Step 4: Display Preferences**
Customize how DollhouseMCP shows information.
- To show active persona: Say "Show persona indicators"
- To keep minimal: Say "Use minimal display"
- Current: ${friendlyConfig.indicator?.enabled ? 'Enabled' : 'Minimal'}

💡 **Quick Setup**: Say "Configure the basics" to set just username and GitHub
📝 **Detailed Setup**: Say "Configure everything" to go through all options
⏭️ **Skip for Now**: Say "Skip wizard" to use anonymous mode

✨ You can always change these settings later by saying "Open configuration wizard"`;
    
    return {
      content: [{
        type: "text",
        text: wizardContent
      }]
    };
  }
  
  /**
   * Format a value for user-friendly display
   * Replaces null/undefined with helpful messages
   */
  private formatValue(value: any): string {
    if (value === null || value === undefined) {
      return "(not set)";
    }
    if (typeof value === 'string' && value.trim() === '') {
      return "(empty)";
    }
    return JSON.stringify(value, null, 2);
  }
  
  /**
   * Make configuration display user-friendly for non-technical users
   * Replaces null values with helpful explanations
   * Uses centralized friendly values for i18n support
   */
  private makeFriendlyConfig(config: any): any {
    const friendly = JSON.parse(JSON.stringify(config)); // Deep clone

    // Helper function to replace null values with friendly messages
    const replaceFriendlyValue = (obj: any, path: string = '') => {
      for (const key in obj) {
        const currentPath = path ? `${path}.${key}` : key;

        if (obj[key] === null) {
          obj[key] = getFriendlyNullValue(currentPath);
        } else if (typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
          replaceFriendlyValue(obj[key], currentPath);
        }
      }
    };

    // Apply friendly replacements
    replaceFriendlyValue(friendly);

    // Apply legacy manual replacements and defaults
    this.applyLegacyReplacements(friendly);

    return friendly;
  }

  /**
   * Apply legacy manual replacements for backward compatibility
   * Extracted to reduce cognitive complexity
   */
  private applyLegacyReplacements(friendly: any): void {
    // Legacy manual replacements for backward compatibility
    // (These will be removed once we fully migrate to template system)
    if (friendly.sync) {
      if (friendly.sync.last_sync === "(not set)") {
        friendly.sync.last_sync = "(never synced)";
      }
      if (friendly.sync.remote_url === "(not set)") {
        friendly.sync.remote_url = "(no remote repository)";
      }
    }

    // Display settings
    if (friendly.display) {
      // These are typically booleans, but handle nulls just in case
      if (friendly.display.show_persona_indicator === null) {
        friendly.display.show_persona_indicator = true; // Default value
      }
    }

    // Collection settings
    if (friendly.collection) {
      if (friendly.collection.auto_submit === null) {
        friendly.collection.auto_submit = false; // Default value
      }
      if (friendly.collection.last_cache_update === null) {
        friendly.collection.last_cache_update = "(cache not initialized)";
      }
    }

    // Wizard settings - show friendly status
    if (friendly.wizard) {
      friendly.wizard._status = this.getWizardStatusMessage(friendly.wizard);
    }
  }

  /**
   * Get friendly status message for wizard configuration
   * Extracted to reduce cognitive complexity
   */
  private getWizardStatusMessage(wizard: any): string {
    if (wizard.completed === false && wizard.dismissed === false) {
      return "⏳ Ready to run (not completed)";
    }
    if (wizard.completed === true) {
      return "✅ Completed";
    }
    if (wizard.dismissed === true) {
      return "⏭️ Dismissed";
    }
    return "";
  }

  /**
   * Format source priority configuration for display
   */
  private formatSourcePriorityConfig(config: SourcePriorityConfig, indicator: string): string {
    const orderDisplay = config.priority
      .map(s => getSourceDisplayName(s))
      .join(' → ');

    return `${indicator}🎯 **Source Priority Configuration**

**Search Order**: ${orderDisplay}

**Settings**:
- **Stop on First Match**: ${config.stopOnFirst ? 'Yes' : 'No'}
  ${config.stopOnFirst ? 'Search stops as soon as an element is found' : 'All sources are searched'}

- **Check All for Updates**: ${config.checkAllForUpdates ? 'Yes' : 'No'}
  ${config.checkAllForUpdates ? 'Always check all sources to find latest version' : 'Use first match for version'}

- **Fallback on Error**: ${config.fallbackOnError ? 'Yes' : 'No'}
  ${config.fallbackOnError ? 'Try next source if current source fails' : 'Stop on any error'}

**What This Means**:
When searching for elements, the system will check sources in this order:
${config.priority.map((s, i) => `${i + 1}. ${getSourceDisplayName(s)}`).join('\n')}

To change settings, use:
\`dollhouse_config action: "set", setting: "source_priority.order", value: ["local", "github", "collection"]\`
\`dollhouse_config action: "set", setting: "source_priority.stop_on_first", value: true\`
\`dollhouse_config action: "set", setting: "source_priority.check_all_for_updates", value: false\`
\`dollhouse_config action: "set", setting: "source_priority.fallback_on_error", value: true\``;
  }

  /**
   * Handle setting source priority configuration
   */
  private async handleSourcePrioritySet(options: ConfigOperationOptions, indicator: string) {
    const setting = options.setting!;
    let value = options.value;

    // Get current configuration
    const currentConfig = getSourcePriorityConfig();

    try {
      // Normalize setting path
      const settingPath = setting.replace('source.priority', 'source_priority');

      // Handle different source_priority settings
      if (settingPath === 'source_priority' || settingPath === 'source_priority.order') {
        // Parse and validate the new order
        const newOrder = parseSourcePriorityOrder(value);
        const newConfig: SourcePriorityConfig = {
          ...currentConfig,
          priority: newOrder
        };

        // Validate before saving
        const validation = validateSourcePriority(newConfig);
        if (!validation.isValid) {
          const errorList = validation.errors.map(e => `- ${e}`).join('\n');
          return {
            content: [{
              type: "text",
              text: `${indicator}❌ **Invalid Source Priority Configuration**\n\n` +
                    `Errors:\n${errorList}\n\n` +
                    `Valid sources: local, github, collection\n` +
                    `Example: ["local", "github", "collection"]`
            }]
          };
        }

        await saveSourcePriorityConfig(newConfig);

        return {
          content: [{
            type: "text",
            text: `${indicator}✅ **Source Priority Order Updated**\n\n` +
                  `New search order: ${newOrder.map(s => getSourceDisplayName(s)).join(' → ')}\n\n` +
                  `Changes have been saved to the configuration file.`
          }]
        };
      }

      // Handle boolean settings
      if (typeof value === 'string') {
        const lowerValue = value.toLowerCase();
        if (lowerValue === 'true') value = true;
        else if (lowerValue === 'false') value = false;
      }

      if (typeof value !== 'boolean') {
        return {
          content: [{
            type: "text",
            text: `${indicator}❌ **Invalid Value**\n\n` +
                  `Setting '${setting}' requires a boolean value (true or false).\n` +
                  `Received: ${JSON.stringify(value)}`
          }]
        };
      }

      // Update specific setting
      const newConfig: SourcePriorityConfig = { ...currentConfig };

      if (settingPath === 'source_priority.stop_on_first' || settingPath === 'source_priority.stopOnFirst') {
        newConfig.stopOnFirst = value;
      } else if (settingPath === 'source_priority.check_all_for_updates' || settingPath === 'source_priority.checkAllForUpdates') {
        newConfig.checkAllForUpdates = value;
      } else if (settingPath === 'source_priority.fallback_on_error' || settingPath === 'source_priority.fallbackOnError') {
        newConfig.fallbackOnError = value;
      } else {
        return {
          content: [{
            type: "text",
            text: `${indicator}❌ **Unknown Setting**\n\n` +
                  `Unknown source priority setting: ${setting}\n\n` +
                  `Valid settings:\n` +
                  `- source_priority.order\n` +
                  `- source_priority.stop_on_first\n` +
                  `- source_priority.check_all_for_updates\n` +
                  `- source_priority.fallback_on_error`
          }]
        };
      }

      await saveSourcePriorityConfig(newConfig);

      return {
        content: [{
          type: "text",
          text: `${indicator}✅ **Source Priority Setting Updated**\n\n` +
                `**${setting}** set to: ${value}\n\n` +
                `Changes have been saved to the configuration file.`
        }]
      };

    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `${indicator}❌ **Configuration Update Failed**\n\n` +
                `Error: ${error instanceof Error ? error.message : String(error)}\n\n` +
                `Please check your input and try again.`
        }]
      };
    }
  }
}