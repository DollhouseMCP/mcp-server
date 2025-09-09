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
   * Get the wizard prompt message - friendly for non-technical users
   */
  private getWizardPrompt(): string {
    return `🎨 **Welcome to DollhouseMCP!**

Hi there! I see this is your first time here. DollhouseMCP helps you create powerful customization elements for your AI assistant - and it's easier than you might think!

**What can you do with DollhouseMCP?**

🎭 **Personas** - Change your AI's personality (make it funny, professional, creative, or anything you imagine)
💡 **Skills** - Give your AI new abilities like taking meeting notes, reviewing code, or organizing your thoughts
📝 **Templates** - Create reusable formats for emails, documentation, resumes, and more
🤖 **Agents** - Build smart assistants that handle specific tasks automatically
✨ **And more!** - Just describe what you want, and DollhouseMCP will help you create it

The best part? Everything you create is saved and persistent. Your custom tools and assistants will be there whenever you need them. You can modify them anytime just by asking!

**Need ideas?** Just ask "What would be the best way to..." and I'll help you figure out the perfect solution.

**Ready to get started?** I'll help you:
- Choose a username (this tags your creations so you can find them later - or stay anonymous, that's totally fine!)
- Set up your workspace for saving all your customizations
- Browse examples to spark your creativity
- Create your first customization element

Just say:
- "Yes" or "Let's get started" → I'll guide you through setup
- "Skip for now" → You can set up later when you're ready
- "I'll stay anonymous" → Perfect! You can use everything without signing in

**What's a username for?** It simply tags your creations (like "created by: you") so you can find them easily. Staying anonymous means your creations are tagged with a fun random ID instead (like "created by: clever-fox"). Either way, all your work is saved locally on your computer!

Don't worry - this only takes a minute, and you can change any settings later! 🌟`;
  }

  /**
   * Wrap tool responses to check for wizard on first interaction
   * CRITICAL FIX: Create new response objects to avoid mutations
   */
  async wrapResponse(response: any): Promise<any> {
    const wizardPrompt = await this.checkIfWizardNeeded();
    
    if (!wizardPrompt) {
      return response;
    }

    // Always create new response objects to avoid mutation
    const wizardContent = {
      type: "text",
      text: wizardPrompt
    };

    const separator = {
      type: "text",
      text: "\n\n---\n\n"
    };

    // Handle different response formats
    if (response?.content && Array.isArray(response.content)) {
      // Create new response with spread to avoid mutation
      return {
        ...response,
        content: [wizardContent, separator, ...response.content]
      };
    } else if (typeof response === 'object' && response !== null) {
      // Handle non-standard response formats gracefully
      const originalText = response?.content?.[0]?.text || 
                          response?.text || 
                          response?.message || 
                          "Tool executed successfully";
      
      return {
        content: [
          wizardContent,
          separator,
          { type: "text", text: originalText }
        ]
      };
    } else {
      // Fallback for primitive responses (including null/undefined)
      const text = response == null ? "Tool executed successfully" : String(response);
      return {
        content: [
          wizardContent,
          separator,
          { type: "text", text }
        ]
      };
    }
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