/**
 * Persona import functionality with validation
 */

import * as path from 'path';
import { Persona, PersonaMetadata } from '../../types/persona.js';
import { ExportedPersona, ExportBundle } from './PersonaExporter.js';
import { SecureYamlParser } from '../../security/secureYamlParser.js';
import { ContentValidator } from '../../security/contentValidator.js';
import { validateFilename, validatePath, validateContentSize } from '../../security/InputValidator.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { generateUniqueId } from '../../utils/filesystem.js';
import { logger } from '../../utils/logger.js';
import matter from 'gray-matter';
import { IFileOperationsService } from '../../services/FileOperationsService.js';

// Map-like interface for existing personas lookup
type PersonaMap = Map<string, Persona> | {
  has: (key: string) => boolean;
  keys: () => Iterable<string>;
  [Symbol.iterator]: () => Iterator<[string, Persona]>;
};

export interface ImportResult {
  success: boolean;
  message: string;
  persona?: Persona;
  filename?: string;
  conflicts?: string[];
}

type CurrentUserProvider = () => string | null;

export class PersonaImporter {
  private readonly getCurrentUser: CurrentUserProvider;
  private readonly fileOperations: IFileOperationsService;

  constructor(
    _personasDir: string,
    currentUser: string | null | CurrentUserProvider,
    _fileLockManager?: unknown,
    fileOperations?: IFileOperationsService
  ) {
    if (typeof currentUser === 'function') {
      this.getCurrentUser = currentUser as CurrentUserProvider;
    } else {
      this.getCurrentUser = () => currentUser;
    }
    this.fileOperations = fileOperations!;
  }

