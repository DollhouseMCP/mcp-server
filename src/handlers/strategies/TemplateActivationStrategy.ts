/**
 * TemplateActivationStrategy - Strategy for template element activation
 *
 * Templates are stateless and activated on-demand when rendering.
 * This strategy provides information about available templates without
 * maintaining active state.
 */

import { TemplateManager } from '../../elements/templates/TemplateManager.js';
import { BaseActivationStrategy } from './BaseActivationStrategy.js';
import { ElementActivationStrategy, MCPResponse } from './ElementActivationStrategy.js';

export class TemplateActivationStrategy extends BaseActivationStrategy implements ElementActivationStrategy {
  constructor(private readonly templateManager: TemplateManager) {
    super();
  }

  /**
   * "Activate" a template (actually just verify it exists and show info)
   * Extracted from ElementCRUDHandler.ts lines 208-228
   *
   * @throws {ElementNotFoundError} When template does not exist
   * @see Issue #275 - Handlers return success=true for missing elements
   */
  async activate(name: string): Promise<MCPResponse> {
    // Use flexible finding to support both display name and filename
    const allTemplates = await this.templateManager.list();
    const template = await this.findElementFlexibly(name, allTemplates);
    if (!template) {
      this.throwNotFoundError(name, 'Template');
    }

    const variables = template.metadata.variables?.map((v: any) => v.name).join(', ') || 'none';
    let text = `✅ Template '${name}' ready to use\nVariables: ${variables}\n\nUse 'render_template' to generate content with this template.`;
    const gatekeeperWarning = this.formatGatekeeperValidityWarning(template.metadata as unknown as Record<string, unknown>);
    if (gatekeeperWarning) {
      text += gatekeeperWarning;
    }
    return this.createSuccessResponse(text);
  }

  /**
   * Deactivate a template (templates are stateless)
   * Extracted from ElementCRUDHandler.ts lines 543-550
   */
  async deactivate(_name: string): Promise<MCPResponse> {
    return {
      content: [{
        type: "text",
        text: "📝 Templates are stateless - nothing to deactivate"
      }]
    };
  }

  /**
   * Get active templates (templates are stateless)
   * Extracted from ElementCRUDHandler.ts lines 414-421
   */
  async getActiveElements(): Promise<MCPResponse> {
    return {
      content: [{
        type: "text",
        text: "📝 Templates are stateless and activated on-demand when rendering"
      }]
    };
  }

  /**
   * Get detailed information about a template
   * Extracted from ElementCRUDHandler.ts lines 691-728
   *
   * @throws {ElementNotFoundError} When template does not exist
   * @see Issue #275 - Handlers return success=true for missing elements
   */
  async getElementDetails(name: string): Promise<MCPResponse> {
    // Use flexible finding to support both display name and filename
    const allTemplates = await this.templateManager.list();
    const template = await this.findElementFlexibly(name, allTemplates);
    if (!template) {
      this.throwNotFoundError(name, 'Template');
    }

    const details = [
      `📄 **${template.metadata.name}**`,
      `${template.metadata.description}`,
      ``,
      `**Output Format**: ${(template.metadata as any).output_format || 'text'}`,
      `**Template Content**:`,
      '```',
      template.content,
      '```'
    ];

    if (template.metadata.variables && template.metadata.variables.length > 0) {
      details.push('', '**Variables**:');
      template.metadata.variables.forEach((v: any) => {
        details.push(`- ${v.name} (${v.type}): ${v.description}`);
      });
    }

    return {
      content: [{
        type: "text",
        text: details.join('\n')
      }]
    };
  }
}
