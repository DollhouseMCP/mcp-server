#!/usr/bin/env node

/**
 * Standalone script to run the configuration wizard
 * Can be used for testing or manual configuration
 */

import { ConfigManager } from '../src/config/ConfigManager.js';
import { ConfigWizard } from '../src/config/ConfigWizard.js';
import chalk from 'chalk';

async function main() {
  try {
    // Initialize config manager
    const configManager = ConfigManager.getInstance();
    await configManager.initialize();

    // Create and run wizard
    const wizard = new ConfigWizard(configManager);

    // Check if we should force run (for testing)
    const forceRun = process.argv.includes('--force');

    if (forceRun || await wizard.shouldRunWizard()) {
      const choice = await wizard.promptInitial();
      
      if (choice === 'yes') {
        await wizard.runWizard();
      } else if (choice === 'never') {
        await wizard.markDismissed();
        console.log(chalk.gray('\nWizard dismissed. You can run it manually anytime.\n'));
      } else {
        console.log(chalk.gray('\nSkipped for now. The wizard will ask again next time.\n'));
      }
    } else {
      const config = configManager.getConfig();
      if (config.wizard?.completed) {
        console.log(chalk.green('\n✅ Configuration wizard already completed.'));
        console.log(chalk.gray('Use --force to run it again.\n'));
      } else if (config.wizard?.dismissed) {
        console.log(chalk.yellow('\n⚠️  Configuration wizard was previously dismissed.'));
        console.log(chalk.gray('Use --force to run it anyway.\n'));
      }
    }

    // Clean up
    wizard.close();
    process.exit(0);

  } catch (error) {
    console.error(chalk.red('\n❌ Error running configuration wizard:'), error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main as runConfigWizard };