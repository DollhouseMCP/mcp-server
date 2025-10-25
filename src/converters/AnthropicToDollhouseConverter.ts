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
    private schemaMapper: SchemaMapper;

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
        const skillData: AnthropicSkillDirectory = {
            skillMD: { metadata, content },
            scripts: new Map(),
            reference: new Map(),
            examples: new Map(),
            themes: new Map()
        };

        // Process scripts
        if (structure['scripts/']) {
            for (const [filename, content] of Object.entries(structure['scripts/'])) {
                const language = this.inferLanguageFromFilename(filename);
                const cleanContent = this.removeShebangAndHeaders(content);
                skillData.scripts.set(filename, { content: cleanContent, language });
            }
        }

        // Process reference docs
        if (structure['reference/']) {
            for (const [filename, content] of Object.entries(structure['reference/'])) {
                skillData.reference.set(filename, content);
            }
        }

        // Process examples
        if (structure['examples/']) {
            for (const [filename, content] of Object.entries(structure['examples/'])) {
                skillData.examples.set(filename, content);
            }
        }

        // Process themes
        if (structure['themes/']) {
            for (const [filename, content] of Object.entries(structure['themes/'])) {
                skillData.themes.set(filename, content);
            }
        }

        // Process metadata
        if (structure['metadata/']) {
            skillData.metadata = new Map();
            for (const [filename, content] of Object.entries(structure['metadata/'])) {
                skillData.metadata.set(filename, content);
            }
        }

        // License
        if (structure['LICENSE.txt']) {
            skillData.license = structure['LICENSE.txt'];
        }

        // Check for preserved DollhouseMCP metadata
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
            enrichedMetadata = this.enrichMetadata(metadata, options);
        }

        // Combine components
        const combinedContent = this.combineComponents(skillData);

        // Create final skill
        return this.createDollhouseSkill(enrichedMetadata, combinedContent);
    }

    /**
     * Read Anthropic skill directory structure from disk
     */
    async readAnthropicStructure(skillDirPath: string): Promise<AnthropicSkillDirectory> {
        if (!fs.existsSync(skillDirPath)) {
            throw new Error(`Skill directory not found: ${skillDirPath}`);
        }

        // Read SKILL.md
        const skillMDPath = path.join(skillDirPath, 'SKILL.md');
        if (!fs.existsSync(skillMDPath)) {
            throw new Error(`SKILL.md not found in ${skillDirPath}`);
        }

        // Read SKILL.md (no normalization - preserve fidelity)
        const skillMDContent = fs.readFileSync(skillMDPath, 'utf-8');
        const { metadata, content } = this.parseSkillMD(skillMDContent);

        const skillData: AnthropicSkillDirectory = {
            skillMD: { metadata, content },
            scripts: new Map(),
            reference: new Map(),
            examples: new Map(),
            themes: new Map()
        };

        // Read scripts/
        const scriptsDir = path.join(skillDirPath, 'scripts');
        if (fs.existsSync(scriptsDir)) {
            const scriptFiles = fs.readdirSync(scriptsDir);
            for (const filename of scriptFiles) {
                const filePath = path.join(scriptsDir, filename);
                const content = fs.readFileSync(filePath, 'utf-8');
                const language = this.inferLanguageFromFilename(filename);
                const cleanContent = this.removeShebangAndHeaders(content);
                skillData.scripts.set(filename, { content: cleanContent, language });
            }
        }

        // Read reference/
        const refDir = path.join(skillDirPath, 'reference');
        if (fs.existsSync(refDir)) {
            const refFiles = fs.readdirSync(refDir);
            for (const filename of refFiles) {
                const filePath = path.join(refDir, filename);
                const content = fs.readFileSync(filePath, 'utf-8');
                skillData.reference.set(filename, content);
            }
        }

        // Read examples/
        const examplesDir = path.join(skillDirPath, 'examples');
        if (fs.existsSync(examplesDir)) {
            const exampleFiles = fs.readdirSync(examplesDir);
            for (const filename of exampleFiles) {
                const filePath = path.join(examplesDir, filename);
                const content = fs.readFileSync(filePath, 'utf-8');
                skillData.examples.set(filename, content);
            }
        }

        // Read themes/
        const themesDir = path.join(skillDirPath, 'themes');
        if (fs.existsSync(themesDir)) {
            const themeFiles = fs.readdirSync(themesDir);
            for (const filename of themeFiles) {
                const filePath = path.join(themesDir, filename);
                const content = fs.readFileSync(filePath, 'utf-8');
                skillData.themes.set(filename, content);
            }
        }

        // Read metadata/
        const metadataDir = path.join(skillDirPath, 'metadata');
        if (fs.existsSync(metadataDir)) {
            skillData.metadata = new Map();
            const metadataFiles = fs.readdirSync(metadataDir);
            for (const filename of metadataFiles) {
                const filePath = path.join(metadataDir, filename);
                const content = fs.readFileSync(filePath, 'utf-8');
                skillData.metadata.set(filename, content);
            }
        }

        // Read LICENSE.txt
        const licensePath = path.join(skillDirPath, 'LICENSE.txt');
        if (fs.existsSync(licensePath)) {
            skillData.license = fs.readFileSync(licensePath, 'utf-8');
        }

        return skillData;
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
            for (const [filename, content] of skillData.reference) {
                sections.push('\n' + content);
            }
        }

        // Add examples
        if (skillData.examples.size > 0) {
            sections.push('\n## Examples\n');
            for (const [filename, content] of skillData.examples) {
                sections.push(content);
                sections.push('\n');
            }
        }

        // Add themes/templates
        if (skillData.themes.size > 0) {
            sections.push('\n## Templates\n');
            for (const [filename, content] of skillData.themes) {
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
