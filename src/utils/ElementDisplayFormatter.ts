/**
 * Element Display Formatter Utility
 *
 * Provides consistent formatting for element display output across the codebase.
 * Extracted from listElements.ts to eliminate duplication between query and legacy paths.
 *
 * This utility produces character-for-character identical output to the original
 * formatting logic to ensure backward compatibility.
 *
 * Note: This is separate from ElementFormatter.ts which handles file formatting/cleaning.
 */

import { ElementType } from '../portfolio/PortfolioManager.js';
import { IElement } from '../types/elements/IElement.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';

/** Default values for element formatting */
const DEFAULTS = {
  VERSION: '1.0.0',
  VERSION_SHORT: '1.0',
  AUTHOR: 'Unknown',
  CATEGORY: 'general',
  PRICE: 'free',
  COMPLEXITY: 'beginner',
  DOMAINS: 'general',
  RETENTION: 'permanent',
  STRATEGY: 'sequential',
  DESCRIPTION: 'No description provided.',
  TRIGGERS: 'None',
  TAGS: 'none',
  VARIABLES: 'none',
  SPECIALIZATIONS: 'general',
  STATUS: 'unknown',
} as const;

/**
 * Typed interface for Persona elements
 */
interface PersonaElement extends IElement {
  filename?: string;
  unique_id?: string;
  metadata: IElement['metadata'] & {
    price?: string;
    category?: string;
    triggers?: string[];
  };
}

/**
 * Typed interface for Skill elements
 */
interface SkillElement extends IElement {
  metadata: IElement['metadata'] & {
    complexity?: string;
    domains?: string[];
  };
}

/**
 * Typed interface for Template elements
 */
interface TemplateElement extends IElement {
  metadata: IElement['metadata'] & {
    variables?: Array<{ name: string; type?: string; required?: boolean }>;
  };
}

/**
 * Typed interface for Agent elements
 */
interface AgentElement extends IElement {
  metadata: IElement['metadata'] & {
    specializations?: string[];
  };
}

/**
 * Typed interface for Memory elements
 */
interface MemoryElement extends IElement {
  metadata: IElement['metadata'] & {
    retentionDays?: number | string;
  };
}

/**
 * Typed interface for Ensemble elements
 */
interface EnsembleElement extends IElement {
  metadata: IElement['metadata'] & {
    elements?: string[];
    activationStrategy?: string;
  };
}

/**
 * Configuration for element display formatting
 */
export interface ElementDisplayFormatterConfig {
  /**
   * The currently active persona ID (filename), used to display active indicator
   * Only relevant for persona formatting
   */
  activePersonaId?: string | null;
}

/**
 * Static utility class for formatting element display output
 */
export class ElementDisplayFormatter {
  /**
   * Normalize a string value using Unicode validation
   * Protects against homograph attacks and other Unicode-based exploits
   *
   * @param value The string to normalize
   * @returns Normalized string, or empty string if value is undefined
   */
  private static normalize(value: string | undefined): string {
    if (!value) return '';
    const result = UnicodeValidator.normalize(value);
    return result.normalizedContent;
  }

  /**
   * Format a single element for display based on its type
   *
   * @param element The element to format
   * @param type The element type
   * @param config Optional configuration (e.g., active persona ID)
   * @returns Formatted string representation of the element
   */
  static formatElement(
    element: IElement,
    type: ElementType,
    config?: ElementDisplayFormatterConfig
  ): string {
    switch (type) {
      case ElementType.PERSONA:
        return this.formatPersona(element as PersonaElement, config?.activePersonaId ?? null);

      case ElementType.SKILL:
        return this.formatSkill(element as SkillElement);

      case ElementType.TEMPLATE:
        return this.formatTemplate(element as TemplateElement);

      case ElementType.AGENT:
        return this.formatAgent(element as AgentElement);

      case ElementType.MEMORY:
        return this.formatMemory(element as MemoryElement);

      case ElementType.ENSEMBLE:
        return this.formatEnsemble(element as EnsembleElement);

      default:
        return `• ${this.normalize(element.metadata?.name) || 'Unknown'} - ${this.normalize(element.metadata?.description) || 'No description'}`;
    }
  }

  /**
   * Format multiple elements for display
   *
   * @param elements The elements to format
   * @param type The element type
   * @param config Optional configuration (e.g., active persona ID)
   * @returns Formatted string with all elements separated by double newlines
   */
  static formatElements(
    elements: IElement[],
    type: ElementType,
    config?: ElementDisplayFormatterConfig
  ): string {
    return elements
      .map((element) => this.formatElement(element, type, config))
      .join('\n\n');
  }

  /**
   * Format a persona element for display
   *
   * @param element The persona element to format
   * @param activePersonaId The currently active persona ID (filename)
   * @returns Formatted string representation
   *
   * @example
   * // Returns:
   * // 🔹 **Creative Writer** (creative-writer)
   * //    A creative writing assistant
   * //    📁 creative | 🎭 John Doe | 🔖 premium
   * //    Version: 2.0 | Triggers: write, story, creative
   *
   * Output format:
   * 🔹/▫️ **Name** (unique_id)
   *    Description
   *    📁 category | 🎭 author | 🔖 price
   *    Version: version | Triggers: triggers
   */
  private static formatPersona(element: PersonaElement, activePersonaId: string | null): string {
    const isActive = element.filename === activePersonaId;
    const price = this.normalize(element.metadata.price) || DEFAULTS.PRICE;
    const author = this.normalize(element.metadata.author) || DEFAULTS.AUTHOR;
    const category = this.normalize(element.metadata.category) || DEFAULTS.CATEGORY;
    const version = this.normalize(element.metadata.version) || DEFAULTS.VERSION_SHORT;
    const triggers = element.metadata.triggers?.map(t => this.normalize(t)).join(', ') || DEFAULTS.TRIGGERS;
    const description = this.normalize(element.metadata.description) || DEFAULTS.DESCRIPTION;
    const name = this.normalize(element.metadata.name);
    const uniqueId = this.normalize(element.unique_id);

    return (
      `${isActive ? '🔹' : '▫️'} **${name}** (${uniqueId})\n` +
      `   ${description}\n` +
      `   📁 ${category} | 🎭 ${author} | 🔖 ${price}\n` +
      `   Version: ${version} | Triggers: ${triggers}`
    );
  }

