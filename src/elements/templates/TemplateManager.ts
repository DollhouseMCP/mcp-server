/**
 * TemplateManager - Refactored to extend BaseElementManager, keeping
 * template-specific validation, import/export logic, and analytics helpers.
 */

import * as path from 'path';

import { ElementType } from '../../portfolio/types.js';
import { toSingularLabel } from '../../utils/elementTypeNormalization.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { sanitizeInput } from '../../security/InputValidator.js';
import { UnicodeValidator } from '../../security/validators/unicodeValidator.js';
import { logger } from '../../utils/logger.js';
import { BaseElementManager, ElementManagerDeps } from '../base/BaseElementManager.js';
import { Template, TemplateMetadata } from './Template.js';
import { TriggerValidationService } from '../../services/validation/TriggerValidationService.js';
import { ValidationService } from '../../services/validation/ValidationService.js';
import { SerializationService } from '../../services/SerializationService.js';
import { MetadataService } from '../../services/MetadataService.js';
import { sanitizeGatekeeperPolicy } from '../../handlers/mcp-aql/policies/ElementPolicies.js';
import { SECURITY_LIMITS } from '../../security/constants.js';

export class TemplateManager extends BaseElementManager<Template> {
  private triggerValidationService: TriggerValidationService;
  private validationService: ValidationService;
  private serializationService: SerializationService;
  private readonly metadataService: MetadataService;

  constructor(deps: ElementManagerDeps) {
    super(
      ElementType.TEMPLATE,
      deps.portfolioManager,
      deps.fileLockManager,
      {
        eventDispatcher: deps.eventDispatcher,
        fileWatchService: deps.fileWatchService,
        memoryBudget: deps.memoryBudget,
        backupService: deps.backupService,
      },
      deps.fileOperationsService,
      deps.validationRegistry,
    );
    this.metadataService = deps.metadataService;
    this.triggerValidationService = deps.validationRegistry.getTriggerValidationService();
    this.validationService = deps.validationRegistry.getValidationService();
    this.serializationService = deps.serializationService;
  }

  protected override getElementLabel(): string {
    return 'template';
  }

  override async load(filePath: string): Promise<Template> {
    const template = await super.load(filePath);

    SecurityMonitor.logSecurityEvent({
      type: 'TEMPLATE_LOADED',
      severity: 'LOW',
      source: 'TemplateManager.load',
      details: `Template loaded: ${template.metadata.name} from ${path.basename(filePath)}`
    });

    return template;
  }

  override async save(template: Template, filePath: string): Promise<void> {
    // Auto-derive variables from content (#1896): ensures every {{placeholder}}
    // has a matching schema entry so render() never silently returns unfilled text.
    // Existing entries are never overwritten — user-set descriptions, types, and
    // required flags survive. New entries default to type: 'string', required: false.
    if (template.content) {
      template.metadata.variables = Template.deriveVariablesFromContent(
        template.content,
        template.metadata.variables ?? []
      );
    }

    await super.save(template, filePath);

    SecurityMonitor.logSecurityEvent({
      type: 'TEMPLATE_SAVED',
      severity: 'LOW',
      source: 'TemplateManager.save',
      details: `Template saved: ${template.metadata.name} to ${path.basename(filePath)}`
    });

    logger.info(`Template saved: ${template.metadata.name}`);
  }

  override async delete(filePath: string): Promise<void> {
    await super.delete(filePath);

    SecurityMonitor.logSecurityEvent({
      type: 'TEMPLATE_DELETED',
      severity: 'MEDIUM',
      source: 'TemplateManager.delete',
      details: `Template deleted: ${path.basename(filePath)}`
    });

    logger.info(`Template deleted: ${path.basename(filePath)}`);
  }

