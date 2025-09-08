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
          return this.handleWizard(indicator);
        
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
                `**${options.setting}**: ${JSON.stringify(value, null, 2)}`
        }]
      };
    }
    
    // Get all settings
    const config = this.configManager.getConfig();
    return {
      content: [{
        type: "text",
        text: `${indicator}⚙️ **DollhouseMCP Configuration**\n\n` +
              `\`\`\`yaml\n${yaml.dump(config, { lineWidth: -1 })}\`\`\``
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
  
  private handleWizard(indicator: string) {
    // Interactive configuration wizard
    return {
      content: [{
        type: "text",
        text: `${indicator}🧙 **Configuration Wizard**\n\n` +
              `The configuration wizard helps you set up DollhouseMCP.\n\n` +
              `**Key Settings to Configure:**\n\n` +
              `1. **User Identity**\n` +
              `   \`dollhouse_config action: "set", setting: "user.username", value: "your-username"\`\n\n` +
              `2. **GitHub Portfolio**\n` +
              `   \`dollhouse_config action: "set", setting: "github.portfolio.repository_name", value: "dollhouse-portfolio"\`\n\n` +
              `3. **Sync Settings**\n` +
              `   \`dollhouse_config action: "set", setting: "sync.enabled", value: true\`\n` +
              `   \`dollhouse_config action: "set", setting: "sync.bulk.upload_enabled", value: true\`\n\n` +
              `4. **Privacy Settings**\n` +
              `   \`dollhouse_config action: "set", setting: "sync.privacy.scan_for_secrets", value: true\`\n` +
              `   \`dollhouse_config action: "set", setting: "sync.privacy.respect_local_only", value: true\`\n\n` +
              `Run \`dollhouse_config action: "get"\` to see current settings.`
      }]
    };
  }
}