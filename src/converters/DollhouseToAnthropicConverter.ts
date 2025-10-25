/**
 * DollhouseToAnthropicConverter - Converts single-file DollhouseMCP skills to multi-file Anthropic Skills
 *
 * Based on the exact algorithm documented in:
 * business/documents/legal/evidence/anthropic-skills-decomposition-analysis.md (lines 108-163)
 *
 * Implements the mechanical transformation:
 * DollhouseMCP Skill (single .md file) → Anthropic Skill (directory with separated components)
 *
 * SECURITY MODEL:
 * - This is a FORMAT TRANSFORMER, not a security boundary
 * - Preserves content fidelity - no modification, sanitization, or validation
 * - YAML parsing uses CORE_SCHEMA to prevent deserialization attacks only
 * - Security validation happens at SkillManager.load() time, not conversion time
 * - Input skills should already be validated (they're from DollhouseMCP system)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { SchemaMapper, type DollhouseMCPSkillMetadata, type AnthropicSkillMetadata } from './SchemaMapper.js';
import { ContentExtractor, type ExtractedSection } from './ContentExtractor.js';

export interface AnthropicSkillStructure {
    'SKILL.md': string;
    'scripts/'?: Record<string, string>;
    'reference/'?: Record<string, string>;
    'themes/'?: Record<string, string>;
    'examples/'?: Record<string, string>;
    'metadata/'?: Record<string, string>;
    'LICENSE.txt'?: string;
}

export class DollhouseToAnthropicConverter {
    private schemaMapper: SchemaMapper;
    private contentExtractor: ContentExtractor;

    constructor() {
        this.schemaMapper = new SchemaMapper();
        this.contentExtractor = new ContentExtractor();
    }

    /**
     * Convert a DollhouseMCP skill (.md file) to Anthropic Skill format (directory structure)
     *
     * EXACT ALGORITHM from evidence/anthropic-skills-decomposition-analysis.md:
     * 1. Extract YAML frontmatter
     * 2. Simplify YAML (keep only name + description)
     * 3. Extract main instructions
     * 4. Extract embedded code blocks → scripts/
     * 5. Extract reference sections → reference/
     * 6. Extract templates → themes/ or examples/
     * 7. Create SKILL.md with references
     * 8. Return directory structure
     */
    async convertSkill(skillContent: string, options?: {
        includelicense?: boolean;
        preserveComments?: boolean;
    }): Promise<AnthropicSkillStructure> {
        // Step 1: Extract YAML frontmatter
        // NOTE: No Unicode normalization - preserves content fidelity for mechanical transformation
        // Security validation happens when loading converted skills via SkillManager.load()
        const { metadata, bodyContent } = this.extractYAMLFrontmatter(skillContent);

        // Step 2: Simplify YAML (keep only name + description, optionally license)
        const minimalYAML = this.schemaMapper.dollhouseToAnthropic(metadata);

        // Step 3-6: Extract all components
        const sections = this.contentExtractor.extractSections(bodyContent);

        // Organize extracted sections by type
        const scripts: Record<string, string> = {};
        const reference: Record<string, string> = {};
        const themes: Record<string, string> = {};
        const examples: Record<string, string> = {};

        let mainInstructions = '';
        const sectionReferences: string[] = [];

        // Step 4: Extract code blocks → scripts/
        const codeBlocks = sections.filter(s => s.type === 'code');
        for (const block of codeBlocks) {
            if (block.filename) {
                const ext = this.getExtension(block.language || '');
                const filename = block.filename;
                scripts[filename] = this.formatScriptFile(block.content, block.language || '');
                sectionReferences.push(`See \`scripts/${filename}\` for ${block.title}`);
            }
        }

        // Step 5: Extract documentation sections → reference/
        const docSections = this.extractDocumentationSections(bodyContent);
        for (const [title, content] of Object.entries(docSections)) {
            const filename = this.slugify(title) + '.md';
            reference[filename] = content;
            sectionReferences.push(`See \`reference/${filename}\` for ${title}`);
        }

        // Step 6: Extract examples
        const exampleSection = this.contentExtractor.extractDocumentationSection(bodyContent, 'example');
        if (exampleSection) {
            examples['installation-example.md'] = exampleSection;
            sectionReferences.push(`See \`examples/installation-example.md\` for complete walkthrough`);
        }

        // Step 3: Extract main instructions (preserve structural content, remove extracted sections)
        mainInstructions = this.extractMainInstructions(bodyContent, sections);

        // Step 7: Create SKILL.md with references to separated files
        const skillMD = this.createSkillMD(minimalYAML, mainInstructions, sectionReferences);

        // Step 8: Return directory structure
        const result: AnthropicSkillStructure = {
            'SKILL.md': skillMD
        };

        if (Object.keys(scripts).length > 0) {
            result['scripts/'] = scripts;
        }

        if (Object.keys(reference).length > 0) {
            result['reference/'] = reference;
        }

        if (Object.keys(themes).length > 0) {
            result['themes/'] = themes;
        }

        if (Object.keys(examples).length > 0) {
            result['examples/'] = examples;
        }

        if (options?.includelicense && metadata.license) {
            result['LICENSE.txt'] = this.createLicenseFile(metadata.license, metadata.author);
        }

        // Always preserve full DollhouseMCP metadata for perfect roundtrip
        result['metadata/'] = {
            'dollhouse.yaml': yaml.dump(metadata)
        };

        return result;
    }

    /**
     * Write the Anthropic skill structure to disk
     */
    async writeToDirectory(structure: AnthropicSkillStructure, outputDir: string): Promise<void> {
        // Create output directory
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Write SKILL.md
        fs.writeFileSync(path.join(outputDir, 'SKILL.md'), structure['SKILL.md']);

        // Write scripts
        if (structure['scripts/']) {
            const scriptsDir = path.join(outputDir, 'scripts');
            fs.mkdirSync(scriptsDir, { recursive: true });
            for (const [filename, content] of Object.entries(structure['scripts/'])) {
                fs.writeFileSync(path.join(scriptsDir, filename), content);
                // SECURITY (SonarCloud S2612): Do NOT auto-chmod scripts executable
                // - Scripts from DollhouseMCP are markdown code blocks, not executable files
                // - Format transformer shouldn't make security decisions (chmod = security decision)
                // - Principle of least privilege: user can chmod if needed
                // - Prevents automatic execution of potentially malicious converted scripts
            }
        }

        // Write reference docs
        if (structure['reference/']) {
            const refDir = path.join(outputDir, 'reference');
            fs.mkdirSync(refDir, { recursive: true });
            for (const [filename, content] of Object.entries(structure['reference/'])) {
                fs.writeFileSync(path.join(refDir, filename), content);
            }
        }

        // Write themes
        if (structure['themes/']) {
            const themesDir = path.join(outputDir, 'themes');
            fs.mkdirSync(themesDir, { recursive: true });
            for (const [filename, content] of Object.entries(structure['themes/'])) {
                fs.writeFileSync(path.join(themesDir, filename), content);
            }
        }

        // Write examples
        if (structure['examples/']) {
            const examplesDir = path.join(outputDir, 'examples');
            fs.mkdirSync(examplesDir, { recursive: true });
            for (const [filename, content] of Object.entries(structure['examples/'])) {
                fs.writeFileSync(path.join(examplesDir, filename), content);
            }
        }

        // Write metadata
        if (structure['metadata/']) {
            const metadataDir = path.join(outputDir, 'metadata');
            fs.mkdirSync(metadataDir, { recursive: true });
            for (const [filename, content] of Object.entries(structure['metadata/'])) {
                fs.writeFileSync(path.join(metadataDir, filename), content);
            }
        }

        // Write license
        if (structure['LICENSE.txt']) {
            fs.writeFileSync(path.join(outputDir, 'LICENSE.txt'), structure['LICENSE.txt']);
        }
    }

    /**
     * Extract YAML frontmatter from markdown
     */
    private extractYAMLFrontmatter(content: string): {
        metadata: DollhouseMCPSkillMetadata;
        bodyContent: string;
    } {
        const yamlMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

        if (!yamlMatch) {
            throw new Error('No YAML frontmatter found');
        }

        // FIX (DMCP-SEC-005): Use CORE_SCHEMA to prevent YAML deserialization attacks
        const metadata = yaml.load(yamlMatch[1], { schema: yaml.CORE_SCHEMA }) as DollhouseMCPSkillMetadata;
        const bodyContent = yamlMatch[2];

        return { metadata, bodyContent };
    }

    /**
     * Create SKILL.md content with simplified metadata and references
     */
    private createSkillMD(
        metadata: AnthropicSkillMetadata,
        mainInstructions: string,
        references: string[]
    ): string {
        const yamlString = yaml.dump(metadata);

        let skillMD = `---\n${yamlString}---\n\n${mainInstructions}`;

        // Add references section if there are extracted components
        if (references.length > 0) {
            skillMD += '\n\n## Additional Resources\n\n';
            skillMD += references.join('\n');
        }

        return skillMD;
    }

    /**
     * Extract main instructions (content before code blocks and special sections)
     */
    private extractMainInstructions(content: string, extractedSections: ExtractedSection[]): string {
        // For now, return content up to first code block or extracted section
        // This is simplified - a full implementation would reconstruct with references
        const lines = content.split('\n');
        const mainLines: string[] = [];

        let inExtractedSection = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Check if we're entering an extracted section
            const isExtracted = extractedSections.some(
                s => i >= s.startLine && i <= s.endLine
            );

            if (isExtracted) {
                inExtractedSection = true;
                continue;
            }

            if (!inExtractedSection || line.startsWith('#')) {
                mainLines.push(line);
                inExtractedSection = false;
            }
        }

        return mainLines.join('\n').trim();
    }

    /**
     * Extract documentation sections (Input Formats, Error Handling, etc.)
     */
    private extractDocumentationSections(content: string): Record<string, string> {
        const sections: Record<string, string> = {};

        // Common documentation section patterns
        const sectionPatterns = [
            'Input Formats',
            'Error Handling',
            'Supported Clients',
            'Command Building',
            'Configuration',
            'Troubleshooting'
        ];

        for (const pattern of sectionPatterns) {
            const section = this.contentExtractor.extractDocumentationSection(content, pattern);
            if (section) {
                sections[pattern] = section;
            }
        }

        return sections;
    }

    /**
     * Format script file with proper shebang and headers
     */
    private formatScriptFile(content: string, language: string): string {
        const shebang = this.getShebang(language);
        const header = this.getScriptHeader(content);

        return `${shebang}\n${header}\n${content}`;
    }

    /**
     * Get appropriate shebang for script language
     */
    private getShebang(language: string): string {
        const shebangs: Record<string, string> = {
            bash: '#!/bin/bash',
            sh: '#!/bin/sh',
            python: '#!/usr/bin/env python3',
            py: '#!/usr/bin/env python3',
            node: '#!/usr/bin/env node',
            javascript: '#!/usr/bin/env node',
            js: '#!/usr/bin/env node'
        };

        return shebangs[language.toLowerCase()] || '#!/bin/bash';
    }

    /**
     * Get script header comment
     */
    private getScriptHeader(content: string): string {
        // Extract first comment if present
        const firstLine = content.split('\n')[0];
        if (firstLine.startsWith('#') || firstLine.startsWith('//')) {
            return firstLine;
        }
        return '# Extracted script';
    }

    /**
     * Get file extension for language
     */
    private getExtension(language: string): string {
        const extensions: Record<string, string> = {
            bash: 'sh',
            sh: 'sh',
            python: 'py',
            py: 'py',
            javascript: 'js',
            js: 'js',
            typescript: 'ts',
            ts: 'ts'
        };

        return extensions[language.toLowerCase()] || 'txt';
    }

    /**
     * Create slugified filename from title
     */
    private slugify(title: string): string {
        return title
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-');
    }

    /**
     * Create LICENSE.txt file
     */
    private createLicenseFile(license: string, author?: string): string {
        return `${license}${author ? `\n\nAuthor: ${author}` : ''}`;
    }
}
