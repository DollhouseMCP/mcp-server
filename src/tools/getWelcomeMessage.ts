/**
 * Get Welcome Message Tool
 * 
 * A dedicated MCP tool that returns the welcome message
 * This gives us more control over how the message is presented
 */

import { ConfigManager } from '../config/ConfigManager.js';

export interface GetWelcomeMessageOptions {
  format?: 'text' | 'markdown' | 'raw';
  skipCheck?: boolean;
}

export class GetWelcomeMessageTool {
  private configManager: ConfigManager;
  
  constructor() {
    this.configManager = ConfigManager.getInstance();
  }
  
  /**
   * Get the welcome message directly as a tool response
   * This bypasses the response wrapping and gives us full control
   */
  async execute(options: GetWelcomeMessageOptions = {}): Promise<any> {
    await this.configManager.initialize();
    const config = this.configManager.getConfig();
    
    // Check if we should show the welcome message
    if (!options.skipCheck) {
      if (config.wizard?.completed || config.wizard?.dismissed) {
        return {
          content: [{
            type: "text",
            text: "Welcome back to DollhouseMCP! The wizard has already been completed. Use 'Open configuration wizard' if you want to reconfigure."
          }]
        };
      }
    }
    
    const welcomeMessage = `🎨 **Welcome to DollhouseMCP!**

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
    
    // Return the message in the requested format
    if (options.format === 'raw') {
      // Just the text, no formatting
      return welcomeMessage;
    } else if (options.format === 'markdown') {
      // Return as markdown code block
      return {
        content: [{
          type: "text",
          text: "```markdown\n" + welcomeMessage + "\n```"
        }]
      };
    } else {
      // Default: Return as clean text with instruction
      return {
        content: [{
          type: "text",
          text: welcomeMessage
        }]
      };
    }
  }
  
  /**
   * Tool definition for MCP
   */
  static get definition() {
    return {
      name: "dollhouse_welcome",
      description: "Get the DollhouseMCP welcome message for first-time users",
      inputSchema: {
        type: "object",
        properties: {
          format: {
            type: "string",
            enum: ["text", "markdown", "raw"],
            description: "Format for the welcome message (default: text)"
          },
          skipCheck: {
            type: "boolean",
            description: "Skip checking if wizard was already completed (default: false)"
          }
        }
      }
    };
  }
}