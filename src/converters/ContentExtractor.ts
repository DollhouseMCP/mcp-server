/**
 * ContentExtractor - Extracts components from DollhouseMCP skills for Anthropic conversion
 *
 * Identifies and extracts:
 * - Code blocks (bash, python, etc.) → scripts/
 * - Documentation sections → reference/
 * - Examples → examples/
 * - Main instructions (preserved in SKILL.md)
 */

import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

export interface ExtractedSection {
    type: 'code' | 'documentation' | 'example' | 'main';
    language?: string;
    title: string;
    content: string;
    startLine: number;
    endLine: number;
    filename?: string; // Suggested filename for extraction
}

export class ContentExtractor {
    /**
     * Parse DollhouseMCP markdown content and identify extractable sections
     */
    extractSections(content: string): ExtractedSection[] {
        // FIX (DMCP-SEC-004): Normalize Unicode content to prevent bypass attacks
        const unicodeResult = UnicodeValidator.normalize(content);
        const normalizedContent = unicodeResult.normalizedContent;

        const sections: ExtractedSection[] = [];
        const lines = normalizedContent.split('\n');

        let inCodeBlock = false;
        let codeBlockStart = 0;
        let codeBlockLanguage = '';
        let codeBlockContent: string[] = [];
        let currentSection = '';
        let sectionStart = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Detect code block boundaries
            if (line.startsWith('```')) {
                if (!inCodeBlock) {
                    // Start of code block
                    inCodeBlock = true;
                    codeBlockStart = i;
                    codeBlockLanguage = line.substring(3).trim();
                    codeBlockContent = [];
                } else {
                    // End of code block
                    inCodeBlock = false;

                    // Determine if this should be extracted
                    if (this.shouldExtractCodeBlock(codeBlockLanguage, codeBlockContent)) {
                        sections.push({
                            type: 'code',
                            language: codeBlockLanguage,
                            title: this.inferCodeBlockTitle(codeBlockContent, currentSection),
                            content: codeBlockContent.join('\n'),
                            startLine: codeBlockStart,
                            endLine: i,
                            filename: this.generateScriptFilename(codeBlockLanguage, codeBlockContent, currentSection)
                        });
                    }
                }
            } else if (inCodeBlock) {
                codeBlockContent.push(line);
            } else if (line.startsWith('##')) {
                // Section header
                currentSection = line.substring(2).trim();
                sectionStart = i;

                // Check if this section should be extracted
                if (this.shouldExtractSection(currentSection)) {
                    // Will accumulate until next section
                }
            }
        }

        return sections;
    }

    /**
     * Determine if a code block should be extracted to a separate file
     */
    private shouldExtractCodeBlock(language: string, content: string[]): boolean {
        // Extract bash, python, javascript scripts
        const extractableLanguages = ['bash', 'sh', 'python', 'py', 'javascript', 'js', 'typescript', 'ts'];

        if (!extractableLanguages.includes(language.toLowerCase())) {
            return false;
        }

        // Extract if it's substantial (more than 3 lines)
        return content.length > 3;
    }

    /**
     * Determine if a documentation section should be extracted
     */
    private shouldExtractSection(sectionTitle: string): boolean {
        const extractableSections = [
            'input formats',
            'error handling',
            'supported clients',
            'command building',
            'configuration',
            'api reference',
            'troubleshooting'
        ];

        return extractableSections.some(pattern =>
            sectionTitle.toLowerCase().includes(pattern)
        );
    }

    /**
     * Generate appropriate filename for extracted script
     */
    private generateScriptFilename(language: string, content: string[], section: string): string {
        // Look for meaningful names in comments
        const firstLine = content[0] || '';

        // Common patterns: "# Pre-execution checks", "# Install server", etc.
        if (firstLine.startsWith('#')) {
            const titleMatch = firstLine.match(/^#\s*(.+)/);
            if (titleMatch) {
                const title = titleMatch[1].toLowerCase()
                    .replace(/[^a-z0-9\s-]/g, '')
                    .replace(/\s+/g, '-');
                return `${title}.${this.getExtension(language)}`;
            }
        }

        // Use section name
        if (section) {
            const sectionSlug = section.toLowerCase()
                .replace(/[^a-z0-9\s-]/g, '')
                .replace(/\s+/g, '-');
            return `${sectionSlug}.${this.getExtension(language)}`;
        }

        return `script.${this.getExtension(language)}`;
    }

    /**
     * Infer title for code block from surrounding context
     */
    private inferCodeBlockTitle(content: string[], section: string): string {
        const firstLine = content[0] || '';

        // Check for comment at start
        if (firstLine.startsWith('#') || firstLine.startsWith('//')) {
            return firstLine.replace(/^[#\/\s]+/, '').trim();
        }

        return section || 'Script';
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
     * Extract complete documentation section (including subsections)
     */
    extractDocumentationSection(content: string, sectionTitle: string): string | null {
        // FIX (DMCP-SEC-004): Normalize Unicode content to prevent bypass attacks
        const unicodeResult = UnicodeValidator.normalize(content);
        const normalizedContent = unicodeResult.normalizedContent;

        const lines = normalizedContent.split('\n');
        let capturing = false;
        let sectionContent: string[] = [];
        let sectionLevel = 0;

        for (const line of lines) {
            if (line.startsWith('##')) {
                const level = line.match(/^#+/)?.[0].length || 0;
                const title = line.substring(level).trim();

                if (!capturing && title.toLowerCase().includes(sectionTitle.toLowerCase())) {
                    capturing = true;
                    sectionLevel = level;
                    sectionContent.push(line);
                } else if (capturing && level <= sectionLevel) {
                    // End of section
                    break;
                } else if (capturing) {
                    sectionContent.push(line);
                }
            } else if (capturing) {
                sectionContent.push(line);
            }
        }

        return sectionContent.length > 0 ? sectionContent.join('\n') : null;
    }
}
