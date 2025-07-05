/**
 * Core persona management operations
 */

import * as path from 'path';
import matter from 'gray-matter';
import { Persona, PersonaMetadata } from '../types/persona.js';
import { PersonaLoader } from './PersonaLoader.js';
import { PersonaValidator } from './PersonaValidator.js';
import { validateFilename, sanitizeInput } from '../security/InputValidator.js';
import { generateAnonymousId, generateUniqueId, slugify } from '../utils/filesystem.js';
import { IndicatorConfig, formatIndicator } from '../config/indicator-config.js';

export class PersonaManager {
  private personas: Map<string, Persona> = new Map();
  private activePersona: string | null = null;
  private currentUser: string | null = null;
  private loader: PersonaLoader;
  private validator: PersonaValidator;
  private indicatorConfig: IndicatorConfig;
  
  constructor(personasDir: string, indicatorConfig: IndicatorConfig) {
    this.loader = new PersonaLoader(personasDir);
    this.validator = new PersonaValidator();
    this.indicatorConfig = indicatorConfig;
  }
  
  /**
   * Initialize and load all personas
   */
  async initialize(): Promise<void> {
    this.personas = await this.loader.loadAll(() => this.getCurrentUserForAttribution());
  }
  
  /**
   * Reload all personas from disk
   */
  async reload(): Promise<void> {
    this.personas.clear();
    this.activePersona = null;
    await this.initialize();
  }
  
  /**
   * Get all loaded personas
   */
  getAllPersonas(): Map<string, Persona> {
    return this.personas;
  }
  
  /**
   * Find a persona by identifier (filename, name, or unique_id)
   */
  findPersona(identifier: string): Persona | undefined {
    // Try direct filename match
    let persona = this.personas.get(identifier);
    
    if (!persona) {
      // Try with .md extension
      persona = this.personas.get(`${identifier}.md`);
    }
    
    if (!persona) {
      // Search by name (case-insensitive)
      persona = Array.from(this.personas.values()).find(p => 
        p.metadata.name.toLowerCase() === identifier.toLowerCase()
      );
    }
    
    if (!persona) {
      // Search by unique_id
      persona = Array.from(this.personas.values()).find(p => 
        p.unique_id === identifier
      );
    }
    
    return persona;
  }
  
  /**
   * Activate a persona
   */
  activatePersona(identifier: string): { success: boolean; message: string; persona?: Persona } {
    const persona = this.findPersona(identifier);
    
    if (!persona) {
      return {
        success: false,
        message: `Persona not found: "${identifier}"`
      };
    }
    
    this.activePersona = persona.filename;
    
    return {
      success: true,
      message: `Activated persona: ${persona.metadata.name}`,
      persona
    };
  }
  
  /**
   * Deactivate the current persona
   */
  deactivatePersona(): { success: boolean; message: string } {
    if (!this.activePersona) {
      return {
        success: false,
        message: "No persona is currently active"
      };
    }
    
    const persona = this.personas.get(this.activePersona);
    const personaName = persona?.metadata.name || this.activePersona;
    
    this.activePersona = null;
    
    return {
      success: true,
      message: `Deactivated persona: ${personaName}`
    };
  }
  
  /**
   * Get the active persona
   */
  getActivePersona(): Persona | null {
    if (!this.activePersona) return null;
    return this.personas.get(this.activePersona) || null;
  }
  
  /**
   * Get persona indicator for responses
   */
  getPersonaIndicator(): string {
    if (!this.activePersona) return "";
    const persona = this.personas.get(this.activePersona);
    if (!persona) return "";
    
    return formatIndicator(this.indicatorConfig, {
      name: persona.metadata.name,
      version: persona.metadata.version,
      author: persona.metadata.author,
      category: persona.metadata.category
    });
  }
  
