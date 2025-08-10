/**
 * Persona element class implementing IElement interface.
 * Represents a behavioral profile that defines AI personality and interaction style.
 */

import { BaseElement } from '../elements/BaseElement.js';
import { IElement, IElementMetadata, ElementValidationResult } from '../types/elements/index.js';
import { ElementType } from '../portfolio/types.js';
import { PersonaMetadata } from '../types/persona.js';
import { logger } from '../utils/logger.js';
import matter from 'gray-matter';

// Extend IElementMetadata with persona-specific fields
export interface PersonaElementMetadata extends IElementMetadata {
  triggers?: string[];
  category?: string;
  age_rating?: 'all' | '13+' | '18+';
  content_flags?: string[];
  ai_generated?: boolean;
  generation_method?: 'human' | 'ChatGPT' | 'Claude' | 'hybrid';
  price?: string;
  revenue_split?: string;
  license?: string;
  created_date?: string;
}

export class PersonaElement extends BaseElement implements IElement {
  public content: string;
  public filename: string;
  public declare metadata: PersonaElementMetadata;

  constructor(metadata: Partial<PersonaElementMetadata>, content: string = '', filename: string = '') {
    super(ElementType.PERSONA, metadata);
    this.content = content;
    this.filename = filename;
    
    // Ensure persona-specific metadata
    this.metadata = {
      ...this.metadata,
      triggers: metadata.triggers || [],
      category: metadata.category || 'personal',
      age_rating: metadata.age_rating || 'all',
      content_flags: metadata.content_flags || [],
      ai_generated: metadata.ai_generated || false,
      generation_method: metadata.generation_method || 'human',
      price: metadata.price || 'free',
      license: metadata.license || 'CC-BY-SA-4.0',
      created_date: metadata.created_date || new Date().toISOString().split('T')[0]
    };
  }

  /**
   * Create PersonaElement from legacy Persona interface
   */
  static fromLegacy(legacyPersona: { metadata: PersonaMetadata; content: string; filename: string; unique_id: string }): PersonaElement {
    const metadata: Partial<PersonaElementMetadata> = {
      name: legacyPersona.metadata.name,
      description: legacyPersona.metadata.description,
      author: legacyPersona.metadata.author,
      version: legacyPersona.metadata.version,
      triggers: legacyPersona.metadata.triggers,
      category: legacyPersona.metadata.category,
      age_rating: legacyPersona.metadata.age_rating,
      content_flags: legacyPersona.metadata.content_flags,
      ai_generated: legacyPersona.metadata.ai_generated,
      generation_method: legacyPersona.metadata.generation_method,
      price: legacyPersona.metadata.price,
      revenue_split: legacyPersona.metadata.revenue_split,
      license: legacyPersona.metadata.license,
      created_date: legacyPersona.metadata.created_date
    };

    const persona = new PersonaElement(metadata, legacyPersona.content, legacyPersona.filename);
    
    // Preserve the legacy unique_id as the element id
    persona.id = legacyPersona.unique_id;
    
    return persona;
  }

  /**
   * Convert to legacy Persona interface for backward compatibility
   */
  toLegacy(): { metadata: PersonaMetadata; content: string; filename: string; unique_id: string } {
    const legacyMetadata: PersonaMetadata = {
      name: this.metadata.name,
      description: this.metadata.description,
      unique_id: this.id,
      author: this.metadata.author,
      triggers: this.metadata.triggers,
      version: this.metadata.version,
      category: this.metadata.category,
      age_rating: this.metadata.age_rating,
      content_flags: this.metadata.content_flags,
      ai_generated: this.metadata.ai_generated,
      generation_method: this.metadata.generation_method,
      price: this.metadata.price,
      revenue_split: this.metadata.revenue_split,
      license: this.metadata.license,
      created_date: this.metadata.created_date
    };

    return {
      metadata: legacyMetadata,
      content: this.content,
      filename: this.filename,
      unique_id: this.id
    };
  }