  async create(data: {
    name: string;
    description: string;
    content?: string;
    instructions?: string;
    metadata?: Partial<TemplateMetadata>;
  }): Promise<Template> {
    // Use specialized validator for input validation
    const validationResult = await this.validator.validateCreate({
      name: data.name,
      description: data.description,
      content: data.content
    });

    if (!validationResult.isValid) {
      throw new Error(`Validation failed: ${validationResult.errors.join(', ')}`);
    }

    // Log warnings if any
    if (validationResult.warnings && validationResult.warnings.length > 0) {
      logger.warn(`Template creation warnings: ${validationResult.warnings.join(', ')}`);
    }

    // Get sanitized name for file operations (validator already validated)
    const nameInput = data.name || 'new-template';
    const nameResult = this.validationService.validateAndSanitizeInput(nameInput, {
      maxLength: SECURITY_LIMITS.MAX_NAME_LENGTH,
      allowSpaces: true
    });
    const sanitizedName = nameResult.sanitizedValue!;

    // Use inherited getElementFilename() for consistent filename normalization
    const filename = this.getElementFilename(sanitizedName);

    // FIX: Issue #20 - Check for duplicate before creating
    const existingTemplates = await this.list();
    const duplicate = existingTemplates.find(t =>
      t.metadata.name.toLowerCase() === sanitizedName.toLowerCase()
    );

    if (duplicate) {
      throw new Error(`A template named "${sanitizedName}" already exists`);
    }

    const template = new Template(
      {
        ...data.metadata,
        name: sanitizedName,
        description: data.description || ''
      },
      data.content || '',
      this.metadataService
    );
    // Set instructions (rendering directives) if provided
    if (data.instructions) {
      template.instructions = data.instructions;
    }

    await this.save(template, filename);
    // Note: No reload() here — save() caches the element correctly.
    // See Issue #491 for why PersonaManager's reload-after-create was removed.

    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED',
      severity: 'LOW',
      source: 'TemplateManager.create',
      details: `Template created: ${template.metadata.name}`
    });

    return template;
  }

  async importElement(data: string, format: 'json' | 'yaml' | 'markdown' = 'markdown'): Promise<Template> {
    try {
      let metadata: Partial<TemplateMetadata>;
      let content = '';

      switch (format) {
        case 'json': {
          const jsonData = this.serializationService.parseJson(data, {
            source: 'TemplateManager.importElement'
          });
          metadata = await this.sanitizeMetadata(jsonData.metadata || {});
          content = jsonData.content || '';
          break;
        }

        case 'yaml': {
          const parsed = this.serializationService.parseFrontmatter(data, {
            maxYamlSize: 64 * 1024,
            validateContent: true,
            source: 'TemplateManager.importElement'
          });

          metadata = await this.sanitizeMetadata(parsed.data.metadata || parsed.data);
          content = parsed.content || '';
          break;
        }

        case 'markdown': {
          const mdParsed = this.serializationService.parseFrontmatter(data, {
            maxYamlSize: 64 * 1024,
            validateContent: true,
            source: 'TemplateManager.importElement'
          });
          metadata = await this.sanitizeMetadata(mdParsed.data);
          content = mdParsed.content;
          break;
        }

        default:
          throw new Error(`Unsupported import format: ${format}`);
      }

      const template = new Template(metadata, content, this.metadataService);
      const validation = template.validate();
      if (!validation.valid) {
        throw new Error(`Invalid template: ${validation.errors?.map(e => e.message).join(', ')}`);
      }

      return template;
    } catch (error) {
      logger.error(`Failed to import template: ${error}`);
      throw error;
    }
  }

  async exportElement(template: Template, format: 'json' | 'yaml' | 'markdown' = 'markdown'): Promise<string> {
    try {
      switch (format) {
        case 'json':
          return (template as any).serializeToJSON ? (template as any).serializeToJSON() : template.serialize();

        case 'yaml': {
          const yamlData = {
            metadata: template.metadata,
            content: template.content,
            id: template.id,
            version: template.version
          };

          return this.serializationService.dumpYaml(yamlData, {
            schema: 'json',  // Fix #914: standardize on JSON schema across all managers
            noRefs: true,
            sortKeys: true,
            skipInvalid: true
          });
        }

        case 'markdown': {
          return this.serializationService.createFrontmatter(
            template.metadata,
            template.content,
            {
              method: 'manual',
              schema: 'json',  // Fix #914: standardize on JSON schema across all managers
              cleanMetadata: true,
              cleaningStrategy: 'remove-both'  // Fix #913: standardize across all managers
            }
          );
        }

        default:
          throw new Error(`Unsupported export format: ${format}`);
      }
    } catch (error) {
      logger.error(`Failed to export template: ${error}`);
      throw error;
    }
  }

  async findByCategory(category: string): Promise<Template[]> {
    const sanitizedCategory = sanitizeInput(category, 50);
    const templates = await this.list();
    return templates.filter(t => t.metadata.category === sanitizedCategory);
  }

  async findByTag(tag: string): Promise<Template[]> {
    const sanitizedTag = sanitizeInput(tag, 50);
    const templates = await this.list();
    return templates.filter(t => t.metadata.tags?.includes(sanitizedTag));
  }

  async getMostUsed(limit: number = 10): Promise<Template[]> {
    const MIN_LIMIT = 1;
    const MAX_LIMIT = 100;
    const validatedLimit = Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.floor(limit)));

    if (limit !== validatedLimit) {
      logger.warn(`getMostUsed: limit ${limit} adjusted to ${validatedLimit} (valid range: ${MIN_LIMIT}-${MAX_LIMIT})`);
    }

    const templates = await this.list();
    return templates
      .sort((a, b) => (b.metadata.usage_count || 0) - (a.metadata.usage_count || 0))
      .slice(0, validatedLimit);
  }

  override getFileExtension(): string {
    return '.md';
  }

  protected override async parseMetadata(data: any): Promise<TemplateMetadata> {
    const sanitized = await this.sanitizeMetadata(data);
    // Use Template constructor to ensure required fields are populated
    const tempTemplate = new Template(sanitized, '', this.metadataService);
    return tempTemplate.metadata;
  }

  protected override createElement(metadata: TemplateMetadata, bodyContent: string): Template {
    // Fix #912: Prefer explicit format_version marker, fall back to instructions-presence check
    const metadataInstructions = metadata.instructions;
    delete (metadata as any).format_version;  // Strip marker from runtime metadata
    const template = new Template(metadata, bodyContent, this.metadataService);
    if (metadataInstructions) {
      template.instructions = metadataInstructions;
      delete metadata.instructions;
    }
    return template;
  }

  private buildDefaultBody(template: Template): string {
    const name = (template.metadata.name ?? '').trim();
    const description = (template.metadata.description ?? '').trim();
    const lines: string[] = [];
    if (name) {
      lines.push(`# ${name}`);
      lines.push('');
    }
    if (description) {
      lines.push(description);
      lines.push('');
    }
    // Section format: <template> for Handlebars content, <style>/<script> for raw passthrough.
    // Auto-detection (issue #705): section mode activates when body has a <template> root element.
    lines.push('<template>');
    lines.push('<!-- HTML content with {{variable}} substitution -->');
    lines.push('</template>');
    lines.push('');
    lines.push('<style>');
    lines.push('/* CSS styles (}} is safe here — not Handlebars processed) */');
    lines.push('</style>');
    lines.push('');
    lines.push('<script>');
    lines.push('// JavaScript (}} is safe here — not Handlebars processed)');
    lines.push('</script>');
    return lines.join('\n');
  }

  protected override async serializeElement(template: Template): Promise<string> {
    // v2.0 format: add instructions to YAML frontmatter if present
    const metadata: Record<string, any> = { ...template.metadata };
    // Issue #755: Serialize type as singular and persist unique_id
    metadata.type = toSingularLabel(ElementType.TEMPLATE);
    metadata.unique_id = template.id;
    // Fix #912: Explicit format marker
    metadata.format_version = 'v2';
    if (template.instructions) {
      metadata.instructions = template.instructions;
    }
    return this.serializationService.createFrontmatter(
      metadata,
      template.content || this.buildDefaultBody(template),
      {
        method: 'manual',
        schema: 'json',  // Fix #914: standardize on JSON schema across all managers
        cleanMetadata: true,
        cleaningStrategy: 'remove-both',  // Fix #913: standardize across all managers
        sortKeys: true,
        lineWidth: 80,
        skipInvalid: true
      }
    );
  }

  private async sanitizeMetadata(data: any): Promise<Partial<TemplateMetadata>> {
    const metadata: Partial<TemplateMetadata> = {};

    if (data.name) {
      metadata.name = sanitizeInput(UnicodeValidator.normalize(data.name).normalizedContent, 100);
    }

    if (data.description) {
      metadata.description = sanitizeInput(UnicodeValidator.normalize(data.description).normalizedContent, 500);
    }

    if (data.category) {
      // SECURITY FIX: Use ValidationService for category validation
      const categoryResult = this.validationService.validateCategory(data.category);
      if (categoryResult.isValid && categoryResult.sanitizedValue) {
        metadata.category = categoryResult.sanitizedValue;
      }
    }

    if (data.output_format) {
      metadata.output_format = sanitizeInput(data.output_format, 20);
    }

    if (Array.isArray(data.tags)) {
      metadata.tags = data.tags.map((tag: any) => sanitizeInput(String(tag), 50));
    }

    if (Array.isArray(data.includes)) {
      metadata.includes = data.includes.map((inc: any) => sanitizeInput(String(inc), 200));
    }

    if (data.triggers && Array.isArray(data.triggers)) {
      const validationResult = this.triggerValidationService.validateTriggers(
        data.triggers,
        ElementType.TEMPLATE,
        metadata.name || 'unknown'
      );
      metadata.triggers = validationResult.validTriggers;
    }

    if (typeof data.usage_count === 'number') {
      metadata.usage_count = Math.max(0, Math.floor(data.usage_count));
    }

    if (data.last_used) {
      metadata.last_used = sanitizeInput(String(data.last_used), 50);
    }

    if (Array.isArray(data.variables)) {
      metadata.variables = data.variables.map((v: any) => ({
        name: sanitizeInput(v.name || '', 50),
        type: sanitizeInput(v.type || 'string', 20),
        description: v.description ? sanitizeInput(v.description, 200) : undefined,
        required: Boolean(v.required),
        default: v.default,
        validation: v.validation ? sanitizeInput(v.validation, 200) : undefined,
        options: Array.isArray(v.options) ? v.options.map((o: any) => sanitizeInput(String(o), 100)) : undefined,
        format: v.format ? sanitizeInput(v.format, 50) : undefined
      }));
    }

    if (Array.isArray(data.examples)) {
      metadata.examples = data.examples.map((ex: any) => ({
        title: sanitizeInput(ex.title || '', 100),
        description: ex.description ? sanitizeInput(ex.description, 500) : undefined,
        variables: ex.variables || {},
        output: ex.output ? sanitizeInput(ex.output, 5000) : undefined
      }));
    }

    metadata.author = data.author ? sanitizeInput(data.author, 100) : undefined;
    metadata.version = data.version ? sanitizeInput(data.version, 20) : undefined;

    // Issue #524 — Gatekeeper policy (all element types)
    metadata.gatekeeper = sanitizeGatekeeperPolicy(data.gatekeeper, metadata.name || 'unknown', 'template');

    metadata.name = metadata.name ?? 'Untitled Template';
    metadata.description = metadata.description ?? '';

    return metadata;
  }
}
