/**
 * ConfigWizard - Interactive configuration wizard for new DollhouseMCP installations
 * 
 * Features:
 * - Guided walkthrough of all configuration options
 * - Educational explanations for each setting
 * - Tracking of completion/dismissal status
 * - Non-intrusive first-run experience
 * - Re-runnable via MCP tool
 */

import * as readline from 'readline';
import { ConfigManager } from './ConfigManager.js';
import { logger } from '../utils/logger.js';
import chalk from 'chalk';
import { getPortfolioRepositoryName } from './portfolioConfig.js';

const WIZARD_VERSION = '1.0.0';

interface WizardChoice {
  value: string;
  label: string;
  isDefault?: boolean;
}

export class ConfigWizard {
  private configManager: ConfigManager;
  private rl: readline.Interface | null;
  private isInteractive: boolean;

  constructor(configManager: ConfigManager) {
    this.configManager = configManager;
    
    // Check if we're in an interactive terminal
    this.isInteractive = process.stdin.isTTY && process.stdout.isTTY;
    
    // Only create readline interface if interactive
    if (this.isInteractive) {
      this.rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true
      });
    } else {
      // No interface in non-interactive mode
      this.rl = null;
    }
  }

  /**
   * Check if the wizard should run
   */
  async shouldRunWizard(): Promise<boolean> {
    // Don't run in non-interactive environments (CI, automated scripts)
    if (!this.isInteractive) {
      return false;
    }

    const config = this.configManager.getConfig();
    return !config.wizard?.completed && !config.wizard?.dismissed;
  }

  /**
   * Show initial prompt to user
   */
  async promptInitial(): Promise<'yes' | 'skip' | 'never'> {
    console.log('\n' + chalk.cyan('═'.repeat(60)));
    console.log(chalk.cyan.bold('  Welcome to DollhouseMCP! 🎭'));
    console.log(chalk.cyan('═'.repeat(60)) + '\n');
    
    console.log(chalk.yellow('This appears to be your first time using DollhouseMCP.'));
    console.log('Would you like a guided walkthrough of the configuration options?\n');
    
    console.log(chalk.green('  [1]') + ' Yes, guide me through the configuration');
    console.log(chalk.yellow('  [2]') + ' Skip for now (ask again next time)');
    console.log(chalk.gray('  [3]') + ' Don\'t show this again\n');

    const choice = await this.prompt('Choice [1/2/3]: ', '2');
    
    switch (choice) {
      case '1':
        return 'yes';
      case '3':
        return 'never';
      default:
        return 'skip';
    }
  }

  /**
   * Run the full configuration wizard
   */
  async runWizard(): Promise<void> {
    console.log('\n' + chalk.cyan('Starting Configuration Wizard...'));
    console.log(chalk.gray('You can press Ctrl+C at any time to exit\n'));

    try {
      // Track skipped sections
      const skippedSections: string[] = [];

      // Section 1: User Identity
      const skipIdentity = await this.runUserIdentitySection();
      if (skipIdentity) skippedSections.push('user');

      // Section 2: GitHub Integration
      const skipGitHub = await this.runGitHubSection();
      if (skipGitHub) skippedSections.push('github');

      // Section 3: Sync Settings
      const skipSync = await this.runSyncSection();
      if (skipSync) skippedSections.push('sync');

      // Section 4: Collection Settings
      const skipCollection = await this.runCollectionSection();
      if (skipCollection) skippedSections.push('collection');

      // Section 5: Display Settings
      const skipDisplay = await this.runDisplaySection();
      if (skipDisplay) skippedSections.push('display');

      // Show summary and confirm
      await this.showSummary();
      
      const save = await this.promptYesNo('Save this configuration?', true);
      if (save) {
        await this.markCompleted(skippedSections);
        console.log(chalk.green('\n✅ Configuration saved successfully!'));
        console.log(chalk.gray('You can re-run this wizard anytime with the "run_config_wizard" tool.\n'));
      } else {
        console.log(chalk.yellow('\n⚠️  Configuration not saved. You can run the wizard again later.\n'));
      }

    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('canceled')) {
          console.log(chalk.yellow('\n⚠️  Wizard canceled. You can run it again later.\n'));
        } else if (error.message.includes('EACCES') || error.message.includes('permission')) {
          logger.error('Permission denied while saving configuration', { error });
          console.log(chalk.red('\n❌ Permission denied: Unable to save configuration.'));
          console.log(chalk.yellow('   Please check file permissions for ~/.dollhouse/config.yml\n'));
        } else if (error.message.includes('ENOSPC')) {
          logger.error('No space left on device', { error });
          console.log(chalk.red('\n❌ Disk full: Unable to save configuration.'));
          console.log(chalk.yellow('   Please free up some disk space and try again.\n'));
        } else if (error.message.includes('readline')) {
          logger.error('Terminal input error', { error });
          console.log(chalk.red('\n❌ Terminal error: Unable to read input.'));
          console.log(chalk.yellow('   Please ensure you\'re running in an interactive terminal.\n'));
        } else {
          logger.error('Unexpected error in configuration wizard', { error });
          console.log(chalk.red('\n❌ An unexpected error occurred.'));
          console.log(chalk.gray(`   Error: ${error.message}\n`));
        }
      } else {
        logger.error('Unknown error in configuration wizard', { error });
        console.log(chalk.red('\n❌ An unknown error occurred. Please try again later.\n'));
      }
    }
  }

  /**
   * User Identity Section
   */
  private async runUserIdentitySection(): Promise<boolean> {
    console.log('\n' + chalk.cyan.bold('=== User Identity Configuration ==='));
    console.log('Let\'s set up your identity for persona attribution.\n');

    const config = this.configManager.getConfig();
    
    // Username
    console.log(chalk.white('Username (for persona credits):'));
    console.log(chalk.gray(`  Current: ${config.user.username || 'not set'}`));
    console.log(chalk.gray('  Recommended: Your GitHub username'));
    const username = await this.prompt('  > ', config.user.username || '');
    if (username) {
      await this.configManager.updateSetting('user.username', username);
    }

    // Email with validation
    console.log(chalk.white('\nEmail (for Git commits and GitHub attribution):'));
    console.log(chalk.gray('  Used for: Git author info, GitHub commits, and element attribution'));
    console.log(chalk.gray(`  Current: ${config.user.email || 'not set'}`));
    console.log(chalk.gray('  Recommended: Your GitHub email address'));
    let email = await this.prompt('  > ', config.user.email || '');
    
    // Validate email if provided
    while (email && !this.isValidEmail(email)) {
      console.log(chalk.yellow('  ⚠️  Invalid email format. Please enter a valid email or leave empty to skip.'));
      email = await this.prompt('  > ', '');
    }
    
    if (email) {
      await this.configManager.updateSetting('user.email', email);
    }

    // Display Name
    console.log(chalk.white('\nDisplay Name (how you appear in the community):'));
    console.log(chalk.gray(`  Current: ${config.user.display_name || 'not set'}`));
    const displayName = await this.prompt('  > ', config.user.display_name || '');
    if (displayName) {
      await this.configManager.updateSetting('user.display_name', displayName);
    }

    return false; // Section not skipped
  }

  /**
   * GitHub Integration Section
   */
  private async runGitHubSection(): Promise<boolean> {
    console.log('\n' + chalk.cyan.bold('=== GitHub Integration ==='));
    console.log('DollhouseMCP can sync your personas with GitHub for backup and sharing.\n');

    const setupGitHub = await this.promptYesNo('Would you like to set up GitHub integration?', false);
    
    if (!setupGitHub) {
      console.log(chalk.gray('  Skipping GitHub setup. You can configure this later.\n'));
      return true; // Section skipped
    }

    const config = this.configManager.getConfig();

    // Repository name
    console.log(chalk.white('\nGitHub Portfolio Repository:'));
    console.log(chalk.gray('  This will store your personal collection'));
    console.log(chalk.gray('  Format: username/repository-name'));
    console.log(chalk.gray(`  Default: ${config.github.portfolio.repository_name}`));
    const repoName = await this.prompt('  > ', config.github.portfolio.repository_name);
    if (repoName) {
      await this.configManager.updateSetting('github.portfolio.repository_name', repoName);
    }

    // Auto-create repository
    const autoCreate = await this.promptYesNo('\nAuto-create repository if it doesn\'t exist?', true);
    await this.configManager.updateSetting('github.portfolio.auto_create', autoCreate);

    // OAuth authentication
    const useOAuth = await this.promptYesNo('\nUse OAuth for authentication? (More secure than tokens)', true);
    await this.configManager.updateSetting('github.auth.use_oauth', useOAuth);

    return false; // Section not skipped
  }

  /**
   * Sync Settings Section
   */
  private async runSyncSection(): Promise<boolean> {
    console.log('\n' + chalk.cyan.bold('=== Sync Settings ==='));
    console.log('Control how your personas sync with GitHub.\n');

    const enableSync = await this.promptYesNo('Enable sync features? (You can always enable later)', false);
    await this.configManager.updateSetting('sync.enabled', enableSync);

    if (!enableSync) {
      console.log(chalk.gray('  Sync disabled. You can enable it later in settings.\n'));
      return true; // Section skipped (partially)
    }

    // Individual sync settings
    console.log(chalk.white('\nIndividual Sync Settings:'));
    
    const requireConfirm = await this.promptYesNo('  Require confirmation before sync?', true);
    await this.configManager.updateSetting('sync.individual.require_confirmation', requireConfirm);

    const showDiff = await this.promptYesNo('  Show diff before syncing?', true);
    await this.configManager.updateSetting('sync.individual.show_diff_before_sync', showDiff);

    const trackVersions = await this.promptYesNo('  Keep version history?', true);
    await this.configManager.updateSetting('sync.individual.track_versions', trackVersions);

    if (trackVersions) {
      const historyCount = await this.prompt('    How many versions to keep? [10]: ', '10');
      await this.configManager.updateSetting('sync.individual.keep_history', Number.parseInt(historyCount) || 10);
    }

    // Privacy settings
    console.log(chalk.white('\nPrivacy Settings:'));
    
    const scanSecrets = await this.promptYesNo('  Scan for secrets before upload?', true);
    await this.configManager.updateSetting('sync.privacy.scan_for_secrets', scanSecrets);

    const scanPII = await this.promptYesNo('  Scan for PII (personal info)?', true);
    await this.configManager.updateSetting('sync.privacy.scan_for_pii', scanPII);

    const warnSensitive = await this.promptYesNo('  Warn on sensitive content?', true);
    await this.configManager.updateSetting('sync.privacy.warn_on_sensitive', warnSensitive);

    return false; // Section not skipped
  }

  /**
   * Collection Settings Section
   */
  private async runCollectionSection(): Promise<boolean> {
    console.log('\n' + chalk.cyan.bold('=== Collection Settings ==='));
    console.log('The DollhouseMCP Collection is our community marketplace.\n');

    const autoSubmit = await this.promptYesNo('Auto-submit to collection when uploading?', false);
    await this.configManager.updateSetting('collection.auto_submit', autoSubmit);

    const requireReview = await this.promptYesNo('Require review before submission?', true);
    await this.configManager.updateSetting('collection.require_review', requireReview);

    const addAttribution = await this.promptYesNo('Add attribution to your personas? (Adds your username)', true);
    await this.configManager.updateSetting('collection.add_attribution', addAttribution);

    return false; // Section not skipped
  }

  /**
   * Display Settings Section
   */
  private async runDisplaySection(): Promise<boolean> {
    console.log('\n' + chalk.cyan.bold('=== Display Settings ==='));
    console.log('How DollhouseMCP appears in your terminal.\n');

    const showIndicators = await this.promptYesNo('Show persona indicators in responses?', true);
    await this.configManager.updateSetting('display.persona_indicators.enabled', showIndicators);

    if (showIndicators) {
      console.log(chalk.white('\nIndicator Style:'));
      console.log('  [1] Full - Complete information');
      console.log('  [2] Minimal - Just the name');
      console.log('  [3] Compact - Name and version');
      console.log('  [4] Custom - Define your own format');
      
      const styleChoice = await this.prompt('  Choice [1-4]: ', '2');
      const styles = ['full', 'minimal', 'compact', 'custom'];
      const style = styles[Number.parseInt(styleChoice) - 1] || 'minimal';
      await this.configManager.updateSetting('display.persona_indicators.style', style);

      const includeEmoji = await this.promptYesNo('\n  Include emoji in indicators?', true);
      await this.configManager.updateSetting('display.persona_indicators.include_emoji', includeEmoji);
    }

    const verboseLogging = await this.promptYesNo('\nEnable verbose logging?', false);
    await this.configManager.updateSetting('display.verbose_logging', verboseLogging);

    const showProgress = await this.promptYesNo('Show progress indicators?', true);
    await this.configManager.updateSetting('display.show_progress', showProgress);

    return false; // Section not skipped
  }

  /**
   * Show configuration summary
   */
  private async showSummary(): Promise<void> {
    console.log('\n' + chalk.cyan.bold('=== Configuration Summary ==='));
    console.log('Here\'s what we\'ll set up:\n');

    const config = this.configManager.getConfig();

    // User
    if (config.user.username) {
      console.log(chalk.green('✓') + ` Username: ${config.user.username}`);
    }
    if (config.user.email) {
      console.log(chalk.green('✓') + ` Email: ${config.user.email}`);
    }

    // GitHub
    const defaultRepoName = getPortfolioRepositoryName();
    if (config.github.portfolio.repository_name !== defaultRepoName) {
      console.log(chalk.green('✓') + ` GitHub: ${config.github.portfolio.repository_name}`);
    }

    // Sync
    console.log(chalk.green('✓') + ` Sync: ${config.sync.enabled ? 'Enabled' : 'Disabled'}`);

    // Collection
    console.log(chalk.green('✓') + ` Collection: ${config.collection.auto_submit ? 'Auto-submit' : 'Manual submission'}`);

    // Display
    if (config.display.persona_indicators.enabled) {
      console.log(chalk.green('✓') + ` Display: ${config.display.persona_indicators.style} indicators` +
        (config.display.persona_indicators.include_emoji ? ' with emoji' : ''));
    }
  }

  /**
   * Mark wizard as completed
   */
  async markCompleted(skippedSections: string[] = []): Promise<void> {
    await this.configManager.updateSetting('wizard.completed', true);
    await this.configManager.updateSetting('wizard.completedAt', new Date().toISOString());
    await this.configManager.updateSetting('wizard.version', WIZARD_VERSION);
    if (skippedSections.length > 0) {
      await this.configManager.updateSetting('wizard.skippedSections', skippedSections);
    }
  }

  /**
   * Mark wizard as dismissed
   */
  async markDismissed(): Promise<void> {
    await this.configManager.updateSetting('wizard.dismissed', true);
  }

  /**
   * Helper: Prompt for user input
   */
  private prompt(question: string, defaultValue: string = ''): Promise<string> {
    return new Promise((resolve) => {
      if (!this.isInteractive || !this.rl) {
        resolve(defaultValue);
        return;
      }

      this.rl.question(question, (answer) => {
        resolve(answer || defaultValue);
      });
    });
  }

  /**
   * Helper: Prompt for yes/no
   */
  private async promptYesNo(question: string, defaultYes: boolean = true): Promise<boolean> {
    const hint = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = await this.prompt(`${question} ${hint}: `, defaultYes ? 'y' : 'n');
    return answer.toLowerCase().startsWith('y');
  }

  /**
   * Helper: Validate email format
   */
  private isValidEmail(email: string): boolean {
    // Basic email regex - not perfect but good enough for wizard validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  /**
   * Cleanup readline interface
   */
  close(): void {
    if (this.isInteractive && this.rl) {
      this.rl.close();
    }
  }
}