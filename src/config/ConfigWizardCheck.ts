/**
 * ConfigWizardCheck - Handles checking if the configuration wizard should run
 * on first interaction with the MCP server
 */

import { ConfigManager } from './ConfigManager.js';
import { ConfigWizardDisplay } from './ConfigWizardDisplay.js';
import { logger } from '../utils/logger.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export class ConfigWizardCheck {
  private hasCheckedWizard: boolean = false;
  private configManager: ConfigManager;
  private currentVersion: string;
  private displayStrategy: string;

  constructor() {
    this.configManager = ConfigManager.getInstance();
    this.currentVersion = this.getCurrentVersion();
    // Allow configuration of display strategy via environment variable
    // Options: codeblock, instructions, system, blockquote, combined
    this.displayStrategy = process.env.DOLLHOUSE_WIZARD_DISPLAY || 'codeblock';
  }
  
  /**
   * Get the current version from package.json
   */
  private getCurrentVersion(): string {
    try {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = dirname(__filename);
      const packagePath = join(__dirname, '..', '..', 'package.json');
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'));
      return packageJson.version;
    } catch (error) {
      logger.warn('Could not read package.json version', { error });
      return '0.0.0';
    }
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
      
      // Check if this is a first-time user
      if (!config.wizard?.completed && !config.wizard?.dismissed) {
        // First time user - show welcome wizard
        return this.getWizardPrompt();
      }
      
      // Check if we should show update wizard for existing users
      if (config.wizard?.completed && this.shouldShowUpdateWizard(config.wizard?.lastSeenVersion)) {
        // Update the last seen version
        await this.configManager.updateSetting('wizard.lastSeenVersion', this.currentVersion);
        return this.getUpdateWizardPrompt();
      }
      
      return null;
      
    } catch (error) {
      logger.error('Error checking config wizard status', { error });
      return null;
    }
  }
  
  /**
   * Determine if we should show the update wizard based on version changes
   * This logic can be updated with each release to trigger when needed
   */
  private shouldShowUpdateWizard(lastSeenVersion?: string): boolean {
    // If no last seen version, they've never seen an update wizard
    if (!lastSeenVersion) {
      return false; // Don't show update to very old users who haven't seen versioning yet
    }
    
    // DEPLOYMENT NOTE: Update this logic when you want to trigger the wizard
    // Examples:
    // - For emergency notifications: return true;
    // - For major features: return this.currentVersion >= '1.8.0' && lastSeenVersion < '1.8.0';
    // - For breaking changes: return this.currentVersion.startsWith('2.') && lastSeenVersion.startsWith('1.');
    
    // Currently: Don't trigger update wizard (can be changed in any release)
    return false;
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
   * Get the update wizard prompt for returning users
   * This can be customized for each release that needs to notify users
   */
  private getUpdateWizardPrompt(): string {
    // This template can be customized for each release
    return `🎉 **DollhouseMCP Has New Features!**

Welcome back! We've added some exciting new capabilities since you last used DollhouseMCP.

**What's New:**
- Enhanced configuration options
- Improved user experience
- Better performance

Would you like me to show you what's new, or would you prefer to explore on your own?

Just say:
- "Show me what's new" → I'll guide you through the updates
- "Skip for now" → Continue with your work

You can always ask "What's new in DollhouseMCP?" later to see this again.`;
  }

  /**
   * Wrap tool responses to check for wizard on first interaction
   * CRITICAL FIX: Create new response objects to avoid mutations
   * 
   * @param response - The tool response to potentially wrap
   * @param toolName - The name of the tool being called (for future use)
   */
  async wrapResponse(response: any, toolName?: string): Promise<any> {
    // Wizard should appear on ANY first tool interaction
    // This includes harmless tools like get_build_info which are
    // a great non-threatening entry point for new users
    
    const wizardPrompt = await this.checkIfWizardNeeded();
    
    if (!wizardPrompt) {
      return response;
    }

    // Use display strategy to encourage verbatim display
    let formattedWizard: string;
    
    switch (this.displayStrategy) {
      case 'instructions':
        formattedWizard = ConfigWizardDisplay.withDisplayInstructions(wizardPrompt);
        break;
      case 'system':
        formattedWizard = ConfigWizardDisplay.asSystemNotice(wizardPrompt);
        break;
      case 'blockquote':
        formattedWizard = ConfigWizardDisplay.asBlockquote(wizardPrompt);
        break;
      case 'combined':
        formattedWizard = ConfigWizardDisplay.combined(wizardPrompt);
        break;
      case 'codeblock':
      default:
        formattedWizard = ConfigWizardDisplay.asCodeBlock(wizardPrompt, 'text');
        break;
    }
    
    // Always create new response objects to avoid mutation
    const wizardContent = {
      type: "text",
      text: formattedWizard
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
    await this.configManager.updateSetting('wizard.lastSeenVersion', this.currentVersion);
  }

  /**
   * Mark wizard as dismissed
   */
  async markWizardDismissed(): Promise<void> {
    await this.configManager.updateSetting('wizard.dismissed', true);
  }
}