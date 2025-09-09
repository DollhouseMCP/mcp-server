# Configuration Wizard Design Document

## Overview
Interactive configuration wizard for new DollhouseMCP installations that guides users through all configuration options and tracks completion/dismissal.

## Goals
1. Improve first-time user experience
2. Explain each configuration setting clearly
3. Allow users to make informed choices
4. Track wizard completion or dismissal
5. Never annoy users who've already seen it

## Wizard Flow

### 1. Detection Phase
```typescript
// Check if wizard should run
if (!config.wizard.completed && !config.wizard.dismissed) {
  // Offer wizard
}
```

### 2. Initial Prompt
```
Welcome to DollhouseMCP! 🎭

This appears to be your first time using DollhouseMCP.
Would you like a guided walkthrough of the configuration options?

[1] Yes, guide me through the configuration
[2] Skip for now (ask again next time)
[3] Don't show this again

Choice:
```

### 3. Configuration Sections

#### Section 1: User Identity
```
=== User Identity Configuration ===

Let's set up your identity for persona attribution.

Username (for persona credits): 
  Current: null
  Recommended: Your GitHub username
  > 

Email (optional, for notifications):
  Current: null
  > 

Display Name (how you appear in the community):
  Current: null
  > 
```

#### Section 2: GitHub Integration
```
=== GitHub Integration ===

DollhouseMCP can sync your personas with GitHub for backup and sharing.

Would you like to set up GitHub integration? [y/N]

GitHub Portfolio Repository:
  This will store your personal collection
  Format: username/repository-name
  Default: dollhouse-portfolio
  > 

Auto-create repository if it doesn't exist? [Y/n]

Use OAuth for authentication? [Y/n]
  (More secure than tokens, recommended)
```

#### Section 3: Sync Settings
```
=== Sync Settings ===

Control how your personas sync with GitHub.

Enable sync features? [y/N]
  (You can always enable later)

If yes:
- Require confirmation before sync? [Y/n]
- Show diff before syncing? [Y/n]
- Keep version history? [Y/n]
  - How many versions to keep? [10]

Privacy Settings:
- Scan for secrets before upload? [Y/n]
- Scan for PII (personal info)? [Y/n]
- Warn on sensitive content? [Y/n]
```

#### Section 4: Collection Settings
```
=== Collection Settings ===

The DollhouseMCP Collection is our community marketplace.

Auto-submit to collection when uploading? [y/N]
  (Each submission still needs approval)

Require review before submission? [Y/n]

Add attribution to your personas? [Y/n]
  (Adds your username to personas you create)
```

#### Section 5: Display Settings
```
=== Display Settings ===

How DollhouseMCP appears in your terminal.

Show persona indicators in responses? [Y/n]
  Style: [1] Full [2] Minimal [3] Compact [4] Custom
  Include emoji? [Y/n]

Enable verbose logging? [y/N]
Show progress indicators? [Y/n]
```

### 4. Summary & Confirmation
```
=== Configuration Summary ===

Here's what we'll set up:
✓ Username: mickdarling
✓ GitHub: mickdarling/dollhouse-portfolio
✓ Sync: Disabled (can enable later)
✓ Collection: Manual submission only
✓ Display: Minimal indicators with emoji

Save this configuration? [Y/n]
```

## Implementation Details

### New Config Schema Fields
```typescript
export interface WizardConfig {
  completed: boolean;      // Wizard was completed
  dismissed: boolean;      // User chose "Don't show again"
  completedAt?: string;    // ISO timestamp
  version: string;         // Wizard version (for updates)
  skippedSections?: string[]; // Sections user skipped
}

export interface DollhouseConfig {
  // ... existing fields ...
  wizard: WizardConfig;    // New wizard tracking
}
```

### ConfigWizard Class
```typescript
export class ConfigWizard {
  private configManager: ConfigManager;
  private readline: Interface;
  
  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
    this.readline = createInterface({
      input: process.stdin,
      output: process.stdout
    });
  }
  
  async shouldRunWizard(): Promise<boolean> {
    const config = this.configManager.getConfig();
    return !config.wizard?.completed && !config.wizard?.dismissed;
  }
  
  async runWizard(): Promise<void> {
    // Main wizard logic
  }
  
  private async promptUser(question: string, defaultValue?: string): Promise<string> {
    // Interactive prompt logic
  }
  
  private async showSection(section: ConfigSection): Promise<void> {
    // Display and handle each section
  }
  
  async markCompleted(): Promise<void> {
    await this.configManager.updateSetting('wizard.completed', true);
    await this.configManager.updateSetting('wizard.completedAt', new Date().toISOString());
    await this.configManager.updateSetting('wizard.version', WIZARD_VERSION);
  }
  
  async markDismissed(): Promise<void> {
    await this.configManager.updateSetting('wizard.dismissed', true);
  }
}
```

### Integration Points

#### 1. Main Server Initialization
```typescript
// In src/index.ts
async initialize() {
  await this.configManager.initialize();
  
  const wizard = new ConfigWizard(this.configManager);
  if (await wizard.shouldRunWizard()) {
    const runWizard = await wizard.promptInitial();
    if (runWizard === 'yes') {
      await wizard.runWizard();
    } else if (runWizard === 'never') {
      await wizard.markDismissed();
    }
    // 'skip' does nothing - will ask again next time
  }
  
  // Continue normal initialization
}
```

#### 2. MCP Tool Support
Create a new tool to re-run the wizard:
```typescript
{
  name: 'run_config_wizard',
  description: 'Run the configuration wizard',
  schema: {
    type: 'object',
    properties: {
      force: {
        type: 'boolean',
        description: 'Run even if already completed'
      }
    }
  }
}
```

## User Experience Considerations

### 1. Non-Intrusive
- Only shows on first run
- Easy to skip or dismiss
- Can be re-run manually

### 2. Educational
- Explains what each setting does
- Shows current values
- Provides recommendations

### 3. Progressive
- Can skip sections
- Can accept defaults
- Can return to wizard later

### 4. Smart Defaults
- Sensible defaults for all settings
- Privacy-first approach
- GitHub integration optional

## Testing Strategy

1. **New Installation Test**
   - Verify wizard appears on first run
   - Test all paths (complete, skip, dismiss)

2. **Existing Installation Test**
   - Verify wizard doesn't appear if completed
   - Verify wizard doesn't appear if dismissed

3. **Re-run Test**
   - Test manual wizard trigger
   - Test force flag

4. **Input Validation**
   - Test invalid inputs
   - Test edge cases

## Future Enhancements

1. **Wizard Updates**
   - Track wizard version
   - Show "What's New" for config updates
   - Re-run specific sections

2. **Profiles**
   - Save configuration profiles
   - Quick setup for common use cases

3. **Import/Export**
   - Import config from file
   - Share configurations

## Security Considerations

1. **No Sensitive Data in Prompts**
   - Never show tokens or secrets
   - Mask sensitive inputs

2. **Validation**
   - Validate all user inputs
   - Prevent injection attacks

3. **Safe Defaults**
   - Privacy-first settings
   - Opt-in for sharing features

## Success Metrics

1. **Completion Rate**
   - Track how many users complete wizard
   - Identify drop-off points

2. **Configuration Quality**
   - Users with wizard have better configs
   - Fewer support issues

3. **User Satisfaction**
   - Positive feedback on onboarding
   - Reduced confusion about settings