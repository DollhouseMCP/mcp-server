/**
 * PersonaElementManager - Implementation of IElementManager for PersonaElement
 * Handles CRUD operations and lifecycle management for personas implementing IElement
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { IElementManager, ElementValidationResult } from '../types/elements/index.js';
import { ElementType } from '../portfolio/types.js';
import { PersonaElement, PersonaElementMetadata } from './PersonaElement.js';
import { PortfolioManager } from '../portfolio/PortfolioManager.js';
import { logger } from '../utils/logger.js';
import { validatePath, validateFilename } from '../security/InputValidator.js';
import { ensureDirectory } from '../utils/filesystem.js';

export class PersonaElementManager implements IElementManager<PersonaElement> {
  private portfolioManager: PortfolioManager;
  private personasDir: string;

  constructor(portfolioManager?: PortfolioManager) {
    this.portfolioManager = portfolioManager || PortfolioManager.getInstance();
    this.personasDir = this.portfolioManager.getElementDir(ElementType.PERSONA);
  }

  /**
   * Load a persona from file
   */
  async load(filePath: string): Promise<PersonaElement> {
    try {
      // Resolve full path if relative
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.personasDir, filePath);
      
      // Validate path security
      if (!this.validatePath(fullPath)) {
        throw new Error(`Invalid or unsafe path: ${filePath}`);
      }

      const content = await fs.readFile(fullPath, 'utf-8');
      
      // Create a new PersonaElement and deserialize
      const persona = new PersonaElement({}, '', path.basename(fullPath));
      persona.deserialize(content);
      
      logger.debug(`Loaded persona: ${persona.metadata.name} from ${filePath}`);
      return persona;

    } catch (error) {
      logger.error(`Failed to load persona from ${filePath}: ${error}`);
      throw new Error(`Failed to load persona: ${error}`);
    }
  }

  /**
   * Save a persona to file
   */
  async save(element: PersonaElement, filePath: string): Promise<void> {
    try {
      // Ensure personas directory exists
      await ensureDirectory(this.personasDir);

      // Resolve full path if relative
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.personasDir, filePath);
      
      // Validate path security
      if (!this.validatePath(fullPath)) {
        throw new Error(`Invalid or unsafe path: ${filePath}`);
      }

      // Serialize the persona
      const content = element.serialize();
      
      // Write to file
      await fs.writeFile(fullPath, content, 'utf-8');
      
      // Update filename in element
      element.filename = path.basename(fullPath);
      
      logger.debug(`Saved persona: ${element.metadata.name} to ${filePath}`);

    } catch (error) {
      logger.error(`Failed to save persona to ${filePath}: ${error}`);
      throw new Error(`Failed to save persona: ${error}`);
    }
  }

  /**
   * Delete a persona file
   */
  async delete(filePath: string): Promise<void> {
    try {
      // Resolve full path if relative
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.personasDir, filePath);
      
      // Validate path security
      if (!this.validatePath(fullPath)) {
        throw new Error(`Invalid or unsafe path: ${filePath}`);
      }

      await fs.unlink(fullPath);
      logger.debug(`Deleted persona file: ${filePath}`);

    } catch (error) {
      logger.error(`Failed to delete persona ${filePath}: ${error}`);
      throw new Error(`Failed to delete persona: ${error}`);
    }
  }

  /**
   * Check if a persona file exists
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      // Resolve full path if relative
      const fullPath = path.isAbsolute(filePath) ? filePath : path.join(this.personasDir, filePath);
      
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all personas
   */
  async list(): Promise<PersonaElement[]> {
    try {
      // Ensure directory exists
      await ensureDirectory(this.personasDir);

      const files = await fs.readdir(this.personasDir);
      const markdownFiles = files.filter(file => file.endsWith('.md'));
      
      const personas: PersonaElement[] = [];
      
      for (const file of markdownFiles) {
        try {
          const persona = await this.load(file);
          personas.push(persona);
        } catch (error) {
          logger.error(`Error loading persona ${file}: ${error}`);
          // Continue with other personas
        }
      }

      logger.debug(`Loaded ${personas.length} personas from ${this.personasDir}`);
      return personas;

    } catch (error) {
      logger.error(`Failed to list personas: ${error}`);
      return [];
    }
  }

  /**
   * Find a persona by predicate
   */
  async find(predicate: (element: PersonaElement) => boolean): Promise<PersonaElement | undefined> {
    const personas = await this.list();
    return personas.find(predicate);
  }

  /**
   * Find multiple personas by predicate
   */
  async findMany(predicate: (element: PersonaElement) => boolean): Promise<PersonaElement[]> {
    const personas = await this.list();
    return personas.filter(predicate);
  }

  /**
   * Validate a persona element
   */
  validate(element: PersonaElement): ElementValidationResult {
    return element.validate();
  }

  /**
   * Validate a file path
   */
  validatePath(filePath: string): boolean {
    try {
      validatePath(filePath);
      
      // Additional check: must be .md file
      if (!filePath.endsWith('.md')) {
        return false;
      }
      
      // Must be within personas directory
      const fullPath = path.resolve(filePath);
      const personasDirPath = path.resolve(this.personasDir);
      
      return fullPath.startsWith(personasDirPath);
      
    } catch {
      return false;
    }
  }

  /**
   * Get element type
   */
  getElementType(): ElementType {
    return ElementType.PERSONA;
  }

  /**
   * Get file extension
   */
  getFileExtension(): string {
    return '.md';
  }

  /**
   * Import persona from data
   */
  async importElement(data: string, format: 'json' | 'yaml' | 'markdown' = 'markdown'): Promise<PersonaElement> {
    try {
      const persona = new PersonaElement({});
      
      if (format === 'markdown') {
        persona.deserialize(data);
      } else if (format === 'json') {
        const jsonData = JSON.parse(data);
        persona.deserialize(this.jsonToMarkdown(jsonData));
      } else if (format === 'yaml') {
        // Convert YAML to markdown format
        const yamlData = require('js-yaml').load(data);
        persona.deserialize(this.jsonToMarkdown(yamlData));
      } else {
        throw new Error(`Unsupported format: ${format}`);
      }

      return persona;

    } catch (error) {
      logger.error(`Failed to import persona: ${error}`);
      throw new Error(`Import failed: ${error}`);
    }
  }

  /**
   * Export persona to data
   */
  async exportElement(element: PersonaElement, format: 'json' | 'yaml' | 'markdown' = 'markdown'): Promise<string> {
    try {
      if (format === 'markdown') {
        return element.serialize();
      } else if (format === 'json') {
        const legacy = element.toLegacy();
        return JSON.stringify({ ...legacy, content: element.content }, null, 2);
      } else if (format === 'yaml') {
        const legacy = element.toLegacy();
        return require('js-yaml').dump({ ...legacy, content: element.content });
      } else {
        throw new Error(`Unsupported format: ${format}`);
      }

    } catch (error) {
      logger.error(`Failed to export persona: ${error}`);
      throw new Error(`Export failed: ${error}`);
    }
  }

  /**
   * Helper: Convert JSON data to markdown format
   */
  private jsonToMarkdown(data: any): string {
    const { content, ...metadata } = data;
    const yamlFrontmatter = require('js-yaml').dump(metadata);
    return `---\n${yamlFrontmatter}---\n\n${content || ''}`;
  }

  /**
   * Create a new persona with default metadata
   */
  create(metadata: Partial<PersonaElementMetadata>): PersonaElement {
    const defaultMetadata: Partial<PersonaElementMetadata> = {
      name: 'New Persona',
      description: 'A new persona',
      version: '1.0.0',
      category: 'personal',
      age_rating: 'all',
      ai_generated: false,
      generation_method: 'human',
      price: 'free',
      license: 'CC-BY-SA-4.0',
      created_date: new Date().toISOString().split('T')[0],
      triggers: [],
      content_flags: []
    };

    return new PersonaElement({ ...defaultMetadata, ...metadata });
  }

  /**
   * Get default filename for a persona
   */
  getDefaultFilename(persona: PersonaElement): string {
    // Convert name to safe filename
    const safeName = persona.metadata.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    
    return `${safeName}.md`;
  }
}