/**
 * ConfigWizardCheck - Handles checking if the configuration wizard should run
 * on first interaction with the MCP server
 */

import { ConfigManager } from './ConfigManager.js';
import { logger } from '../utils/logger.js';

export class ConfigWizardCheck {
  private hasCheckedWizard: boolean = false;
  private configManager: ConfigManager;

  constructor() {
    this.configManager = ConfigManager.getInstance();
  }

  /**
   * Check if configuration wizard should run on first interaction
   * Returns a prompt message if wizard should run, null otherwise
   */
  async checkIfWizardNeeded(): Promise<string | null> {
    // Only check once per session
    if (this.hasCheckedWizard) {
      return null;
    }
    
    this.hasCheckedWizard = true;
    
    try {
      // Initialize config if not already done
      await this.configManager.initialize();
      const config = this.configManager.getConfig();
      
      // Check if wizard has been completed or dismissed
      if (config.wizard?.completed || config.wizard?.dismissed) {
        return null;
      }
      
      // Wizard should run - return a prompt for the LLM
      return this.getWizardPrompt();
      
    } catch (error) {
      logger.error('Error checking config wizard status', { error });
      return null;
    }
  }

  /**
   * Get the wizard prompt message
   */
  private getWizardPrompt(): string {
    return `🎯 **Welcome to DollhouseMCP!**

I notice this is your first time using DollhouseMCP. Would you like me to help you set up your configuration?

I can guide you through:
- Setting up your user identity for element attribution
- Configuring GitHub integration for portfolio sync
- Customizing privacy and sync settings
- Setting display preferences

To get started, just say "yes" or "let's configure DollhouseMCP". 

You can also skip this by saying "skip for now" or dismiss it permanently with "don't show this again".`;
  }

  /**
   * Wrap tool responses to check for wizard on first interaction
   */
  async wrapResponse(response: any): Promise<any> {
    const wizardPrompt = await this.checkIfWizardNeeded();
    
    if (wizardPrompt) {
      // Prepend wizard prompt to the response
      if (response?.content && Array.isArray(response.content)) {
        response.content.unshift({
          type: "text",
          text: wizardPrompt + "\n\n---\n\n"
        });
      } else if (typeof response === 'object') {
        // Create a new response with wizard prompt
        return {
          content: [
            {
              type: "text",
              text: wizardPrompt
            },
            {
              type: "text", 
              text: "\n\n---\n\n" + (response?.content?.[0]?.text || JSON.stringify(response))
            }
          ]
        };
      }
    }
    
    return response;
  }

  /**
   * Mark wizard as completed
   */
  async markWizardCompleted(): Promise<void> {
    await this.configManager.updateSetting('wizard.completed', true);
    await this.configManager.updateSetting('wizard.completedAt', new Date().toISOString());
  }

  /**
   * Mark wizard as dismissed
   */
  async markWizardDismissed(): Promise<void> {
    await this.configManager.updateSetting('wizard.dismissed', true);
  }
}