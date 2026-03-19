/**
 * Persona export functionality
 */

import { Persona } from '../../types/persona.js';
import { isDefaultPersona } from '../../constants/defaultPersonas.js';
import { MAX_PERSONA_SIZE } from '../../constants/limits.js';

export interface ExportedPersona {
  metadata: any;
  content: string;
  filename: string;
  exportedAt: string;
  exportedBy?: string;
}

export interface ExportBundle {
  version: string;
  exportedAt: string;
  exportedBy?: string;
  personaCount: number;
  personas: ExportedPersona[];
}

type CurrentUserProvider = () => string | null;

export class PersonaExporter {
  private readonly getCurrentUser: CurrentUserProvider;

  constructor(currentUser: string | null | CurrentUserProvider) {
    if (typeof currentUser === 'function') {
      this.getCurrentUser = currentUser as CurrentUserProvider;
    } else {
      this.getCurrentUser = () => currentUser;
    }
  }

  /**
   * Export a single persona to JSON format
   */
  exportPersona(persona: Persona): ExportedPersona {
    // Check size limit
    const size = JSON.stringify(persona).length;
    if (size > MAX_PERSONA_SIZE) {
      throw new Error(`Persona too large (${Math.round(size/1024)}KB). Maximum size is ${Math.round(MAX_PERSONA_SIZE/1024)}KB`);
    }
    
    return {
      metadata: persona.metadata,
      content: persona.content,
      filename: persona.filename,
      exportedAt: new Date().toISOString(),
      exportedBy: this.getCurrentUser() || undefined
    };
  }

  /**
   * Export multiple personas to a bundle
   */
  exportBundle(personas: Persona[], includeDefaults: boolean = true): ExportBundle {
    const filteredPersonas = includeDefaults 
      ? personas 
      : personas.filter(p => !isDefaultPersona(p.filename));

    return {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      exportedBy: this.getCurrentUser() || undefined,
      personaCount: filteredPersonas.length,
      personas: filteredPersonas.map(p => this.exportPersona(p))
    };
  }

  /**
   * Convert export to base64 for easy sharing
   */
  toBase64(data: ExportedPersona | ExportBundle): string {
    const json = JSON.stringify(data, null, 2);
    return Buffer.from(json).toString('base64');
  }

  /**
   * Format export result for display
   */
  formatExportResult(persona: Persona, base64: string): string {
    return `✅ Successfully exported "${persona.metadata.name}"

📦 Export Details:
- Filename: ${persona.filename}
- Version: ${persona.metadata.version || '1.0'}
- Author: ${persona.metadata.author || 'unknown'}
- Size: ${base64.length} characters (base64)

📋 Export Data (Copy this to share):
\`\`\`
${base64}
\`\`\`

💡 To import this persona:
- Use: import_persona "<paste the base64 data here>"
- Or save to a file and use: import_persona "/path/to/file.json"`;
  }

  /**
   * Format bundle export result
   */
  formatBundleResult(bundle: ExportBundle, base64: string): string {
    const personaList = bundle.personas
      .map(p => `  - ${p.metadata.name} (${p.filename})`)
      .join('\n');

    return `✅ Successfully exported ${bundle.personaCount} personas

📦 Bundle Details:
- Export Version: ${bundle.version}
- Exported At: ${new Date(bundle.exportedAt).toLocaleString()}
- Exported By: ${bundle.exportedBy || 'anonymous'}
- Total Size: ${base64.length} characters (base64)

📋 Personas Included:
${personaList}

💾 Export Data (Copy this to share):
\`\`\`
${base64}
\`\`\`

💡 To import this bundle:
- Use: import_persona "<paste the base64 data here>"
- Or save to a file and use: import_persona "/path/to/bundle.json"`;
  }

}
