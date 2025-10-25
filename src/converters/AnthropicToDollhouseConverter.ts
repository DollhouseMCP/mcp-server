/**
 * AnthropicToDollhouseConverter - Converts multi-file Anthropic Skills to single-file DollhouseMCP skills
 *
 * This is the INVERSE of DollhouseToAnthropicConverter.
 *
 * Implements the reverse transformation:
 * Anthropic Skill (directory with separated components) → DollhouseMCP Skill (single .md file)
 *
 * Algorithm (inverse of decomposition):
 * 1. Read SKILL.md and extract minimal YAML frontmatter
 * 2. Enrich YAML with DollhouseMCP fields (version, created, modified, tags, etc.)
 * 3. Read all scripts/ files and embed as code blocks
 * 4. Read all reference/ files and embed as documentation sections
 * 5. Read all examples/ files and embed as example sections
 * 6. Read all themes/ files and embed as templates
 * 7. Combine all content into single .md file with rich frontmatter
 * 8. Return single-file content
 *
 * SECURITY MODEL:
 * - This is a FORMAT TRANSFORMER, not a security boundary
 * - Preserves content fidelity - no modification, sanitization, or validation during conversion
 * - YAML parsing uses CORE_SCHEMA to prevent deserialization attacks only
 * - Output validation happens when user loads skill via SkillManager.load()
 * - SkillManager.load() applies SecureYamlParser and full security validation
 * - Converted skills must pass DollhouseMCP security checks before activation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { SchemaMapper, type AnthropicSkillMetadata, type DollhouseMCPSkillMetadata } from './SchemaMapper.js';
import type { AnthropicSkillStructure } from './DollhouseToAnthropicConverter.js';

export interface AnthropicSkillDirectory {
    skillMD: {
        metadata: AnthropicSkillMetadata;
        content: string;
    };
    scripts: Map<string, { content: string; language: string }>;
    reference: Map<string, string>;
    examples: Map<string, string>;
    themes: Map<string, string>;
    metadata?: Map<string, string>;
    license?: string;
}

export class AnthropicToDollhouseConverter {
    private readonly schemaMapper: SchemaMapper;

    constructor() {
        this.schemaMapper = new SchemaMapper();
    }

    /**
     * Convert an Anthropic Skill directory to a single DollhouseMCP skill file
     *
     * INVERSE ALGORITHM:
     * 1. Read SKILL.md and extract minimal YAML
     * 2. Enrich YAML with DollhouseMCP fields
     * 3. Read all scripts/ files and embed as code blocks
     * 4. Read all reference/ files and embed as documentation sections
     * 5. Read all examples/ files and embed as example sections
     * 6. Read all themes/ files and embed as templates
     * 7. Combine all content into single .md file
     * 8. Return single-file content
     */
    async convertSkill(skillDirPath: string, options?: {
        preserveSource?: boolean;
        customMetadata?: Partial<DollhouseMCPSkillMetadata>;
    }): Promise<string> {
        // Step 1: Read the Anthropic skill directory structure
        // NOTE: No Unicode normalization - preserves content fidelity
        // Output will be validated when loaded via SkillManager.load()
        const skillData = await this.readAnthropicStructure(skillDirPath);

        // Step 2: Check for preserved DollhouseMCP metadata, or enrich if not found
        let enrichedMetadata: DollhouseMCPSkillMetadata;
        if (skillData.metadata?.has('dollhouse.yaml')) {
            // Use preserved metadata for perfect roundtrip
            const preservedYAML = skillData.metadata.get('dollhouse.yaml')!;
            // FIX (DMCP-SEC-005): Use CORE_SCHEMA to prevent YAML deserialization attacks
            enrichedMetadata = yaml.load(preservedYAML, { schema: yaml.CORE_SCHEMA }) as DollhouseMCPSkillMetadata;
            // Apply any custom metadata overrides
            if (options?.customMetadata) {
                Object.assign(enrichedMetadata, options.customMetadata);
            }
        } else {
            // Fall back to enrichment if no preserved metadata
            enrichedMetadata = this.enrichMetadata(skillData.skillMD.metadata, options);
        }

        // Step 3-6: Combine all components
        const combinedContent = this.combineComponents(skillData);

        // Step 7: Create single .md file with rich frontmatter
        const dollhouseSkill = this.createDollhouseSkill(enrichedMetadata, combinedContent);

        return dollhouseSkill;
    }

    /**
     * Convert in-memory Anthropic skill structure to DollhouseMCP format
     */
    convertFromStructure(structure: AnthropicSkillStructure, options?: {
        preserveSource?: boolean;
        customMetadata?: Partial<DollhouseMCPSkillMetadata>;
    }): string {
        // Parse SKILL.md
        // NOTE: No Unicode normalization - preserves content fidelity
        const { metadata, content } = this.parseSkillMD(structure['SKILL.md']);

        // Convert structure to directory format
        const skillData = this.buildSkillDataFromStructure(structure, metadata, content);

        // Get enriched metadata (either preserved or generated)
        const enrichedMetadata = this.getEnrichedMetadata(skillData, metadata, options);

        // Combine components and create final skill
        const combinedContent = this.combineComponents(skillData);
        return this.createDollhouseSkill(enrichedMetadata, combinedContent);
    }

    /**
     * Build skill data structure from Anthropic structure
     * REFACTORED: Extracted to reduce cognitive complexity
     */
    private buildSkillDataFromStructure(
        structure: AnthropicSkillStructure,
        metadata: AnthropicSkillMetadata,
        content: string
    ): AnthropicSkillDirectory {
        const skillData: AnthropicSkillDirectory = {
            skillMD: { metadata, content },
            scripts: new Map(),
            reference: new Map(),
            examples: new Map(),
            themes: new Map()
        };

        // Process all structure components
        this.processStructureScripts(structure, skillData);
        this.processStructureDirectory(structure['reference/'], skillData.reference);
        this.processStructureDirectory(structure['examples/'], skillData.examples);
        this.processStructureDirectory(structure['themes/'], skillData.themes);
        this.processStructureMetadata(structure, skillData);

        if (structure['LICENSE.txt']) {
            skillData.license = structure['LICENSE.txt'];
        }

        return skillData;
    }

    /**
     * Process scripts from structure
     * REFACTORED: Extracted to reduce cognitive complexity
     */
    private processStructureScripts(structure: AnthropicSkillStructure, skillData: AnthropicSkillDirectory): void {
        if (!structure['scripts/']) return;

        for (const [filename, content] of Object.entries(structure['scripts/'])) {
            const language = this.inferLanguageFromFilename(filename);
            const cleanContent = this.removeShebangAndHeaders(content);
            skillData.scripts.set(filename, { content: cleanContent, language });
        }
    }

    /**
     * Process generic directory structure (reference, examples, themes)
     * REFACTORED: Extracted to reduce cognitive complexity
     */
    private processStructureDirectory(
        sourceDir: Record<string, string> | undefined,
        targetMap: Map<string, string>
    ): void {
        if (!sourceDir) return;

        for (const [filename, content] of Object.entries(sourceDir)) {
            targetMap.set(filename, content);
        }
    }

    /**
     * Process metadata from structure
     * REFACTORED: Extracted to reduce cognitive complexity
     */
    private processStructureMetadata(structure: AnthropicSkillStructure, skillData: AnthropicSkillDirectory): void {
        if (!structure['metadata/']) return;

        skillData.metadata = new Map();
        for (const [filename, content] of Object.entries(structure['metadata/'])) {
            skillData.metadata.set(filename, content);
        }
    }

    /**
     * Get enriched metadata (preserved or generated)
     * REFACTORED: Extracted to reduce cognitive complexity
     */
    private getEnrichedMetadata(
        skillData: AnthropicSkillDirectory,
        metadata: AnthropicSkillMetadata,
        options?: {
            preserveSource?: boolean;
            customMetadata?: Partial<DollhouseMCPSkillMetadata>;
        }
    ): DollhouseMCPSkillMetadata {
        // Check for preserved DollhouseMCP metadata
        if (skillData.metadata?.has('dollhouse.yaml')) {
            return this.loadPreservedMetadata(skillData.metadata.get('dollhouse.yaml')!, options);
        }

        // Fall back to enrichment if no preserved metadata
        return this.enrichMetadata(metadata, options);
    }

    /**
     * Load preserved metadata from YAML
     * REFACTORED: Extracted to reduce cognitive complexity
     */
    private loadPreservedMetadata(
        preservedYAML: string,
        options?: {
            customMetadata?: Partial<DollhouseMCPSkillMetadata>;
        }
    ): DollhouseMCPSkillMetadata {
        // FIX (DMCP-SEC-005): Use CORE_SCHEMA to prevent YAML deserialization attacks
        const enrichedMetadata = yaml.load(preservedYAML, { schema: yaml.CORE_SCHEMA }) as DollhouseMCPSkillMetadata;

        // Apply any custom metadata overrides
        if (options?.customMetadata) {
            Object.assign(enrichedMetadata, options.customMetadata);
        }

        return enrichedMetadata;
    }

    /**
     * Read Anthropic skill directory structure from disk
     * REFACTORED: Simplified by extracting directory reading logic
     */
    async readAnthropicStructure(skillDirPath: string): Promise<AnthropicSkillDirectory> {
        this.validateSkillDirectory(skillDirPath);

        // Read and parse SKILL.md
        const { metadata, content } = this.readSkillMD(skillDirPath);

        // Initialize skill data structure
        const skillData: AnthropicSkillDirectory = {
            skillMD: { metadata, content },
            scripts: new Map(),
            reference: new Map(),
            examples: new Map(),
            themes: new Map()
        };

        // Read all directory components
        this.readScriptsDirectory(skillDirPath, skillData);
        this.readFilesDirectory(skillDirPath, 'reference', skillData.reference);
        this.readFilesDirectory(skillDirPath, 'examples', skillData.examples);
        this.readFilesDirectory(skillDirPath, 'themes', skillData.themes);
        this.readMetadataDirectory(skillDirPath, skillData);
        this.readLicenseFile(skillDirPath, skillData);

        return skillData;
    }

    /**
     * Validate skill directory exists and has SKILL.md
     * REFACTORED: Extracted to reduce cognitive complexity
     */
    private validateSkillDirectory(skillDirPath: string): void {
        if (!fs.existsSync(skillDirPath)) {
            throw new Error(`Skill directory not found: ${skillDirPath}`);
        }

        const skillMDPath = path.join(skillDirPath, 'SKILL.md');
        if (!fs.existsSync(skillMDPath)) {
            throw new Error(`SKILL.md not found in ${skillDirPath}`);
        }
    }

    /**
     * Read and parse SKILL.md file
     * REFACTORED: Extracted to reduce cognitive complexity
     */
    private readSkillMD(skillDirPath: string): { metadata: AnthropicSkillMetadata; content: string } {
        const skillMDPath = path.join(skillDirPath, 'SKILL.md');
        const skillMDContent = fs.readFileSync(skillMDPath, 'utf-8');
        return this.parseSkillMD(skillMDContent);
    }

    /**
     * Read scripts directory and process script files
     * REFACTORED: Extracted to reduce cognitive complexity
     */
    private readScriptsDirectory(skillDirPath: string, skillData: AnthropicSkillDirectory): void {
        const scriptsDir = path.join(skillDirPath, 'scripts');
        if (!fs.existsSync(scriptsDir)) return;

        const scriptFiles = fs.readdirSync(scriptsDir);
        for (const filename of scriptFiles) {
            const filePath = path.join(scriptsDir, filename);
            const content = fs.readFileSync(filePath, 'utf-8');
            const language = this.inferLanguageFromFilename(filename);
            const cleanContent = this.removeShebangAndHeaders(content);
            skillData.scripts.set(filename, { content: cleanContent, language });
        }
    }

    /**
     * Read generic files directory (reference, examples, themes)
     * REFACTORED: Extracted to reduce cognitive complexity and reuse code
     */
    private readFilesDirectory(
        skillDirPath: string,
        dirName: string,
        targetMap: Map<string, string>
    ): void {
        const dirPath = path.join(skillDirPath, dirName);
        if (!fs.existsSync(dirPath)) return;

        const files = fs.readdirSync(dirPath);
        for (const filename of files) {
            const filePath = path.join(dirPath, filename);
            const content = fs.readFileSync(filePath, 'utf-8');
            targetMap.set(filename, content);
        }
    }

    /**
     * Read metadata directory
     * REFACTORED: Extracted to reduce cognitive complexity
     */
    private readMetadataDirectory(skillDirPath: string, skillData: AnthropicSkillDirectory): void {
        const metadataDir = path.join(skillDirPath, 'metadata');
        if (!fs.existsSync(metadataDir)) return;

        skillData.metadata = new Map();
        const metadataFiles = fs.readdirSync(metadataDir);
        for (const filename of metadataFiles) {
            const filePath = path.join(metadataDir, filename);
            const content = fs.readFileSync(filePath, 'utf-8');
            skillData.metadata.set(filename, content);
        }
    }

    /**
     * Read LICENSE.txt file if it exists
     * REFACTORED: Extracted to reduce cognitive complexity
     */
    private readLicenseFile(skillDirPath: string, skillData: AnthropicSkillDirectory): void {
        const licensePath = path.join(skillDirPath, 'LICENSE.txt');
        if (fs.existsSync(licensePath)) {
            skillData.license = fs.readFileSync(licensePath, 'utf-8');
        }
    }

    /**
     * Parse SKILL.md and extract metadata and content
     */
    private parseSkillMD(skillMDContent: string): { metadata: AnthropicSkillMetadata; content: string } {
        const yamlMatch = skillMDContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

        if (!yamlMatch) {
            throw new Error('No YAML frontmatter found in SKILL.md');
        }

        // FIX (DMCP-SEC-005): Use CORE_SCHEMA to prevent YAML deserialization attacks
        const metadata = yaml.load(yamlMatch[1], { schema: yaml.CORE_SCHEMA }) as AnthropicSkillMetadata;
        const content = yamlMatch[2].trim();

        return { metadata, content };
    }

    /**
     * Enrich minimal Anthropic metadata with DollhouseMCP fields
     */
    private enrichMetadata(
        anthropicMeta: AnthropicSkillMetadata,
        options?: {
            preserveSource?: boolean;
            customMetadata?: Partial<DollhouseMCPSkillMetadata>;
        }
    ): DollhouseMCPSkillMetadata {
        // Infer tags and category from name/description
        const inferredTags = this.schemaMapper.inferTags(anthropicMeta.name, anthropicMeta.description);
        const inferredCategory = this.schemaMapper.inferCategory(anthropicMeta.name, anthropicMeta.description);

        // Use SchemaMapper to convert
        const enriched = this.schemaMapper.anthropicToDollhouse(anthropicMeta, {
            inferredTags,
            inferredCategory,
            inferredType: 'skill'
        });

        // Apply custom metadata overrides
        if (options?.customMetadata) {
            Object.assign(enriched, options.customMetadata);
        }

        return enriched;
    }

    /**
     * Combine all Anthropic skill components into single markdown content
     */
    private combineComponents(skillData: AnthropicSkillDirectory): string {
        const sections: string[] = [];

        // Start with main content from SKILL.md
        sections.push(skillData.skillMD.content);

        // Add embedded scripts as code blocks
        if (skillData.scripts.size > 0) {
            sections.push('\n## Scripts\n');
            for (const [filename, { content, language }] of skillData.scripts) {
                const title = this.filenameToTitle(filename);
                sections.push(`### ${title}\n`);
                sections.push('```' + language);
                sections.push(content);
                sections.push('```\n');
            }
        }

        // Add reference documentation sections
        if (skillData.reference.size > 0) {
            for (const [, content] of skillData.reference) {
                sections.push('\n' + content);
            }
        }

        // Add examples
        if (skillData.examples.size > 0) {
            sections.push('\n## Examples\n');
            for (const [, content] of skillData.examples) {
                sections.push(content);
                sections.push('\n');
            }
        }

        // Add themes/templates
        if (skillData.themes.size > 0) {
            sections.push('\n## Templates\n');
            for (const [, content] of skillData.themes) {
                sections.push(content);
                sections.push('\n');
            }
        }

        return sections.join('\n').trim();
    }

    /**
     * Create final DollhouseMCP skill with rich frontmatter
     */
    private createDollhouseSkill(metadata: DollhouseMCPSkillMetadata, content: string): string {
        const yamlString = yaml.dump(metadata);
        return `---\n${yamlString}---\n\n${content}\n`;
    }

    /**
     * Infer programming language from filename
     */
    private inferLanguageFromFilename(filename: string): string {
        const ext = path.extname(filename).toLowerCase();
        const languageMap: Record<string, string> = {
            '.sh': 'bash',
            '.bash': 'bash',
            '.py': 'python',
            '.js': 'javascript',
            '.ts': 'typescript',
            '.rb': 'ruby',
            '.pl': 'perl',
            '.php': 'php'
        };

        return languageMap[ext] || 'text';
    }

    /**
     * Remove shebang and auto-generated headers from extracted scripts
     */
    private removeShebangAndHeaders(content: string): string {
        const lines = content.split('\n');
        let startIndex = 0;

        // Skip shebang
        if (lines[0]?.startsWith('#!')) {
            startIndex = 1;
        }

        // Skip auto-generated header comments
        if (lines[startIndex]?.startsWith('# Extracted script')) {
            startIndex++;
        }

        // Skip empty lines after headers
        while (startIndex < lines.length && lines[startIndex]?.trim() === '') {
            startIndex++;
        }

        return lines.slice(startIndex).join('\n').trim();
    }

    /**
     * Convert filename to readable title
     */
    private filenameToTitle(filename: string): string {
        // Remove extension
        const nameWithoutExt = path.basename(filename, path.extname(filename));

        // Convert hyphens/underscores to spaces and capitalize
        return nameWithoutExt
            .replace(/[-_]/g, ' ')
            .split(' ')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');
    }

    /**
     * Write DollhouseMCP skill to disk
     */
    async writeToFile(skillContent: string, outputPath: string): Promise<void> {
        // Ensure output directory exists
        const outputDir = path.dirname(outputPath);
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Write skill file
        fs.writeFileSync(outputPath, skillContent, 'utf-8');
    }
}
