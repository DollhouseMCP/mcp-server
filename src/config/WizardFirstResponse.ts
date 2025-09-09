/**
 * WizardFirstResponse - Alternative approach to wizard display
 * 
 * Instead of prepending the wizard to tool responses, return ONLY
 * the wizard message on first interaction, then handle the actual
 * tool request separately.
 */

export class WizardFirstResponse {
  /**
   * Create a standalone wizard response that takes over the entire response
   * This prevents the LLM from mixing it with other content
   */
  static createStandaloneWizardResponse(): any {
    const wizardMessage = `🎨 **Welcome to DollhouseMCP!**

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

Don't worry - this only takes a minute, and you can change any settings later! 🌟

---

*After you respond to this welcome message, I'll also complete your original request.*`;

    return {
      content: [{
        type: "text",
        text: wizardMessage
      }],
      metadata: {
        isWizard: true,
        requiresResponse: true,
        originalToolPending: true
      }
    };
  }
  
  /**
   * Create a response that's explicitly marked as system content
   * Some LLMs respect system-level content differently
   */
  static createSystemWizardResponse(): any {
    return {
      role: "system",
      content: this.getWizardMessage(),
      displayMode: "verbatim"
    };
  }
  
  /**
   * Try returning multiple content blocks to prevent merging
   */
  static createMultiBlockResponse(): any {
    const lines = this.getWizardMessage().split('\n\n');
    
    return {
      content: lines.map(line => ({
        type: "text",
        text: line,
        preserve: true,
        noSummarize: true
      }))
    };
  }
  
  private static getWizardMessage(): string {
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
}