  /**
   * Import a persona from various sources
   */
  async importPersona(source: string, existingPersonas: PersonaMap, overwrite = false): Promise<ImportResult> {
    try {
      // Determine source type
      let personaData: ExportedPersona | null = null;

      // Check if it's a file path
      if (source.startsWith('/') || source.startsWith('./') || source.endsWith('.md') || source.endsWith('.json')) {
        personaData = await this.importFromFile(source);
      } 
      // Check if it's base64 encoded
      else if (this.isBase64(source)) {
        personaData = await this.importFromBase64(source);
      }
      // Try parsing as JSON directly
      else {
        try {
          const parsed = JSON.parse(source);
          if (this.isExportBundle(parsed)) {
            return this.importBundle(parsed, existingPersonas, overwrite);
          } else if (this.isExportedPersona(parsed)) {
            personaData = parsed;
          }
        } catch {
          // Not JSON, might be raw markdown
          return this.importFromMarkdown(source, existingPersonas, overwrite);
        }
      }

      if (!personaData) {
        return {
          success: false,
          message: "Could not parse import source. Please provide a file path, JSON string, or base64 encoded data."
        };
      }

      // Validate and create persona
      return await this.createPersonaFromExport(personaData, existingPersonas, overwrite);

    } catch (error) {
      logger.error('Import error', error);
      return {
        success: false,
        message: `Import failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Import from file path
   */
  private async importFromFile(filePath: string): Promise<ExportedPersona | null> {
    try {
      // Validate path
      const validatedPath = validatePath(filePath);
      const content = await this.fileOperations.readFile(validatedPath, { source: 'PersonaImporter.importFromFile' });

      if (filePath.endsWith('.json')) {
        const parsed = JSON.parse(content);
        if (this.isExportedPersona(parsed)) {
          return parsed;
        } else if (this.isExportBundle(parsed)) {
          throw new Error("This is a bundle file. It will be imported as multiple personas.");
        }
      } else if (filePath.endsWith('.md')) {
        // Parse markdown file
        const { data, content: mdContent } = SecureYamlParser.safeMatter(content);
        const filename = path.basename(filePath);
        return {
          metadata: data as PersonaMetadata,
          content: mdContent,
          filename: filename,
          exportedAt: new Date().toISOString()
        };
      }
    } catch (error) {
      logger.error('File import error', error);
      throw error;
    }
    return null;
  }

  /**
   * Import from base64 string
   */
  private async importFromBase64(base64: string): Promise<ExportedPersona | null> {
    try {
      const json = Buffer.from(base64, 'base64').toString('utf-8');
      const parsed = JSON.parse(json);
      
      if (this.isExportedPersona(parsed)) {
        return parsed;
      } else if (this.isExportBundle(parsed)) {
        throw new Error("This is a bundle. It will be imported as multiple personas.");
      }
    } catch (error) {
      logger.error('Base64 import error', error);
    }
    return null;
  }

  /**
   * Import from raw markdown content
   */
  private async importFromMarkdown(content: string, existingPersonas: PersonaMap, overwrite: boolean): Promise<ImportResult> {
    try {
      // Validate content size
      validateContentSize(content, 100 * 1024); // 100KB limit

      // Try to parse as markdown with frontmatter
      const { data, content: mdContent } = SecureYamlParser.safeMatter(content);
      
      if (!data.name || !data.description) {
        return {
          success: false,
          message: "Invalid persona format. Must include name and description in YAML frontmatter."
        };
      }

      const metadata = data as PersonaMetadata;
      const filename = `${metadata.name.toLowerCase().replaceAll(/\s+/g, '-')}.md`;

      const exportedPersona: ExportedPersona = {
        metadata,
        content: mdContent,
        filename,
        exportedAt: new Date().toISOString(),
        exportedBy: this.getCurrentUser() || undefined
      };

      return await this.createPersonaFromExport(exportedPersona, existingPersonas, overwrite);
    } catch (error) {
      return {
        success: false,
        message: `Failed to parse markdown: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Import a bundle of personas
   */
  private async importBundle(bundle: ExportBundle, existingPersonas: PersonaMap, overwrite: boolean): Promise<ImportResult> {
    const results = {
      success: true,
      imported: [] as string[],
      failed: [] as string[],
      conflicts: [] as string[]
    };

    for (const personaData of bundle.personas) {
      const result = await this.createPersonaFromExport(personaData, existingPersonas, overwrite);
      
      if (result.success) {
        results.imported.push(personaData.metadata.name);
      } else {
        results.failed.push(`${personaData.metadata.name}: ${result.message}`);
        if (result.conflicts) {
          results.conflicts.push(...result.conflicts);
        }
      }
    }

    return {
      success: results.failed.length === 0,
      message: this.formatBundleImportResult(results),
      conflicts: results.conflicts.length > 0 ? results.conflicts : undefined
    };
  }

  /**
   * Create persona from exported data
   */
  private async createPersonaFromExport(
    exportData: ExportedPersona,
    existingPersonas: PersonaMap,
    overwrite: boolean
  ): Promise<ImportResult> {
    try {
      // Validate metadata
      const metadata = await this.validateAndEnrichMetadata(exportData.metadata);
      
      // Validate and normalize Unicode content first
      const unicodeResult = UnicodeValidator.normalize(exportData.content);
      if (unicodeResult.severity === 'critical') {
        throw new Error(`Critical Unicode security threat detected: ${unicodeResult.detectedIssues?.join(', ')}`);
      }
      const unicodeNormalizedContent = unicodeResult.normalizedContent;

      // Then validate content for other security threats
      const validationResult = ContentValidator.validateAndSanitize(unicodeNormalizedContent);
      if (!validationResult.isValid && validationResult.severity === 'critical') {
        throw new Error(`Critical security threat detected: ${validationResult.detectedPatterns?.join(', ')}`);
      }
      const sanitizedContent = validationResult.sanitizedContent || unicodeNormalizedContent;

      // Generate safe filename
      let filename = validateFilename(exportData.filename || `${metadata.name.toLowerCase().replaceAll(/\s+/g, '-')}.md`);
      
      // Check for conflicts
      const conflicts = this.findConflicts(metadata.name, filename, existingPersonas);
      if (conflicts.length > 0 && !overwrite) {
        return {
          success: false,
          message: `Persona already exists: ${conflicts.join(', ')}. Use overwrite=true to replace.`,
          conflicts
        };
      }

      // Fix #917: Restore instructions from export data so they survive the round-trip.
      // Instructions are placed on metadata so PersonaManager.createElement() picks them up
      // via the v2 format path (instructions from metadata, body as content).
      if (exportData.instructions) {
        (metadata as any).instructions = exportData.instructions;
      }

      // Create persona object
      const persona: Persona = {
        id: metadata.unique_id!,
        type: 'persona' as any, // ElementType.PERSONA
        version: metadata.version || '1.0',
        metadata,
        instructions: exportData.instructions || '',  // Fix #917: Preserve instructions
        content: sanitizedContent,
        filename,
        unique_id: metadata.unique_id!
      } as Persona;

      return {
        success: true,
        message: `Successfully imported "${metadata.name}"`,
        persona,
        filename
      };

    } catch (error) {
      logger.error('Create persona error', error);
      return {
        success: false,
        message: `Failed to create persona: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  /**
   * Validate and enrich metadata
   */
  private async validateAndEnrichMetadata(metadata: any): Promise<PersonaMetadata> {
    // Ensure required fields
    if (!metadata.name || !metadata.description) {
      throw new Error("Missing required fields: name and description");
    }

    // Validate and normalize Unicode in metadata fields
    const nameResult = UnicodeValidator.normalize(metadata.name);
    const descResult = UnicodeValidator.normalize(metadata.description);
    
    if (nameResult.severity === 'critical') {
      throw new Error(`Critical Unicode security threat in persona name: ${nameResult.detectedIssues?.join(', ')}`);
    }
    if (descResult.severity === 'critical') {
      throw new Error(`Critical Unicode security threat in persona description: ${descResult.detectedIssues?.join(', ')}`);
    }

    // Use normalized values
    metadata.name = nameResult.normalizedContent;
    metadata.description = descResult.normalizedContent;

    // Generate unique_id if missing
    if (!metadata.unique_id) {
      metadata.unique_id = generateUniqueId(metadata.name, this.getCurrentUser() || 'imported');
    }

    // Set defaults
    metadata.version = metadata.version || '1.0';
    const currentUser = this.getCurrentUser();
    metadata.author = metadata.author || currentUser || 'imported';
    metadata.category = metadata.category || 'custom';
    metadata.created_date = metadata.created_date || new Date().toISOString();

    // Validate with YAML parser for security using normalized metadata
    const validated = await SecureYamlParser.parse(matter.stringify('', metadata));

    return validated.data as PersonaMetadata;
  }

  /**
   * Find conflicts with existing personas
   */
  private findConflicts(name: string, filename: string, existingPersonas: PersonaMap): string[] {
    const conflicts: string[] = [];

    for (const [key, persona] of existingPersonas) {
      if (persona.metadata.name === name || persona.filename === filename) {
        conflicts.push(key);
      }
    }

    return conflicts;
  }

  /**
   * Check if string is base64
   */
  private isBase64(str: string): boolean {
    // Check length is multiple of 4
    if (str.length % 4 !== 0) return false;
    
    // SECURITY FIX: Ensure base64 string is not empty
    // Previously: /^[A-Za-z0-9+/]*={0,2}$/ allowed empty strings
    // Now: Require at least one character before optional padding
    return /^[A-Za-z0-9+/]+={0,2}$/.test(str);
  }

  /**
   * Type guard for ExportedPersona
   */
  private isExportedPersona(obj: any): obj is ExportedPersona {
    return obj && 
      typeof obj.metadata === 'object' &&
      typeof obj.content === 'string' &&
      typeof obj.filename === 'string';
  }

  /**
   * Type guard for ExportBundle
   */
  private isExportBundle(obj: any): obj is ExportBundle {
    return obj &&
      typeof obj.version === 'string' &&
      Array.isArray(obj.personas) &&
      typeof obj.personaCount === 'number';
  }

  /**
   * Format bundle import results
   */
  private formatBundleImportResult(results: any): string {
    let message = `Bundle Import Summary:\n`;
    message += `✅ Successfully imported: ${results.imported.length} personas\n`;
    
    if (results.imported.length > 0) {
      message += `Imported:\n${results.imported.map((n: string) => `  - ${n}`).join('\n')}\n`;
    }

    if (results.failed.length > 0) {
      message += `\n❌ Failed: ${results.failed.length} personas\n`;
      message += `Errors:\n${results.failed.map((e: string) => `  - ${e}`).join('\n')}`;
    }

    return message;
  }
}
