/**
 * SchemaMapper - Bidirectional schema conversion between Anthropic Skills and DollhouseMCP Skills
 *
 * Based on the 1:1 mapping specification documented in:
 * business/documents/legal/evidence/anthropic-dollhouse-skills-mapping.md
 */

export interface AnthropicSkillMetadata {
    name: string;
    description: string;
    license?: string;
}

export interface DollhouseMCPSkillMetadata {
    name: string;
    description: string;
    type?: string;
    version?: string;
    author?: string;
    created?: string;
    modified?: string;
    category?: string;
    tags?: string[];
    complexity?: string;
    domains?: string[];
    dependencies?: string[];
    prerequisites?: string[];
    parameters?: Record<string, any>[];
    examples?: Record<string, any>[];
    languages?: string[];
    proficiency_level?: number;
    license?: string;
    custom?: Record<string, any>;
}

export class SchemaMapper {
    /**
     * Convert Anthropic frontmatter to DollhouseMCP metadata
     * Maps minimal Anthropic schema to rich DollhouseMCP schema
     */
    anthropicToDollhouse(
        anthropicMeta: AnthropicSkillMetadata,
        options?: {
            inferredType?: string;
            inferredTags?: string[];
            inferredCategory?: string;
        }
    ): DollhouseMCPSkillMetadata {
        const now = new Date().toISOString();

        return {
            // Direct mappings (100% preserved)
            name: anthropicMeta.name,
            description: anthropicMeta.description,
            license: anthropicMeta.license,

            // DollhouseMCP-specific fields (added during conversion)
            type: options?.inferredType || 'skill',
            version: '1.0.0', // Default version for converted skills
            author: 'Anthropic', // Mark provenance
            created: now,
            modified: now,
            category: options?.inferredCategory,
            tags: options?.inferredTags || [],
            complexity: 'beginner', // Default complexity

            // Optional rich fields (empty by default)
            domains: [],
            dependencies: [],
            prerequisites: [],
            parameters: [],
            examples: [],
            languages: [],
            proficiency_level: 0,

            // Preserve any additional metadata
            custom: {
                source: 'anthropic-skills',
                converted: now
            }
        };
    }

    /**
     * Convert DollhouseMCP metadata to Anthropic frontmatter
     * Strips DollhouseMCP-specific fields to create minimal Anthropic schema
     */
    dollhouseToAnthropic(
        dollhouseMeta: DollhouseMCPSkillMetadata
    ): AnthropicSkillMetadata {
        return {
            // Core required fields (100% preserved)
            name: dollhouseMeta.name,
            description: dollhouseMeta.description,

            // Optional field if present
            ...(dollhouseMeta.license && { license: dollhouseMeta.license })
        };
    }

    /**
     * Auto-generate tags from skill name and description
     */
    inferTags(name: string, description: string): string[] {
        const tags: string[] = [];
        const text = `${name} ${description}`.toLowerCase();

        // Common tag patterns
        const tagPatterns: Record<string, string[]> = {
            communication: ['communication', 'comms', 'message', 'email'],
            documentation: ['document', 'docs', 'documentation'],
            code: ['code', 'programming', 'typescript', 'javascript', 'python'],
            automation: ['automat', 'script', 'batch'],
            modernization: ['modern', 'upgrade', 'migrate'],
            templates: ['template', 'example', 'format'],
            testing: ['test', 'validation', 'verify']
        };

        for (const [tag, patterns] of Object.entries(tagPatterns)) {
            if (patterns.some(pattern => text.includes(pattern))) {
                tags.push(tag);
            }
        }

        return tags;
    }

    /**
     * Infer category from skill name and description
     */
    inferCategory(name: string, description: string): string | undefined {
        const text = `${name} ${description}`.toLowerCase();

        const categoryPatterns: Record<string, string[]> = {
            communication: ['communication', 'email', 'message', 'newsletter'],
            development: ['code', 'develop', 'programming', 'software'],
            documentation: ['document', 'docs', 'writing'],
            automation: ['automat', 'script', 'batch', 'workflow'],
            business: ['business', 'corporate', 'enterprise']
        };

        for (const [category, patterns] of Object.entries(categoryPatterns)) {
            if (patterns.some(pattern => text.includes(pattern))) {
                return category;
            }
        }

        return undefined;
    }
}
