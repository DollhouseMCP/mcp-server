#!/usr/bin/env node

/**
 * PersonaTools Migration Script
 * 
 * Automated migration utility to help users transition from deprecated PersonaTools
 * to the new ElementTools API. Scans user code for removed tool usage and provides
 * automated replacement suggestions.
 * 
 * @author Agent 8 [AGENT-8-MIGRATION-SCRIPT]
 * @date August 19, 2025
 * @related PR #637 - PersonaTools Removal
 */

import { promises as fs } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execAsync = promisify(exec);

// Migration mapping from removed PersonaTools to ElementTools equivalents
const TOOL_MIGRATIONS = {
    'list_personas': {
        replacement: 'list_elements',
        parameters: { type: 'persona' },
        description: 'Lists all persona elements using the unified ElementTools API'
    },
    'create_persona': {
        replacement: 'create_element',
        parameters: { type: 'persona' },
        description: 'Creates a new persona element using the unified ElementTools API'
    },
    'activate_persona': {
        replacement: 'activate_element',
        parameters: { type: 'persona' },
        description: 'Activates a persona element using the unified ElementTools API'
    },
    'get_active_persona': {
        replacement: 'get_active_element',
        parameters: { type: 'persona' },
        description: 'Gets the currently active persona element'
    },
    'deactivate_persona': {
        replacement: 'deactivate_element',
        parameters: { type: 'persona' },
        description: 'Deactivates the current persona element'
    },
    'get_persona_details': {
        replacement: 'get_element_details',
        parameters: { type: 'persona' },
        description: 'Gets detailed information about a persona element'
    },
    'reload_personas': {
        replacement: 'reload_elements',
        parameters: { type: 'persona' },
        description: 'Reloads persona elements from the filesystem'
    },
    'edit_persona': {
        replacement: 'edit_element',
        parameters: { type: 'persona' },
        description: 'Edits an existing persona element'
    },
    'validate_persona': {
        replacement: 'validate_element',
        parameters: { type: 'persona' },
        description: 'Validates a persona element structure and content'
    }
};

// Preserved tools that don't need migration
const PRESERVED_TOOLS = [
    'export_persona',
    'export_all_personas',
    'import_persona',
    'share_persona',
    'import_from_url'
];

class PersonaToolsMigrator {
    constructor(options = {}) {
        this.dryRun = options.dryRun || false;
        this.verbose = options.verbose || false;
        this.targetDir = options.targetDir || process.cwd();
        this.backupDir = path.join(this.targetDir, '.persona-tools-migration-backup');
        this.results = {
            filesScanned: 0,
            filesWithIssues: 0,
            totalIssues: 0,
            migrations: [],
            errors: []
        };
    }

    log(message, level = 'info') {
        if (this.verbose || level === 'error' || level === 'warn') {
            const prefix = {
                info: '📝',
                warn: '⚠️ ',
                error: '❌',
                success: '✅'
            }[level] || '📝';
            console.log(`${prefix} ${message}`);
        }
    }