  /**
   * Persona-specific validation
   */
  public override validate(): ElementValidationResult {
    const result = super.validate();
    
    // Initialize arrays if not present
    if (!result.errors) result.errors = [];
    if (!result.warnings) result.warnings = [];
    
    // Add persona-specific validation rules
    
    // Content should not be empty
    if (!this.content || this.content.trim().length === 0) {
      result.errors.push({
        field: 'content',
        message: 'Persona content cannot be empty',
        code: 'EMPTY_CONTENT'
      });
    }

    // Content should be reasonable length
    if (this.content && this.content.length > 10000) {
      result.warnings.push({
        field: 'content',
        message: 'Persona content is very long, consider breaking it down',
        severity: 'medium'
      });
    }

    // Triggers should be reasonable
    if (this.metadata.triggers && this.metadata.triggers.length > 10) {
      result.warnings.push({
        field: 'triggers',
        message: 'Many triggers may cause activation conflicts',
        severity: 'medium'
      });
    }

    // Check for adult content flags
    if (this.metadata.age_rating === '18+' && !this.metadata.content_flags?.includes('adult')) {
      result.warnings.push({
        field: 'content_flags',
        message: '18+ content should include "adult" in content_flags',
        severity: 'low'
      });
    }

    // Update the valid flag based on final errors
    result.valid = (result.errors?.length || 0) === 0;

    return result;
  }

  /**
   * Get content for serialization
   */
  protected override getContent(): string {
    return this.content;
  }

  /**
   * Serialize persona to markdown format
   */
  public override serialize(): string {
    const frontmatter = {
      name: this.metadata.name,
      description: this.metadata.description,
      unique_id: this.id,
      author: this.metadata.author,
      triggers: this.metadata.triggers,
      version: this.metadata.version,
      category: this.metadata.category,
      age_rating: this.metadata.age_rating,
      content_flags: this.metadata.content_flags,
      ai_generated: this.metadata.ai_generated,
      generation_method: this.metadata.generation_method,
      price: this.metadata.price,
      revenue_split: this.metadata.revenue_split,
      license: this.metadata.license,
      created_date: this.metadata.created_date
    };

    // Remove undefined values
    const cleanFrontmatter = Object.fromEntries(
      Object.entries(frontmatter).filter(([_, value]) => value !== undefined)
    );

    const yamlFrontmatter = Object.entries(cleanFrontmatter)
      .map(([key, value]) => {
        if (Array.isArray(value)) {
          if (value.length === 0) return `${key}: []`;
          return `${key}:\n${value.map(item => `  - ${item}`).join('\n')}`;
        }
        return `${key}: ${JSON.stringify(value)}`;
      })
      .join('\n');

    return `---\n${yamlFrontmatter}\n---\n\n${this.content}`;
  }

  /**
   * Deserialize persona from markdown format
   */
  public override deserialize(data: string): void {
    try {
      const parsed = matter(data);
      const metadata = parsed.data as PersonaMetadata;
      
      // Update metadata
      this.metadata = {
        ...this.metadata,
        name: metadata.name,
        description: metadata.description,
        author: metadata.author,
        version: metadata.version,
        triggers: metadata.triggers,
        category: metadata.category,
        age_rating: metadata.age_rating,
        content_flags: metadata.content_flags,
        ai_generated: metadata.ai_generated,
        generation_method: metadata.generation_method,
        price: metadata.price,
        revenue_split: metadata.revenue_split,
        license: metadata.license,
        created_date: metadata.created_date
      };
      
      // Update content (trim to remove leading/trailing whitespace)
      this.content = parsed.content.trim();
      
      // Update ID if provided
      if (metadata.unique_id) {
        this.id = metadata.unique_id;
      }
      
      this._isDirty = true;
      logger.debug(`Deserialized persona: ${this.metadata.name}`);
      
    } catch (error) {
      logger.error(`Failed to deserialize persona: ${error}`);
      throw new Error(`Deserialization failed: ${error}`);
    }
  }

  /**
   * Persona activation lifecycle
   */
  public override async activate(): Promise<void> {
    logger.info(`Activating persona: ${this.metadata.name} (${this.id})`);
    
    // Personas don't need special activation logic currently
    // But this provides a hook for future enhancements
    
    await super.activate?.();
  }

  /**
   * Persona deactivation lifecycle
   */
  public override async deactivate(): Promise<void> {
    logger.info(`Deactivating persona: ${this.metadata.name} (${this.id})`);
    
    // Personas don't need special deactivation logic currently
    // But this provides a hook for future enhancements
    
    await super.deactivate?.();
  }
}