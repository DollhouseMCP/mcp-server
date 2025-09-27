/**
 * Persona loading and file management
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';
import { Persona, PersonaMetadata } from '../types/persona.js';
import { ensureDirectory, generateUniqueId } from '../utils/filesystem.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { SecurityError } from '../errors/SecurityError.js';
import { logger } from '../utils/logger.js';
import { PortfolioManager, ElementType } from '../portfolio/PortfolioManager.js';
import { FileLockManager } from '../security/fileLockManager.js';
import { sanitizeInput } from '../security/InputValidator.js';

// Trigger validation constants
// NOTE: These are intentionally NOT shared across element types.
// Each element type has domain-specific requirements:
// - Personas: Character names, aliases, multi-word triggers
// - Skills: Technical terms, version numbers, command patterns
// - Memories: Date-based, semantic, natural language triggers
// - Templates: Format indicators, hierarchical paths
// - Agents: Goal-oriented, role-based, mention patterns
// Future element types will likely have unique validation needs.
// Premature abstraction would limit flexibility.
const MAX_TRIGGER_LENGTH = 50;
const MAX_TRIGGERS = 20;
const TRIGGER_VALIDATION_REGEX = /^[a-zA-Z0-9\-_]+$/;

export class PersonaLoader {
  private personasDir: string;
  private portfolioManager: PortfolioManager;

  constructor(personasDir?: string) {
    // Use PortfolioManager for new portfolio structure
    this.portfolioManager = PortfolioManager.getInstance();
    // If personasDir is provided, it's for legacy compatibility
    // Otherwise use the portfolio personas directory
    this.personasDir = personasDir || this.portfolioManager.getElementDir(ElementType.PERSONA);
  }

  /**
   * Validates and processes triggers for a persona
   * Extracted method to reduce cognitive complexity (SonarCloud)
   * @private
   */
  private validateAndProcessTriggers(triggers: any[], personaName: string): string[] {
    const validTriggers: string[] = [];
    const rejectedTriggers: string[] = [];
    const originalCount = triggers.length;
    const rawTriggers = triggers.slice(0, MAX_TRIGGERS);

    for (const raw of rawTriggers) {
      const sanitized = sanitizeInput(String(raw), MAX_TRIGGER_LENGTH);
      if (sanitized) {
        if (TRIGGER_VALIDATION_REGEX.test(sanitized)) {
          validTriggers.push(sanitized);
        } else {
          rejectedTriggers.push(`"${sanitized}" (invalid format - must be alphanumeric with hyphens/underscores only)`);
        }
      } else {
        rejectedTriggers.push(`"${raw}" (empty after sanitization)`);
      }
    }

    // Enhanced logging for debugging
    if (rejectedTriggers.length > 0) {
      logger.warn(
        `Persona "${personaName}": Rejected ${rejectedTriggers.length} invalid trigger(s)`,
        {
          personaName,
          rejectedTriggers,
          acceptedCount: validTriggers.length
        }
      );
    }

    // Warn if trigger limit was exceeded
    if (originalCount > MAX_TRIGGERS) {
      logger.warn(
        `Persona "${personaName}": Trigger limit exceeded`,
        {
          personaName,
          providedCount: originalCount,
          limit: MAX_TRIGGERS,
          truncated: originalCount - MAX_TRIGGERS
        }
      );
    }

    return validTriggers;
  }

  /**
   * Load all personas from the personas directory
   */
  async loadAll(getCurrentUser: () => string | null): Promise<Map<string, Persona>> {
    // Ensure directory exists
    await ensureDirectory(this.personasDir);
    
    const personas = new Map<string, Persona>();
    
    try {
      const files = await fs.readdir(this.personasDir);
      const markdownFiles = files.filter(file => file.endsWith('.md'));
      
      for (const file of markdownFiles) {
        try {
          const persona = await this.loadPersona(file, getCurrentUser);
          if (persona) {
            personas.set(file, persona);
            logger.debug(`Loaded persona: ${persona.metadata.name} (${persona.unique_id})`);
          }
        } catch (error) {
          logger.error(`Error loading persona ${file}:`, error);
        }
      }
    } catch (error) {
      logger.error(`Error reading personas directory:`, error);
    }
    
    return personas;
  }
  
  /**
   * Load a single persona from file
   */
  async loadPersona(filename: string, getCurrentUser: () => string | null): Promise<Persona | null> {
    try {
      const filePath = path.join(this.personasDir, filename);
      const fileContent = await fs.readFile(filePath, 'utf-8');
      
      // DIAGNOSTIC: Log file content size
      logger.debug(`[CONTENT-TRACE] Loading ${filename} - file size: ${fileContent.length} chars`);
      
      // Use secure YAML parser instead of direct gray-matter
      let parsed;
      try {
        parsed = SecureYamlParser.safeMatter(fileContent);
      } catch (error) {
        if (error instanceof SecurityError) {
          logger.error(`Security threat detected in persona ${filename}: ${error.message}`);
          return null;
        }
        throw error;
      }
      
      const metadata = parsed.data as PersonaMetadata;
      const content = parsed.content;
      
      // DIAGNOSTIC: Log parsed content size
      logger.debug(`[CONTENT-TRACE] Parsed ${filename} - content size: ${content.length} chars`);
      
      if (!metadata.name) {
        metadata.name = path.basename(filename, '.md');
      }
      
      // Generate unique ID if not present
      let uniqueId = metadata.unique_id;
      if (!uniqueId) {
        const authorForId = metadata.author || getCurrentUser() || undefined;
        uniqueId = generateUniqueId(metadata.name, authorForId);
        logger.debug(`Generated unique ID for ${metadata.name}: ${uniqueId}`);
      }
      
      // Set default values for metadata fields
      this.setDefaultMetadata(metadata);

      // Enhanced trigger validation and logging for Issue #1139
      if (metadata.triggers && Array.isArray(metadata.triggers)) {
        metadata.triggers = this.validateAndProcessTriggers(
          metadata.triggers,
          metadata.name
        );
      }

      const persona: Persona = {
        metadata,
        content,
        filename,
        unique_id: uniqueId,
      };
      
      return persona;
    } catch (error) {
      logger.error(`Error loading persona ${filename}:`, error);
      return null;
    }
  }
  
  /**
   * Save a persona to file
   */
  async savePersona(persona: Persona): Promise<void> {
    const filePath = path.join(this.personasDir, persona.filename);
    
    // DIAGNOSTIC: Log content size before save
    logger.debug(`[CONTENT-TRACE] Saving ${persona.filename} - content size: ${persona.content.length} chars`);
    
    // Use secure YAML stringification
    const secureParser = SecureYamlParser.createSecureMatterParser();
    const fileContent = secureParser.stringify(persona.content, persona.metadata);
    
    // DIAGNOSTIC: Log stringified content size
    logger.debug(`[CONTENT-TRACE] Stringified ${persona.filename} - file content size: ${fileContent.length} chars`);
    
    // SECURITY FIX: Replace direct file write with atomic operation
    // FIXED: CVE-2025-XXXX - Non-atomic file write in persona save operation
    // Original issue: Line 120 used direct fs.writeFile instead of atomic operation
    // Security impact: Race conditions could cause data corruption or partial writes
    // Fix: Replaced with FileLockManager.atomicWriteFile for guaranteed atomicity
    await FileLockManager.atomicWriteFile(filePath, fileContent, { encoding: 'utf-8' });
    
    // DIAGNOSTIC: Verify file was written correctly
    const writtenContent = await fs.readFile(filePath, 'utf-8');
    logger.debug(`[CONTENT-TRACE] Verified ${persona.filename} - actual file size: ${writtenContent.length} chars`);
  }
  
  /**
   * Delete a persona file
   */
  async deletePersona(filename: string): Promise<void> {
    const filePath = path.join(this.personasDir, filename);
    await fs.unlink(filePath);
  }
  
  /**
   * Check if a persona file exists
   */
  async personaExists(filename: string): Promise<boolean> {
    try {
      const filePath = path.join(this.personasDir, filename);
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Set default metadata values
   */
  private setDefaultMetadata(metadata: PersonaMetadata): void {
    if (!metadata.category) metadata.category = 'general';
    if (!metadata.age_rating) metadata.age_rating = 'all';
    if (!metadata.content_flags) metadata.content_flags = [];
    if (metadata.ai_generated === undefined) metadata.ai_generated = false;
    if (!metadata.generation_method) metadata.generation_method = 'human';
    if (!metadata.price) metadata.price = 'free';
    if (!metadata.license) metadata.license = 'CC-BY-SA-4.0';
  }
}