  /**
   * Create a new persona
   */
  async createPersona(
    name: string,
    description: string,
    category: string,
    instructions: string
  ): Promise<{ success: boolean; message: string; filename?: string }> {
    try {
      // Validate inputs
      const cleanName = sanitizeInput(name, 50);
      const cleanDescription = sanitizeInput(description, 200);
      
      if (!cleanName) {
        return { success: false, message: "Persona name cannot be empty" };
      }
      
      // Generate filename
      const baseFilename = slugify(cleanName) + '.md';
      const filename = validateFilename(baseFilename);
      
      // Check if already exists
      if (this.personas.has(filename)) {
        return { 
          success: false, 
          message: `A persona named "${cleanName}" already exists` 
        };
      }
      
      // Create metadata
      const metadata: PersonaMetadata = {
        name: cleanName,
        description: cleanDescription,
        category: category || 'general',
        version: '1.0',
        author: this.getCurrentUserForAttribution() || undefined,
        unique_id: generateUniqueId(cleanName, this.getCurrentUserForAttribution() || undefined),
        triggers: this.generateTriggers(cleanName),
        created_date: new Date().toISOString()
      };
      
      // Create persona
      const persona: Persona = {
        metadata,
        content: instructions,
        filename,
        unique_id: metadata.unique_id!
      };
      
      // Validate
      const validation = this.validator.validatePersona(persona);
      if (!validation.valid) {
        return {
          success: false,
          message: `Validation failed: ${validation.issues.join(', ')}`
        };
      }
      
      // Save to disk
      await this.loader.savePersona(persona);
      
      // Add to memory
      this.personas.set(filename, persona);
      
      return {
        success: true,
        message: `Created persona "${cleanName}" successfully`,
        filename
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to create persona: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  
  /**
   * Edit an existing persona
   */
  async editPersona(
    personaName: string,
    field: string,
    value: string
  ): Promise<{ success: boolean; message: string }> {
    const persona = this.findPersona(personaName);
    
    if (!persona) {
      return {
        success: false,
        message: `Persona not found: "${personaName}"`
      };
    }
    
    try {
      const oldVersion = persona.metadata.version || '1.0';
      
      switch (field.toLowerCase()) {
        case 'name':
          persona.metadata.name = sanitizeInput(value, 50);
          break;
        case 'description':
          persona.metadata.description = sanitizeInput(value, 200);
          break;
        case 'instructions':
        case 'content':
          persona.content = value;
          break;
        case 'category':
          persona.metadata.category = value;
          break;
        case 'triggers':
          persona.metadata.triggers = value.split(',').map(t => t.trim()).filter(t => t);
          break;
        case 'version':
          persona.metadata.version = value;
          break;
        default:
          return {
            success: false,
            message: `Unknown field: "${field}". Valid fields: name, description, instructions, category, triggers, version`
          };
      }
      
      // Auto-increment version if not explicitly setting version
      if (field !== 'version') {
        persona.metadata.version = this.incrementVersion(oldVersion);
      }
      
      // Validate
      const validation = this.validator.validatePersona(persona);
      if (!validation.valid) {
        return {
          success: false,
          message: `Validation failed: ${validation.issues.join(', ')}`
        };
      }
      
      // Save changes
      await this.loader.savePersona(persona);
      
      return {
        success: true,
        message: `Updated ${field} for "${persona.metadata.name}" (v${persona.metadata.version})`
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to edit persona: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  
  /**
   * Validate a persona
   */
  validatePersona(identifier: string): { found: boolean; validation?: ReturnType<PersonaValidator['validatePersona']> } {
    const persona = this.findPersona(identifier);
    
    if (!persona) {
      return { found: false };
    }
    
    return {
      found: true,
      validation: this.validator.validatePersona(persona)
    };
  }
  
  /**
   * Set current user identity
   */
  setUserIdentity(username: string | null, email?: string): void {
    this.currentUser = username;
    
    if (username) {
      process.env.DOLLHOUSE_USER = username;
      if (email) {
        process.env.DOLLHOUSE_EMAIL = email;
      }
    } else {
      delete process.env.DOLLHOUSE_USER;
      delete process.env.DOLLHOUSE_EMAIL;
    }
  }
  
  /**
   * Get current user identity
   */
  getUserIdentity(): { username: string | null; email: string | null } {
    return {
      username: process.env.DOLLHOUSE_USER || null,
      email: process.env.DOLLHOUSE_EMAIL || null
    };
  }
  
  /**
   * Clear user identity
   */
  clearUserIdentity(): void {
    this.setUserIdentity(null);
  }
  
  /**
   * Update indicator configuration
   */
  updateIndicatorConfig(config: IndicatorConfig): void {
    this.indicatorConfig = config;
  }
  
  /**
   * Get current indicator configuration
   */
  getIndicatorConfig(): IndicatorConfig {
    return this.indicatorConfig;
  }
  
  /**
   * Helper to get current user for attribution
   */
  private getCurrentUserForAttribution(): string {
    return this.currentUser || process.env.DOLLHOUSE_USER || generateAnonymousId();
  }
  
  /**
   * Generate trigger keywords from persona name
   */
  private generateTriggers(name: string): string[] {
    const words = name.toLowerCase().split(/\s+/);
    const triggers = [...words];
    
    // Add the full name as a trigger
    if (words.length > 1) {
      triggers.push(name.toLowerCase());
    }
    
    // Remove duplicates
    return [...new Set(triggers)].filter(t => t.length > 2);
  }
  
  /**
   * Increment version number
   */
  private incrementVersion(version: string): string {
    const parts = version.split('.');
    const patch = parseInt(parts[parts.length - 1]) || 0;
    parts[parts.length - 1] = (patch + 1).toString();
    return parts.join('.');
  }
}