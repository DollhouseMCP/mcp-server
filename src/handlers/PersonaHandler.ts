/**
 * PersonaHandler - Handles all persona-related MCP tool operations
 *
 * Provides the interface for activating, deactivating, listing, exporting,
 * and importing personas through MCP tools.
 *
 * Uses dependency injection for all services:
 * - PersonaManager for persona state and operations
 * - InitializationService for setup tasks
 * - PersonaIndicatorService for persona indicator formatting
 *
 * FIX: DMCP-SEC-006 - Security audit suppression
 * This handler delegates all operations to PersonaManager.
 * Audit logging happens in PersonaManager for CRUD operations.
 * @security-audit-suppress DMCP-SEC-006
 */

import { PersonaExporter, PersonaImporter } from '../persona/export-import/index.js';
import { SecureErrorHandler } from '../security/errorHandler.js';
import { MCPInputValidator } from '../security/InputValidator.js';
import { slugify } from '../utils/filesystem.js';
import { PersonaManager } from '../persona/PersonaManager.js';
import { InitializationService } from '../services/InitializationService.js';
import { PersonaIndicatorService } from '../services/PersonaIndicatorService.js';
import { sanitizeMetadata } from './element-crud/helpers.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { formatNotFoundError } from './element-crud/responseFormatter.js';
import { ElementType } from '../portfolio/PortfolioManager.js';

/**
 * Handles all persona-related MCP tool operations
 */
export class PersonaHandler {
  constructor(
    private readonly personaManager: PersonaManager,
    private readonly personaExporter: PersonaExporter,
    private readonly personaImporter: PersonaImporter | undefined,
    private readonly initService: InitializationService,
    private readonly indicatorService: PersonaIndicatorService,
    private readonly activePersona: {
      get: () => string | null;
      set: (value: string | null) => void;
    }
  ) {}

