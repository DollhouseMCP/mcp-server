/**
 * Wizard Text Templates
 * 
 * Centralized configuration for all wizard text to support:
 * - Internationalization (i18n) in the future
 * - Consistent messaging across the application
 * - Easy updates without modifying business logic
 * - Template reusability
 */

export interface WizardTemplates {
  title: string;
  currentConfigHeader: string;
  steps: {
    userIdentity: WizardStep;
    githubIntegration: WizardStep;
    portfolioSync: WizardStep;
    displayPreferences: WizardStep;
  };
  instructions: {
    quick: string;
    detailed: string;
    skip: string;
  };
  footer: string;
}

export interface WizardStep {
  title: string;
  description: string;
  instructions: string[];
  currentValue: (value: any) => string;
}

/**
 * Default English templates
 */
export const defaultWizardTemplates: WizardTemplates = {
  title: '🧙 Configuration Wizard',
  currentConfigHeader: '📊 Current Configuration:',
  
  steps: {
    userIdentity: {
      title: '🎯 Step 1: User Identity',
      description: 'This tags your creations so you can find them later. Everything is saved locally on your computer.',
      instructions: [
        'To set a username: Say "Set my username to [your-name]"',
        'To stay anonymous: Say "I\'ll stay anonymous"',
      ],
      currentValue: (value) => value || '(not set - anonymous mode)',
    },
    
    githubIntegration: {
      title: '🔐 Step 2: GitHub Integration (Optional)',
      description: 'Connect to GitHub to share your creations and browse community content.',
      instructions: [
        'To connect GitHub: Say "Connect my GitHub account"',
        'To skip: Say "Skip GitHub for now"',
      ],
      currentValue: (value) => value ? 'Connected' : '(not connected)',
    },
    
    portfolioSync: {
      title: '🔄 Step 3: Portfolio Sync (Optional)',
      description: 'Automatically backup your creations to GitHub.',
      instructions: [
        'To enable: Say "Enable auto-sync"',
        'To keep manual: Say "I\'ll sync manually"',
      ],
      currentValue: (value) => value ? 'Enabled' : 'Manual',
    },
    
    displayPreferences: {
      title: '🎨 Step 4: Display Preferences',
      description: 'Customize how DollhouseMCP shows information.',
      instructions: [
        'To show active persona: Say "Show persona indicators"',
        'To keep minimal: Say "Use minimal display"',
      ],
      currentValue: (value) => value ? 'Enabled' : 'Minimal',
    },
  },
  
  instructions: {
    quick: '💡 **Quick Setup**: Say "Configure the basics" to set just username and GitHub',
    detailed: '📝 **Detailed Setup**: Say "Configure everything" to go through all options',
    skip: '⏭️ **Skip for Now**: Say "Skip wizard" to use anonymous mode',
  },
  
  footer: '✨ You can always change these settings later by saying "Open configuration wizard"',
};

/**
 * Friendly value replacements for null/undefined config values
 */
export const friendlyNullValues: Record<string, string> = {
  // User fields
  'user.username': '(not set - anonymous mode active)',
  'user.email': '(optional - not set)',
  'user.display_name': '(not set - will use username)',
  
  // GitHub fields
  'github.auth_token': '(not configured - GitHub features disabled)',
  'github.oauth_token': '(not authenticated)',
  'github.default_repository': '(not set - will use default)',
  'github.username': '(not connected)',
  
  // Portfolio sync fields
  'portfolio.sync_status.last_sync': '(never synced)',
  'portfolio.sync_status.last_push': '(never pushed)',
  'portfolio.sync_status.last_pull': '(never pulled)',
  'portfolio.repository_name': '(using default: dollhouse-portfolio)',
  
  // Collection submission
  'collection_submission.auto_submit': '(disabled)',
  
  // Indicator settings
  'indicator.custom_format': '(using default format)',
  
  // Default for any other null
  'default': '(not set)',
};

/**
 * Helper function to get wizard text in specified language
 * @param language - Language code (e.g., 'en', 'es', 'fr')
 * @returns Wizard templates for the specified language
 */
export function getWizardTemplates(language: string = 'en'): WizardTemplates {
  // For now, only English is supported
  // Future: Load from language-specific files
  switch (language) {
    case 'en':
    default:
      return defaultWizardTemplates;
  }
}

/**
 * Helper function to get friendly null value
 * @param path - Dot-notation path to the config field
 * @returns Friendly message for null value
 */
export function getFriendlyNullValue(path: string): string {
  return friendlyNullValues[path] || friendlyNullValues['default'];
}

/**
 * Template builder for wizard steps
 * Allows for dynamic construction of wizard content
 */
export class WizardTemplateBuilder {
  private templates: WizardTemplates;
  
  constructor(language: string = 'en') {
    this.templates = getWizardTemplates(language);
  }
  
  /**
   * Build the complete wizard text
   */
  buildWizardText(currentConfig: any): string {
    const parts: string[] = [
      this.templates.title,
      '',
      this.buildCurrentConfig(currentConfig),
      '',
      this.buildSteps(currentConfig),
      '',
      this.buildInstructions(),
      '',
      this.templates.footer,
    ];
    
    return parts.join('\n');
  }
  
  /**
   * Build current configuration section
   */
  private buildCurrentConfig(config: any): string {
    return `${this.templates.currentConfigHeader}
\`\`\`yaml
${this.formatConfigAsYaml(config)}
\`\`\``;
  }
  
  /**
   * Build all wizard steps
   */
  private buildSteps(config: any): string {
    const steps = [];
    
    // User Identity
    const userStep = this.templates.steps.userIdentity;
    steps.push(this.formatStep(userStep, config.user?.username));
    
    // GitHub Integration
    const githubStep = this.templates.steps.githubIntegration;
    steps.push(this.formatStep(githubStep, config.github?.auth_token));
    
    // Portfolio Sync
    const portfolioStep = this.templates.steps.portfolioSync;
    steps.push(this.formatStep(portfolioStep, config.portfolio?.auto_sync));
    
    // Display Preferences
    const displayStep = this.templates.steps.displayPreferences;
    steps.push(this.formatStep(displayStep, config.indicator?.enabled));
    
    return steps.join('\n\n');
  }
  
  /**
   * Format a single wizard step
   */
  private formatStep(step: WizardStep, currentValue: any): string {
    const lines = [
      step.title,
      step.description,
    ];
    
    for (const instruction of step.instructions) {
      lines.push(`- ${instruction}`);
    }
    
    lines.push(`- Current: ${step.currentValue(currentValue)}`);
    
    return lines.join('\n');
  }
  
  /**
   * Build instruction options
   */
  private buildInstructions(): string {
    return [
      this.templates.instructions.quick,
      this.templates.instructions.detailed,
      this.templates.instructions.skip,
    ].join('\n');
  }
  
  /**
   * Format config as YAML (stub - would use actual yaml library)
   */
  private formatConfigAsYaml(config: any): string {
    // This would use the actual yaml.dump with friendly values
    // For now, return a placeholder
    return 'user:\n  username: (not set)\n  email: (optional)';
  }
}