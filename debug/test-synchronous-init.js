#!/usr/bin/env node

/**
 * Test 1: Synchronous initialization approach
 * 
 * This modifies the DollhouseMCP server to use synchronous initialization
 * to see if the async pattern is causing Claude Desktop crashes.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const indexPath = path.join(__dirname, '..', 'src', 'index.ts');
const backupPath = path.join(__dirname, 'index.ts.backup');

// Create backup
console.log('Creating backup of index.ts...');
fs.copyFileSync(indexPath, backupPath);

// Read current content
let content = fs.readFileSync(indexPath, 'utf8');

// Add diagnostic logging at the very start
const diagnosticImport = `
// DIAGNOSTIC LOGGING FOR CLAUDE DESKTOP DEBUG
const DEBUG_LOG = (msg: string) => {
  const timestamp = new Date().toISOString();
  console.error(\`[DEBUG \${timestamp}] \${msg}\`);
  try {
    require('fs').appendFileSync(
      require('path').join(process.cwd(), 'mcp-debug.log'),
      \`[\${timestamp}] \${msg}\\n\`
    );
  } catch {}
};
DEBUG_LOG('=== MCP Server Starting ===');
DEBUG_LOG(\`Process: \${JSON.stringify({
  pid: process.pid,
  cwd: process.cwd(),
  argv: process.argv.slice(0, 3),
  execPath: process.execPath,
  node: process.version
})}\`);
`;

// Insert after imports
content = content.replace(
  /import { AgentManager } from '.\/elements\/agents\/AgentManager.js';\n\n/,
  `import { AgentManager } from './elements/agents/AgentManager.js';\n${diagnosticImport}\n`
);

// Add logging to constructor start
content = content.replace(
  'constructor() {',
  `constructor() {
    DEBUG_LOG('Constructor started');`
);

// Add logging before each major initialization
content = content.replace(
  'this.portfolioManager = PortfolioManager.getInstance();',
  `DEBUG_LOG('Initializing PortfolioManager...');
    this.portfolioManager = PortfolioManager.getInstance();
    DEBUG_LOG('PortfolioManager initialized');`
);

content = content.replace(
  'this.migrationManager = new MigrationManager(this.portfolioManager);',
  `DEBUG_LOG('Creating MigrationManager...');
    this.migrationManager = new MigrationManager(this.portfolioManager);
    DEBUG_LOG('MigrationManager created');`
);

// Make initialization synchronous - convert async method to sync
const syncInit = `
  private initializePortfolioSync(): void {
    DEBUG_LOG('Starting synchronous portfolio initialization');
    
    try {
      // Use sync fs methods
      const fs = require('fs');
      const path = require('path');
      
      // Check if migration is needed (sync version)
      const legacyDir = path.join(require('os').homedir(), '.dollhouse', 'personas');
      const needsMigration = fs.existsSync(legacyDir);
      
      DEBUG_LOG(\`Migration needed: \${needsMigration}\`);
      
      if (needsMigration) {
        // For now, skip migration in sync version
        DEBUG_LOG('Skipping migration in sync test');
      }
      
      // Ensure portfolio structure exists (sync)
      const portfolioDir = this.portfolioManager.getBaseDir();
      if (!fs.existsSync(portfolioDir)) {
        DEBUG_LOG(\`Creating portfolio directory: \${portfolioDir}\`);
        fs.mkdirSync(portfolioDir, { recursive: true });
      }
      
      // Create element directories
      const elementTypes = ['personas', 'skills', 'templates', 'agents', 'memories', 'ensembles'];
      for (const type of elementTypes) {
        const dir = path.join(portfolioDir, type);
        if (!fs.existsSync(dir)) {
          DEBUG_LOG(\`Creating directory: \${dir}\`);
          fs.mkdirSync(dir, { recursive: true });
        }
      }
      
      DEBUG_LOG('Portfolio initialization complete');
    } catch (error) {
      DEBUG_LOG(\`Portfolio initialization error: \${error}\`);
      console.error('[DollhouseMCP] Portfolio initialization failed:', error);
    }
  }`;

// Add the sync method after the async one
content = content.replace(
  /private async initializePortfolio\(\): Promise<void>[\s\S]*?^\s*}\n/m,
  `$&\n${syncInit}\n`
);

// Replace async initialization with sync
content = content.replace(
  `// Initialize portfolio and perform migration if needed
    this.initializePortfolio().then(() => {
      // NOW safe to access directories after migration
      this.personasDir = this.portfolioManager.getElementDir(ElementType.PERSONA);
      
      // Log resolved path for debugging
      logger.info(\`Personas directory resolved to: \${this.personasDir}\`);
      
      // Initialize PathValidator with the personas directory
      PathValidator.initialize(this.personasDir);
      
      // Initialize update manager with safe directory
      // Use the parent of personas directory to avoid production check
      const safeDir = path.dirname(this.personasDir);
      try {
        this.updateManager = new UpdateManager(safeDir);
      } catch (error) {
        console.error('[DollhouseMCP] Failed to initialize UpdateManager:', error);
        logger.error(\`Failed to initialize UpdateManager: \${error}\`);
        // Continue without update functionality
      }
      
      // Initialize import module that depends on personasDir
      this.personaImporter = new PersonaImporter(this.personasDir, this.currentUser);
      
      this.loadPersonas();
    }).catch(error => {
      // Don't use CRITICAL in the error message as it triggers Docker test failures
      console.error('[DollhouseMCP] Failed to initialize portfolio:', error);
      logger.error(\`Failed to initialize portfolio: \${error}\`);
    });`,
  `// Initialize portfolio synchronously
    DEBUG_LOG('Starting synchronous initialization');
    this.initializePortfolioSync();
    
    // NOW safe to access directories after migration
    this.personasDir = this.portfolioManager.getElementDir(ElementType.PERSONA);
    DEBUG_LOG(\`Personas directory set to: \${this.personasDir}\`);
    
    // Log resolved path for debugging
    logger.info(\`Personas directory resolved to: \${this.personasDir}\`);
    
    // Initialize PathValidator with the personas directory
    DEBUG_LOG('Initializing PathValidator...');
    PathValidator.initialize(this.personasDir);
    DEBUG_LOG('PathValidator initialized');
    
    // Initialize update manager with safe directory
    // Use the parent of personas directory to avoid production check
    const safeDir = path.dirname(this.personasDir);
    DEBUG_LOG(\`Initializing UpdateManager with safeDir: \${safeDir}\`);
    try {
      this.updateManager = new UpdateManager(safeDir);
      DEBUG_LOG('UpdateManager initialized successfully');
    } catch (error) {
      DEBUG_LOG(\`UpdateManager initialization failed: \${error}\`);
      console.error('[DollhouseMCP] Failed to initialize UpdateManager:', error);
      logger.error(\`Failed to initialize UpdateManager: \${error}\`);
      // Continue without update functionality
    }
    
    // Initialize import module that depends on personasDir
    DEBUG_LOG('Initializing PersonaImporter...');
    this.personaImporter = new PersonaImporter(this.personasDir, this.currentUser);
    DEBUG_LOG('PersonaImporter initialized');
    
    DEBUG_LOG('Loading personas...');
    this.loadPersonas();
    DEBUG_LOG('Constructor completed');`
);

// Write modified content
console.log('Writing modified index.ts with synchronous initialization...');
fs.writeFileSync(indexPath, content);

console.log(`
Synchronous initialization test prepared!

Changes made:
1. Added extensive DEBUG_LOG statements throughout
2. Created synchronous initializePortfolioSync() method
3. Replaced async initialization with sync version
4. All logs will be written to mcp-debug.log

To test:
1. npm run build
2. Configure Claude Desktop to use local build
3. Check mcp-debug.log for diagnostic output

To restore:
  cp ${backupPath} ${indexPath}
`);