  /**
   * List all available personas
   * Extracted from index.ts:515-557
   */
  async listPersonas() {
    const personaList = (await this.personaManager.list()).map(persona => ({
      filename: persona.filename,
      unique_id: persona.unique_id,
      name: persona.metadata.name,
      description: persona.metadata.description,
      triggers: persona.metadata.triggers || [],
      version: persona.metadata.version || "1.0",
      author: persona.metadata.author || "Unknown",
      category: persona.metadata.category || 'general',
      age_rating: persona.metadata.age_rating || 'all',
      price: persona.metadata.price || 'free',
      ai_generated: persona.metadata.ai_generated || false,
      active: this.activePersona.get() === persona.filename,
    }));

    if (personaList.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `${this.indicatorService.getPersonaIndicator()}You don't have any personas installed yet. Would you like to browse the DollhouseMCP collection on GitHub to see what's available? I can show you personas for creative writing, technical analysis, and more. Just say "yes" or use 'browse_collection'.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `${this.indicatorService.getPersonaIndicator()}Available Personas (${personaList.length}):\n\n` +
            personaList.map(p =>
              `${p.active ? '🔹 ' : '▫️ '}**${p.name}** (${p.unique_id})\n` +
              `   ${p.description}\n` +
              `   📁 ${p.category} | 🎭 ${p.author} | 🔖 ${p.price} | ${p.ai_generated ? '🤖 AI' : '👤 Human'}\n` +
              `   Age: ${p.age_rating} | Version: ${p.version}\n` +
              `   Triggers: ${p.triggers.join(', ') || 'None'}\n`
            ).join('\n'),
        },
      ],
    };
  }

  /**
   * Activate a persona by identifier (filename or name)
   * Extracted from index.ts:559-592
   */
  async activatePersona(personaIdentifier: string) {
    const validatedIdentifier = MCPInputValidator.validatePersonaIdentifier(personaIdentifier);

    // FIX: DMCP-SEC-006 - Add security audit logging for persona activation
    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_ACTIVATED',
      severity: 'LOW',
      source: 'PersonaHandler.activatePersona',
      details: `Persona activation requested: ${validatedIdentifier}`,
      additionalData: { personaName: validatedIdentifier }
    });

    let persona = await this.personaManager.find(p =>
      p.filename === validatedIdentifier ||
      p.metadata.name.toLowerCase() === validatedIdentifier.toLowerCase()
    );

    if (!persona) {
      // FIX: Issue #20 - Return error response instead of throwing (using standardized formatter)
      const response = formatNotFoundError(ElementType.PERSONA, personaIdentifier, 'list_personas');
      // Add persona indicator prefix
      response.content[0].text = `${this.indicatorService.getPersonaIndicator()}${response.content[0].text}`;
      return response;
    }

    this.activePersona.set(persona.filename);

    return {
      content: [
        {
          type: "text",
          text: `${this.indicatorService.getPersonaIndicator()}Persona Activated: **${persona.metadata.name}**\n\n` +
            `${persona.metadata.description}\n\n` +
            `**Instructions:**\n${persona.content}`,
        },
      ],
    };
  }

  /**
   * Get currently active persona details
   * Extracted from index.ts:594-631
   */
  async getActivePersona() {
    if (!this.activePersona.get()) {
      return {
        content: [
          {
            type: "text",
            text: `${this.indicatorService.getPersonaIndicator()}No persona is currently active.`,
          },
        ],
      };
    }

    const persona = await this.personaManager.find(p => p.filename === this.activePersona.get()!);
    if (!persona) {
      this.activePersona.set(null);
      return {
        content: [
          {
            type: "text",
            text: `${this.indicatorService.getPersonaIndicator()}Active persona not found. Deactivated.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: `${this.indicatorService.getPersonaIndicator()}Active Persona: **${persona.metadata.name}**\n\n` +
            `${persona.metadata.description}\n\n` +
            `File: ${persona.filename}\n` +
            `Version: ${persona.metadata.version || '1.0'}\n` +
            `Author: ${persona.metadata.author || 'Unknown'}`,
        },
      ],
    };
  }

  /**
   * Deactivate the currently active persona
   * Extracted from index.ts:633-648
   */
  async deactivatePersona() {
    const wasActive = this.activePersona.get() !== null;
    const indicator = this.indicatorService.getPersonaIndicator();
    this.activePersona.set(null);

    return {
      content: [
        {
          type: "text",
          text: wasActive
            ? `${indicator}✅ Persona deactivated. Back to default mode.`
            : "No persona was active.",
        },
      ],
    };
  }

  /**
   * Get detailed information about a specific persona
   * Extracted from index.ts:650-690
   */
  async getPersonaDetails(personaIdentifier: string) {
    let persona = await this.personaManager.find(p =>
      p.filename === personaIdentifier ||
      p.metadata.name.toLowerCase() === personaIdentifier.toLowerCase() ||
      slugify(p.metadata.name || '') === slugify(personaIdentifier)
    );

    if (!persona) {
      // FIX: Issue #20 - Return error response instead of throwing (using standardized formatter)
      const response = formatNotFoundError(ElementType.PERSONA, personaIdentifier, 'list_personas');
      // Add persona indicator prefix
      response.content[0].text = `${this.indicatorService.getPersonaIndicator()}${response.content[0].text}`;
      return response;
    }

    return {
      content: [
        {
          type: "text",
          text: `${this.indicatorService.getPersonaIndicator()}📋 **${persona.metadata.name}** Details\n\n` +
            `**Description:** ${persona.metadata.description}\n` +
            `**File:** ${persona.filename}\n` +
            `**Version:** ${persona.metadata.version || '1.0'}\n` +
            `**Author:** ${persona.metadata.author || 'Unknown'}\n` +
            `**Triggers:** ${persona.metadata.triggers?.join(', ') || 'None'}\n\n` +
            `**Full Content:**\n\`\`\`\n${persona.content}\n\`\`\``,
        },
      ],
    };
  }





  /**
   * Reload personas from disk
   * Extracted from index.ts:692-702
   */
  async reloadPersonas() {
    await this.personaManager.reload();
    const personas = await this.personaManager.list();
    return {
      content: [
        {
          type: "text",
          text: `${this.indicatorService.getPersonaIndicator()}🔄 Reloaded ${personas.length} personas`,
        },
      ],
    };
  }

  /**
   * Create a new persona
   * Extracted from index.ts:3753-4029 (277 lines - exact copy)
   */
  async createPersona(
    name: string,
    description: string,
    instructions: string,
    triggers?: string,
    metadata?: Record<string, any>
  ) {
    await this.initService.ensureInitialized();

    try {
      if (!name || !description || !instructions) {
        return {
          content: [
            {
              type: "text",
              text: `${this.indicatorService.getPersonaIndicator()}❌ **Missing Required Fields**\n\n` +
                `Please provide all required fields:\n` +
                `• **name**: Display name for the persona\n` +
                `• **description**: Brief description of what it does\n` +
                `• **instructions**: The persona's behavioral guidelines\n\n` +
                `**Optional:**\n` +
                `• **triggers**: Comma-separated keywords for activation`,
            },
          ],
        };
      }

      const sanitizedMetadata = metadata ? sanitizeMetadata(metadata) : undefined;

      // Use unified create() API (v2 refactor)
      const newPersona = await this.personaManager.create({
        name,
        description,
        instructions,
        triggers: triggers ? triggers.split(',').map(t => t.trim()) : undefined,
        ...sanitizedMetadata
      });

      // FIX: DMCP-SEC-006 - Add security audit logging for persona creation
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_CREATED',
        severity: 'LOW',
        source: 'PersonaHandler.createPersona',
        details: `Persona created: ${newPersona.metadata.name}`,
        additionalData: { personaId: newPersona.unique_id }
      });

      return {
        content: [
          {
            type: "text",
            text: `${this.indicatorService.getPersonaIndicator()}✅ **Persona Created Successfully!**\n\n` +
              `🎭 **${newPersona.metadata.name}** by ${newPersona.metadata.author}\n` +
              `🆔 Unique ID: ${newPersona.unique_id}\n` +
              `📄 Saved as: ${newPersona.filename}\n` +
              `📊 Total personas: ${(await this.personaManager.list()).length}\n\n` +
              `🎯 **Ready to use:** \`activate_persona "${newPersona.metadata.name}"\`\n` +
              `📤 **Share it:** \`submit_collection_content "${newPersona.metadata.name}"\`\n` +
              `✏️ **Edit it:** \`edit_persona "${newPersona.metadata.name}" "field" "new value"\``,
          },
        ],
      };
    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      return {
        content: [
          {
            type: "text",
            text: `${this.indicatorService.getPersonaIndicator()}❌ **Error Creating Persona**\n\n` +
              `${sanitized.message}\n\n` +
              `Please check permissions and try again.`,
          },
        ],
      };
    }
  }

  /**
   * Export a persona to base64-encoded JSON
   * Extracted from index.ts:4635-4670
   */
  async exportPersona(personaName: string) {
    try {
      const persona = await this.personaManager.find(p => p.filename === personaName || p.metadata.name === personaName);
      if (!persona) {
        return {
          content: [{
            type: "text",
            text: `${this.indicatorService.getPersonaIndicator()}❌ Persona not found: ${personaName}`
          }]
        };
      }

      const exportDataStr = await this.personaManager.exportElement(persona);
      const exportData = JSON.parse(exportDataStr);
      const base64 = this.personaExporter.toBase64(exportData);
      const result = this.personaExporter.formatExportResult(persona, base64);

      return {
        content: [{
          type: "text",
          text: `${this.indicatorService.getPersonaIndicator()}${result}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `${this.indicatorService.getPersonaIndicator()}❌ Export failed: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Export all personas as a bundle
   * Extracted from index.ts:4790-4810
   */
  async exportAllPersonas(includeDefaults = true) {
    try {
      const personasArray = await this.personaManager.list();
      const bundle = this.personaExporter.exportBundle(personasArray, includeDefaults);
      const base64 = this.personaExporter.toBase64(bundle);
      const result = this.personaExporter.formatBundleResult(bundle, base64);

      return {
        content: [{
          type: "text",
          text: `${this.indicatorService.getPersonaIndicator()}${result}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `${this.indicatorService.getPersonaIndicator()}❌ Export failed: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  /**
   * Import a persona from file path or JSON string
   * Extracted from index.ts:4701-4739
   */
  async importPersona(source: string, overwrite = false) {
    try {
      if (!this.personaImporter) {
        return {
          content: [{
            type: "text",
            text: `${this.indicatorService.getPersonaIndicator()}❌ Import functionality not available (initialization in progress)`
          }]
        };
      }
      const importResult = await this.personaManager.importPersona(source, overwrite);

      if (!importResult.success) {
        return {
          content: [{
            type: "text",
            text: `${this.indicatorService.getPersonaIndicator()}❌ Import failed: ${importResult.message}`
          }]
        };
      }

      const importedPersona = importResult.persona!;

      // After successful import, reload personas to update the cache
      await this.reloadPersonas();

      return {
        content: [{
          type: "text",
          text: `${this.indicatorService.getPersonaIndicator()}✅ Persona "${importedPersona.metadata.name}" imported successfully.\nTotal personas: ${(await this.personaManager.list()).length}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: "text",
          text: `${this.indicatorService.getPersonaIndicator()}❌ Import failed: ${SecureErrorHandler.sanitizeError(error).message}`
        }]
      };
    }
  }

  async editPersona(personaIdentifier: string, field: string, value: string) {
    if (!personaIdentifier || !field || !value) {
      return {
        content: [
          {
            type: "text",
            text: `${this.indicatorService.getPersonaIndicator()}❌ **Missing Parameters**\n\n` +
              `Usage: \`edit_persona "persona_name" "field" "new_value"\`\n\n` +
              `**Editable fields:**\n` +
              `• **name** - Display name\n` +
              `• **description** - Brief description\n` +
              `• **instructions** - Main persona content\n` +
              `• **triggers** - Comma-separated keywords\n` +
              `• **version** - Version number`,
          },
        ],
      };
    }

    const persona = await this.personaManager.find(p =>
      p.filename === personaIdentifier ||
      p.metadata.name.toLowerCase() === personaIdentifier.toLowerCase() ||
      slugify(p.metadata.name || '') === slugify(personaIdentifier)
    );

    if (!persona) {
      return {
        content: [
          {
            type: "text",
            text: `${this.indicatorService.getPersonaIndicator()}❌ **Persona Not Found**\n\n` +
              `Could not find persona: "${personaIdentifier}"\n\n` +
              `Use \`list_personas\` to see available personas.`,
          },
        ],
      };
    }

      const fieldAliasMap: Record<string, string> = {
        content: 'instructions'
      };
      const normalizedField = field.toLowerCase();
      const canonicalField = fieldAliasMap[normalizedField] ?? normalizedField;
      const fieldDisplay = fieldAliasMap[normalizedField]
        ? `${canonicalField} (alias: ${field})`
        : field;

      try {
        const updatedPersona = await this.personaManager.editExistingPersona(persona, field, value);

        return {
          content: [
            {
              type: "text",
              text: `${this.indicatorService.getPersonaIndicator()}✅ **Persona Updated Successfully!**\n\n` +
                `🎭 **${MCPInputValidator.sanitizeForDisplay(updatedPersona.metadata.name || '')}**\n` +
                `📝 **Field Updated:** ${fieldDisplay}\n` +
                `🔄 **New Value:** ${canonicalField === 'instructions' ? 'Content updated' : MCPInputValidator.sanitizeForDisplay(value)}\n` +
                `📊 **Version:** ${updatedPersona.version}\n` +
                `\n` +
                `Use \`get_persona_details "${MCPInputValidator.sanitizeForDisplay(updatedPersona.metadata.name || '')}"\` to see all changes.`,
            },
          ],
      };
    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      return {
        content: [
          {
            type: "text",
            text: `${this.indicatorService.getPersonaIndicator()}❌ **Error Updating Persona**\n\n` +
              `Failed to update persona: ${sanitized.message}\n\n` +
              `Please check file permissions and try again.`,
          },
        ],
      };
    }
  }

  async validatePersona(personaIdentifier: string) {
    if (!personaIdentifier) {
      return {
        content: [
          {
            type: "text",
            text: `${this.indicatorService.getPersonaIndicator()}❌ **Missing Persona Identifier**\n\n` +
              `Usage: \`validate_persona "persona_name"\`\n\n` +
              `Use \`list_personas\` to see available personas.`,
          },
        ],
      };
    }

    const persona = await this.personaManager.find(p =>
      p.filename === personaIdentifier ||
      p.metadata.name.toLowerCase() === personaIdentifier.toLowerCase() ||
      slugify(p.metadata.name || '') === slugify(personaIdentifier)
    );

    if (!persona) {
      return {
        content: [
          {
            type: "text",
            text: `${this.indicatorService.getPersonaIndicator()}❌ **Persona Not Found**\n\n` +
              `Could not find persona: "${personaIdentifier}"\n\n` +
              `Use \`list_personas\` to see available personas.`,
          },
        ],
      };
    }

    const indicator = this.indicatorService.getPersonaIndicator();
    const validationResult = this.personaManager.validatePersona(personaIdentifier);
    const issues = validationResult.report.errors ?? [];
    const warnings = validationResult.report.warnings ?? [];
    const statusLine = validationResult.success ? '✅ Status: Valid' : '❌ Status: Invalid';

    // Generate validation report
    let report = `${indicator}📋 **Validation Report: ${persona.metadata.name}**\n\n`;
    report += `${statusLine}\n\n`;

    if (issues.length === 0 && warnings.length === 0) {
      report += `✅ **All Checks Passed!**\n\n` +
        `🎭 **Persona:** ${persona.metadata.name}\n` +
        `📁 **Category:** ${persona.metadata.category || 'general'}\n` +
        `📊 **Version:** ${persona.metadata.version || '1.0'}\n` +
        `📝 **Content Length:** ${persona.content.length} characters\n` +
        `🔗 **Triggers:** ${persona.metadata.triggers?.length || 0} keywords\n\n` +
        `This persona meets all validation requirements and is ready for use!`;
    } else {
      if (issues.length > 0) {
        report += `❌ **Issues Found (${issues.length}):**\n`;
        issues.forEach((issue, i: number) => {
          report += `   ${i + 1}. [${issue.field}] ${issue.message}\n`;
        });
        report += '\n';
      }

      if (warnings.length > 0) {
        report += `⚠️ **Warnings (${warnings.length}):**\n`;
        warnings.forEach((warning, i: number) => {
          report += `   ${i + 1}. [${warning.field}] ${warning.message}\n`;
        });
        report += '\n';
      }

      if (issues.length > 0) {
        report += `**Recommendation:** Fix the issues above before using this persona.\n`;
        report += `Use \`edit_persona "${persona.metadata.name}" "field" "value"\` to make corrections.`;
      } else {
        report += `**Status:** Persona is functional but could be improved.\n`;
        report += `Address warnings above for optimal performance.`;
      }
    }

    return {
      content: [
        {
          type: "text",
          text: report,
        },
      ],
    };
  }

  async deletePersona(personaIdentifier: string) {
    if (!personaIdentifier) {
      return {
        content: [{
          type: "text",
          text: `${this.indicatorService.getPersonaIndicator()}❌ Missing persona identifier`
        }]
      };
    }

    const persona = await this.personaManager.find(p =>
      p.filename === personaIdentifier ||
      p.metadata.name.toLowerCase() === personaIdentifier.toLowerCase() ||
      slugify(p.metadata.name || '') === slugify(personaIdentifier)
    );

    if (!persona) {
      return {
        content: [{
          type: "text",
          text: `❌ Persona '${personaIdentifier}' not found`
        }]
      };
    }

    try {
      const deleteResult = await this.personaManager.deletePersona(persona.filename);
      if (!deleteResult.success) {
        return {
          content: [{
            type: "text",
            text: `❌ ${deleteResult.message}`
          }]
        };
      }

      if (this.activePersona.get() === persona.filename) {
        this.activePersona.set(null);
      }

      return {
        content: [{
          type: "text",
          text: `✅ Successfully deleted persona '${personaIdentifier}'`
        }]
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          content: [{
            type: "text",
            text: `❌ Persona '${personaIdentifier}' not found`
          }]
        };
      }
      throw error;
    }
  }
}