    async scanDirectory(dir, extensions = ['.js', '.ts', '.jsx', '.tsx', '.json']) {
        const files = [];
        
        try {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                
                if (entry.isDirectory()) {
                    // Skip node_modules and other common directories
                    if (!['node_modules', '.git', 'dist', 'build', '.next'].includes(entry.name)) {
                        files.push(...await this.scanDirectory(fullPath, extensions));
                    }
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name);
                    if (extensions.includes(ext)) {
                        files.push(fullPath);
                    }
                }
            }
        } catch (error) {
            this.log(`Error scanning directory ${dir}: ${error.message}`, 'error');
            this.results.errors.push(`Directory scan error: ${dir} - ${error.message}`);
        }
        
        return files;
    }

    async analyzeFile(filePath) {
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const issues = [];
            
            // Check for removed tool usage in various patterns
            const patterns = [
                // Direct tool calls
                /callTool\s*\(\s*['"`]([^'"`]+)['"`]/g,
                // Tool name strings
                /['"`](list_personas|create_persona|activate_persona|get_active_persona|deactivate_persona|get_persona_details|reload_personas|edit_persona|validate_persona)['"`]/g,
                // MCP protocol tool references
                /tools?\s*:\s*\[.*?['"`]([^'"`]*persona[^'"`]*)['"`]/gs,
                // Configuration or examples
                /name\s*:\s*['"`](list_personas|create_persona|activate_persona|get_active_persona|deactivate_persona|get_persona_details|reload_personas|edit_persona|validate_persona)['"`]/g
            ];

            for (const pattern of patterns) {
                let match;
                while ((match = pattern.exec(content)) !== null) {
                    const toolName = match[1];
                    if (TOOL_MIGRATIONS[toolName]) {
                        const lineNumber = content.substring(0, match.index).split('\n').length;
                        const lineContent = content.split('\n')[lineNumber - 1];
                        
                        issues.push({
                            file: filePath,
                            line: lineNumber,
                            toolName: toolName,
                            lineContent: lineContent.trim(),
                            migration: TOOL_MIGRATIONS[toolName],
                            matchStart: match.index,
                            matchEnd: match.index + match[0].length
                        });
                    }
                }
            }

            // Check for preserved tools (informational)
            for (const preservedTool of PRESERVED_TOOLS) {
                const preservedPattern = new RegExp(`['"\`]${preservedTool}['"\`]`, 'g');
                let match;
                while ((match = preservedPattern.exec(content)) !== null) {
                    const lineNumber = content.substring(0, match.index).split('\n').length;
                    this.log(`File ${path.relative(this.targetDir, filePath)}:${lineNumber} - Found preserved tool '${preservedTool}' (no migration needed)`, 'info');
                }
            }

            this.results.filesScanned++;
            if (issues.length > 0) {
                this.results.filesWithIssues++;
                this.results.totalIssues += issues.length;
                this.results.migrations.push(...issues);
            }

            return issues;
        } catch (error) {
            this.log(`Error analyzing file ${filePath}: ${error.message}`, 'error');
            this.results.errors.push(`File analysis error: ${filePath} - ${error.message}`);
            return [];
        }
    }

    generateMigrationSuggestion(issue) {
        const { toolName, migration, lineContent } = issue;
        const { replacement, parameters, description } = migration;
        
        let suggestion = `Replace '${toolName}' with '${replacement}'`;
        
        if (parameters && Object.keys(parameters).length > 0) {
            const paramStr = Object.entries(parameters)
                .map(([key, value]) => `${key}: "${value}"`)
                .join(', ');
            suggestion += ` and add parameters: { ${paramStr} }`;
        }

        return {
            original: lineContent,
            suggestion: suggestion,
            description: description,
            exampleBefore: this.generateExampleBefore(toolName),
            exampleAfter: this.generateExampleAfter(replacement, parameters)
        };
    }

    generateExampleBefore(toolName) {
        const examples = {
            'list_personas': `await callTool('${toolName}', {})`,
            'create_persona': `await callTool('${toolName}', { name: 'My Persona', description: 'A helpful assistant' })`,
            'activate_persona': `await callTool('${toolName}', { personaId: 'persona-123' })`,
            'get_active_persona': `await callTool('${toolName}', {})`,
            'deactivate_persona': `await callTool('${toolName}', {})`,
            'get_persona_details': `await callTool('${toolName}', { personaId: 'persona-123' })`,
            'reload_personas': `await callTool('${toolName}', {})`,
            'edit_persona': `await callTool('${toolName}', { personaId: 'persona-123', name: 'Updated Name' })`,
            'validate_persona': `await callTool('${toolName}', { personaData: {...} })`
        };
        return examples[toolName] || `await callTool('${toolName}', {...})`;
    }

    generateExampleAfter(replacement, parameters) {
        const baseParams = parameters ? `, ${Object.entries(parameters).map(([k, v]) => `${k}: "${v}"`).join(', ')}` : '';
        
        const examples = {
            'list_elements': `await callTool('${replacement}', { type: "persona" })`,
            'create_element': `await callTool('${replacement}', { type: "persona", name: 'My Persona', description: 'A helpful assistant' })`,
            'activate_element': `await callTool('${replacement}', { type: "persona", elementId: 'persona-123' })`,
            'get_active_element': `await callTool('${replacement}', { type: "persona" })`,
            'deactivate_element': `await callTool('${replacement}', { type: "persona" })`,
            'get_element_details': `await callTool('${replacement}', { type: "persona", elementId: 'persona-123' })`,
            'reload_elements': `await callTool('${replacement}', { type: "persona" })`,
            'edit_element': `await callTool('${replacement}', { type: "persona", elementId: 'persona-123', name: 'Updated Name' })`,
            'validate_element': `await callTool('${replacement}', { type: "persona", elementData: {...} })`
        };
        return examples[replacement] || `await callTool('${replacement}', { type: "persona"${baseParams} })`;
    }

    async createBackup() {
        if (this.dryRun) {
            this.log('Dry run mode: Would create backup directory', 'info');
            return;
        }

        try {
            await fs.mkdir(this.backupDir, { recursive: true });
            this.log(`Created backup directory: ${this.backupDir}`, 'success');
            
            // Create a timestamp file
            const timestamp = new Date().toISOString();
            await fs.writeFile(
                path.join(this.backupDir, 'migration-timestamp.txt'),
                `PersonaTools migration backup created at: ${timestamp}\n`
            );
        } catch (error) {
            this.log(`Error creating backup directory: ${error.message}`, 'error');
            throw error;
        }
    }

    async generateReport() {
        const report = {
            summary: {
                filesScanned: this.results.filesScanned,
                filesWithIssues: this.results.filesWithIssues,
                totalIssues: this.results.totalIssues,
                errorsEncountered: this.results.errors.length
            },
            migrations: this.results.migrations.map(issue => ({
                file: path.relative(this.targetDir, issue.file),
                line: issue.line,
                toolName: issue.toolName,
                ...this.generateMigrationSuggestion(issue)
            })),
            errors: this.results.errors,
            timestamp: new Date().toISOString()
        };

        // Write detailed report
        const reportPath = path.join(this.targetDir, 'persona-tools-migration-report.json');
        await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
        this.log(`Detailed migration report saved to: ${reportPath}`, 'success');

        return report;
    }

    async generateMigrationGuide() {
        const guidePath = path.join(this.targetDir, 'PERSONA_TOOLS_MIGRATION_GUIDE.md');
        
        const guide = `# PersonaTools Migration Guide

This guide was automatically generated to help you migrate from deprecated PersonaTools to ElementTools.

## Summary

- **Files scanned**: ${this.results.filesScanned}
- **Files with issues**: ${this.results.filesWithIssues}
- **Total migrations needed**: ${this.results.totalIssues}

## Tool Migration Mapping

| Removed Tool | Replacement | Parameters | Description |
|--------------|-------------|------------|-------------|
${Object.entries(TOOL_MIGRATIONS).map(([old, migration]) => 
    `| \`${old}\` | \`${migration.replacement}\` | \`type: "persona"\` | ${migration.description} |`
).join('\n')}

## Preserved Tools (No Migration Needed)

The following tools are still available and don't require migration:
${PRESERVED_TOOLS.map(tool => `- \`${tool}\``).join('\n')}

## Migration Examples

### Before (Deprecated)
\`\`\`javascript
// List all personas
await callTool('list_personas', {});

// Create a new persona
await callTool('create_persona', {
    name: 'My Assistant',
    description: 'A helpful AI assistant'
});

// Activate a persona
await callTool('activate_persona', {
    personaId: 'persona-123'
});
\`\`\`

### After (ElementTools)
\`\`\`javascript
// List all personas using ElementTools
await callTool('list_elements', {
    type: 'persona'
});

// Create a new persona using ElementTools
await callTool('create_element', {
    type: 'persona',
    name: 'My Assistant',
    description: 'A helpful AI assistant'
});

// Activate a persona using ElementTools
await callTool('activate_element', {
    type: 'persona',
    elementId: 'persona-123'
});
\`\`\`

## Benefits of Migration

- **Unified API**: ElementTools provides a consistent interface for all element types
- **Better Performance**: Reduced tool count improves server performance
- **Future-Proof**: ElementTools is the recommended approach going forward
- **Enhanced Features**: Access to advanced element management capabilities

## Next Steps

1. Review the migration report: \`persona-tools-migration-report.json\`
2. Update your code using the suggestions above
3. Test your application thoroughly after migration
4. Remove any references to deprecated PersonaTools

For more detailed migration assistance, see the official documentation.

---
*Generated by PersonaTools Migration Script on ${new Date().toISOString()}*
`;

        if (!this.dryRun) {
            await fs.writeFile(guidePath, guide);
            this.log(`Migration guide saved to: ${guidePath}`, 'success');
        } else {
            this.log('Dry run mode: Would save migration guide', 'info');
        }

        return guide;
    }

    async run() {
        this.log(`Starting PersonaTools migration analysis...`, 'info');
        this.log(`Target directory: ${this.targetDir}`, 'info');
        this.log(`Mode: ${this.dryRun ? 'DRY RUN (no changes will be made)' : 'ANALYSIS ONLY'}`, 'info');

        try {
            // Create backup directory
            await this.createBackup();

            // Scan for files
            this.log('Scanning for relevant files...', 'info');
            const files = await this.scanDirectory(this.targetDir);
            this.log(`Found ${files.length} files to analyze`, 'info');

            // Analyze each file
            this.log('Analyzing files for PersonaTools usage...', 'info');
            for (const file of files) {
                const issues = await this.analyzeFile(file);
                if (issues.length > 0) {
                    this.log(`Found ${issues.length} issue(s) in ${path.relative(this.targetDir, file)}`, 'warn');
                }
            }

            // Generate reports
            this.log('Generating migration report...', 'info');
            const report = await this.generateReport();
            await this.generateMigrationGuide();

            // Summary
            this.log('\n📊 MIGRATION ANALYSIS COMPLETE', 'success');
            this.log(`Files scanned: ${report.summary.filesScanned}`, 'info');
            this.log(`Files with issues: ${report.summary.filesWithIssues}`, 'info');
            this.log(`Total migrations needed: ${report.summary.totalIssues}`, 'info');
            
            if (report.summary.errorsEncountered > 0) {
                this.log(`Errors encountered: ${report.summary.errorsEncountered}`, 'warn');
            }

            if (report.summary.totalIssues > 0) {
                this.log('\n🔧 NEXT STEPS:', 'info');
                this.log('1. Review the migration report: persona-tools-migration-report.json', 'info');
                this.log('2. Read the migration guide: PERSONA_TOOLS_MIGRATION_GUIDE.md', 'info');
                this.log('3. Update your code using ElementTools API', 'info');
                this.log('4. Test your application after migration', 'info');
            } else {
                this.log('\n✅ No PersonaTools usage found - no migration needed!', 'success');
            }

            return report;
        } catch (error) {
            this.log(`Migration analysis failed: ${error.message}`, 'error');
            throw error;
        }
    }
}

