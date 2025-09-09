/**
 * Configuration handler for the dollhouse_config MCP tool
 * Provides unified interface for all configuration management operations
 */

import { ConfigManager } from '../config/ConfigManager.js';
import { SecureErrorHandler } from '../security/errorHandler.js';
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
        const numValue = parseInt(coercedValue, 10);
        if (!isNaN(numValue)) {
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
      await this.configManager.resetConfig(options.section);
      return {
        content: [{
          type: "text",
          text: `${indicator}🔄 **Configuration Reset**\n\n` +
                `Section '${options.section}' has been reset to default values.`
        }]
      };
    }
    
    // Reset all configuration
    await this.configManager.resetConfig();
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
  
  private async handleWizard(indicator: string) {
    // Get current configuration to show the user
    const config = this.configManager.getConfig();
    const friendlyConfig = this.makeFriendlyConfig(config);
    
    return {
      content: [{
        type: "text",
        text: `${indicator}🧙 **Configuration Wizard - Let's Set Up DollhouseMCP!**\n\n` +
              `I'll help you configure DollhouseMCP step by step. First, let me show you your current settings:\n\n` +
              `**📊 Current Configuration:**\n` +
              `\`\`\`yaml\n${yaml.dump(friendlyConfig, { lineWidth: -1 })}\`\`\`\n\n` +
              `**Now, let's configure your settings one by one!**\n\n` +
              `🎯 **Step 1: User Identity**\n` +
              `This tags your creations so you can find them later.\n` +
              `- To set a username: Say "Set my username to [your-name]"\n` +
              `- To stay anonymous: Say "I'll stay anonymous"\n` +
              `- Current: ${friendlyConfig.user?.username || '(not set - anonymous mode)'}\n\n` +
              `📧 **Step 2: Email (Optional)**\n` +
              `Only needed if you want to be contacted about your shared creations.\n` +
              `- To add email: Say "Set my email to [your-email]"\n` +
              `- To skip: Say "No email needed"\n` +
              `- Current: ${friendlyConfig.user?.email || '(not set)'}\n\n` +
              `🐙 **Step 3: GitHub Integration (Optional)**\n` +
              `Connect GitHub to sync and share your creations.\n` +
              `- To connect: Say "Help me connect to GitHub"\n` +
              `- To skip: Say "Skip GitHub for now"\n` +
              `- Current: ${friendlyConfig.github?.username || '(not connected)'}\n\n` +
              `🔄 **Step 4: Auto-Sync (Optional)**\n` +
              `Automatically sync your creations to GitHub.\n` +
              `- To enable: Say "Enable auto-sync"\n` +
              `- To disable: Say "Keep sync manual"\n` +
              `- Current: ${friendlyConfig.sync?.enabled ? 'Enabled' : 'Disabled'}\n\n` +
              `🎨 **Step 5: Display Preferences**\n` +
              `Show which persona is active in your chat.\n` +
              `- To show indicators: Say "Show persona indicators"\n` +
              `- To hide them: Say "Hide persona indicators"\n` +
              `- Current: ${friendlyConfig.display?.show_persona_indicator ? 'Showing' : 'Hidden'}\n\n` +
              `**Ready?** Just tell me what you'd like to configure, or say:\n` +
              `- "Configure everything" to go through all settings\n` +
              `- "Just the basics" for minimal setup\n` +
              `- "Skip wizard" if you're happy with current settings\n\n` +
              `Remember: All your creations are saved locally on your computer, and you can change these settings anytime!`
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
   */
  private makeFriendlyConfig(config: any): any {
    const friendly = JSON.parse(JSON.stringify(config)); // Deep clone
    
    // User settings
    if (friendly.user) {
      if (friendly.user.username === null) {
        friendly.user.username = "(not set - anonymous mode active)";
      }
      if (friendly.user.email === null) {
        friendly.user.email = "(optional - not set)";
      }
      if (friendly.user.display_name === null) {
        friendly.user.display_name = "(not set - will use username)";
      }
    }
    
    // GitHub settings
    if (friendly.github) {
      if (friendly.github.username === null) {
        friendly.github.username = "(not connected to GitHub)";
      }
      if (friendly.github.portfolio_repo === null) {
        friendly.github.portfolio_repo = "(no portfolio repository configured)";
      }
      if (friendly.github.oauth_client_id === null) {
        friendly.github.oauth_client_id = "(OAuth not configured)";
      }
      if (friendly.github.auth_token === null) {
        friendly.github.auth_token = "(not authenticated)";
      }
    }
    
    // Sync settings
    if (friendly.sync) {
      if (friendly.sync.last_sync === null) {
        friendly.sync.last_sync = "(never synced)";
      }
      if (friendly.sync.remote_url === null) {
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
      if (friendly.wizard.completed === false && friendly.wizard.dismissed === false) {
        friendly.wizard._status = "⏳ Ready to run (not completed)";
      } else if (friendly.wizard.completed === true) {
        friendly.wizard._status = "✅ Completed";
      } else if (friendly.wizard.dismissed === true) {
        friendly.wizard._status = "⏭️ Dismissed";
      }
    }
    
    return friendly;
  }
}