  /**
   * Format a skill element for display
   *
   * @param element The skill element to format
   * @returns Formatted string representation
   *
   * @example
   * // Returns:
   * // 🛠️ Code Review (v3.2.1) - Reviews code for quality
   * //    Complexity: intermediate | Domains: code, quality, review
   *
   * Output format:
   * 🛠️ Name (vVersion) - Description
   *    Complexity: complexity | Domains: domains
   */
  private static formatSkill(element: SkillElement): string {
    const complexity = this.normalize(element.metadata.complexity) || DEFAULTS.COMPLEXITY;
    const domains = element.metadata.domains?.map(d => this.normalize(d)).join(', ') || DEFAULTS.DOMAINS;
    const version = this.normalize(element.version) || this.normalize(element.metadata.version) || DEFAULTS.VERSION;
    const name = this.normalize(element.metadata.name);
    const description = this.normalize(element.metadata.description);

    return (
      `🛠️ ${name} (v${version}) - ${description}\n` +
      `   Complexity: ${complexity} | Domains: ${domains}`
    );
  }

  /**
   * Format a template element for display
   *
   * @param element The template element to format
   * @returns Formatted string representation
   *
   * @example
   * // Returns:
   * // 📄 Meeting Notes (v1.2.0) - Template for meeting notes
   * //    Variables: title, date, attendees
   *
   * Output format:
   * 📄 Name (vVersion) - Description
   *    Variables: variables
   */
  private static formatTemplate(element: TemplateElement): string {
    const variables = element.metadata.variables?.map((v) => this.normalize(v.name)).join(', ') || DEFAULTS.VARIABLES;
    const version = this.normalize(element.version) || this.normalize(element.metadata.version) || DEFAULTS.VERSION;
    const name = this.normalize(element.metadata.name);
    const description = this.normalize(element.metadata.description);

    return (
      `📄 ${name} (v${version}) - ${description}\n` +
      `   Variables: ${variables}`
    );
  }

  /**
   * Format an agent element for display
   *
   * @param element The agent element to format
   * @returns Formatted string representation
   *
   * @example
   * // Returns:
   * // 🤖 Task Manager (v2.1.0) - Manages tasks automatically
   * //    Status: active | Specializations: planning, execution, monitoring
   *
   * Output format:
   * 🤖 Name (vVersion) - Description
   *    Status: status | Specializations: specializations
   */
  private static formatAgent(element: AgentElement): string {
    const specializations = element.metadata.specializations?.map(s => this.normalize(s)).join(', ') || DEFAULTS.SPECIALIZATIONS;
    // getStatus() returns ElementStatus enum, convert to string
    const status = element.getStatus ? element.getStatus().toString() : DEFAULTS.STATUS;
    const version = this.normalize(element.version) || this.normalize(element.metadata.version) || DEFAULTS.VERSION;
    const name = this.normalize(element.metadata.name);
    const description = this.normalize(element.metadata.description);

    return (
      `🤖 ${name} (v${version}) - ${description}\n` +
      `   Status: ${status} | Specializations: ${specializations}`
    );
  }

  /**
   * Format a memory element for display
   *
   * @param element The memory element to format
   * @returns Formatted string representation
   *
   * @example
   * // Returns:
   * // 🧠 Project Context (v1.1.0) - Context about the current project
   * //    Retention: 90 days | Tags: project, context, important
   *
   * Output format:
   * 🧠 Name (vVersion) - Description
   *    Retention: retentionDays days | Tags: tags
   */
  private static formatMemory(element: MemoryElement): string {
    const retentionDays = element.metadata.retentionDays?.toString() || DEFAULTS.RETENTION;
    const tags = element.metadata.tags?.map(t => this.normalize(t)).join(', ') || DEFAULTS.TAGS;
    const version = this.normalize(element.version) || this.normalize(element.metadata.version) || DEFAULTS.VERSION;
    const name = this.normalize(element.metadata.name);
    const description = this.normalize(element.metadata.description);

    return (
      `🧠 ${name} (v${version}) - ${description}\n` +
      `   Retention: ${retentionDays} days | Tags: ${tags}`
    );
  }

  /**
   * Format an ensemble element for display
   *
   * @param element The ensemble element to format
   * @returns Formatted string representation
   *
   * @example
   * // Returns:
   * // 🎭 Research Team (v1.0.0) - Coordinated research workflow
   * //    Elements: 3 | Strategy: parallel
   *
   * Output format:
   * 🎭 Name (vVersion) - Description
   *    Elements: elementCount | Strategy: strategy
   */
  private static formatEnsemble(element: EnsembleElement): string {
    const elementCount = element.metadata.elements?.length || 0;
    const strategy = this.normalize(element.metadata.activationStrategy) || DEFAULTS.STRATEGY;
    const version = this.normalize(element.version) || this.normalize(element.metadata.version) || DEFAULTS.VERSION;
    const name = this.normalize(element.metadata.name);
    const description = this.normalize(element.metadata.description);

    return (
      `🎭 ${name} (v${version}) - ${description}\n` +
      `   Elements: ${elementCount} | Strategy: ${strategy}`
    );
  }
}