// CLI Interface
async function main() {
    const args = process.argv.slice(2);
    const options = {};

    // Parse command line arguments
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        switch (arg) {
            case '--dry-run':
                options.dryRun = true;
                break;
            case '--verbose':
            case '-v':
                options.verbose = true;
                break;
            case '--target':
            case '-t':
                options.targetDir = args[++i];
                break;
            case '--help':
            case '-h':
                console.log(`
PersonaTools Migration Script

Usage: node migrate-persona-tools.js [options]

Options:
  --dry-run         Analyze only, don't create backup or modify files
  --verbose, -v     Enable verbose logging
  --target, -t      Target directory to scan (default: current directory)
  --help, -h        Show this help message

Examples:
  node migrate-persona-tools.js --dry-run
  node migrate-persona-tools.js --target ./my-project --verbose
  node migrate-persona-tools.js --dry-run --verbose

This script scans your code for deprecated PersonaTools usage and provides
migration suggestions for moving to the new ElementTools API.
`);
                process.exit(0);
                break;
            default:
                console.error(`Unknown option: ${arg}`);
                process.exit(1);
        }
    }

    try {
        const migrator = new PersonaToolsMigrator(options);
        await migrator.run();
    } catch (error) {
        console.error(`❌ Migration script failed: ${error.message}`);
        process.exit(1);
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(error => {
        console.error(`❌ Unexpected error: ${error.message}`);
        process.exit(1);
    });
}

export { PersonaToolsMigrator, TOOL_MIGRATIONS, PRESERVED_TOOLS };