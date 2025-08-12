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
    
    // Use secure YAML stringification
    const secureParser = SecureYamlParser.createSecureMatterParser();
    const fileContent = secureParser.stringify(persona.content, persona.metadata);
    
    // SECURITY FIX: Replace direct file write with atomic operation
    // FIXED: CVE-2025-XXXX - Non-atomic file write in persona save operation
    // Original issue: Line 120 used direct fs.writeFile instead of atomic operation
    // Security impact: Race conditions could cause data corruption or partial writes
    // Fix: Replaced with FileLockManager.atomicWriteFile for guaranteed atomicity
    await FileLockManager.atomicWriteFile(filePath, fileContent, { encoding: 'utf-8' });
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