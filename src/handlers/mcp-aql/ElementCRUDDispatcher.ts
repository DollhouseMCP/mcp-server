import * as yaml from 'js-yaml';
import { ElementType } from '../../portfolio/PortfolioManager.js';
import type { OperationInput } from './types.js';
import type { HandlerRegistry } from './MCPAQLHandler.js';
import type { ExportPackage } from './shared.js';

export class ElementCRUDDispatcher {
  constructor(private readonly handlers: HandlerRegistry) {}

  async dispatch(method: string, input: OperationInput): Promise<unknown> {
    const elementType = input.element_type ?? input.elementType;
    const { params } = input;
    const p = params as Record<string, unknown>;

    switch (method) {
      case 'create':
        return this.createElement(elementType, p);
      case 'list':
        return this.handlers.elementCRUD.listElements(elementType || (p.type as string), p);
      case 'get':
      case 'getDetails':
        return this.handlers.elementCRUD.getElementDetails(p.name as string, elementType || (p.type as string));
      case 'edit':
        return this.handlers.elementCRUD.editElement({
          name: p.name as string,
          type: elementType || (p.type as string),
          input: p.input as Record<string, unknown>,
        });
      case 'validate':
        return this.handlers.elementCRUD.validateElement({
          name: p.name as string,
          type: elementType || (p.type as string),
          strict: p.strict as boolean | undefined,
        });
      case 'delete':
        return this.handlers.elementCRUD.deleteElement({
          name: p.name as string,
          type: elementType || (p.type as string),
          deleteData: p.deleteData as boolean | undefined,
        });
      case 'import':
        return this.importElement(p);
      case 'export':
        return this.exportElement(
          p.name as string,
          elementType || (p.type as string),
          (p.format as 'json' | 'yaml') || 'json'
        );
      default:
        throw new Error(`Unknown ElementCRUD method: ${method}`);
    }
  }

  private createElement(elementType: string | undefined, p: Record<string, unknown>): Promise<unknown> {
    const resolvedType = elementType || (p.type as string);
    return this.handlers.elementCRUD.createElement({
      name: p.name as string,
      type: resolvedType,
      description: p.description as string,
      content: p.content as string | undefined,
      instructions: p.instructions as string | undefined,
      metadata: this.resolveCreateMetadata(resolvedType, p),
    });
  }

  private resolveCreateMetadata(
    resolvedType: string | undefined,
    p: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    const metadata = p.metadata as Record<string, unknown> | undefined;
    const isEnsemble = resolvedType === ElementType.ENSEMBLE || resolvedType === 'ensemble';
    if (!isEnsemble || metadata?.elements) {
      return metadata;
    }

    const synonyms = ['members', 'components', 'items'] as const;
    const elementsSource = p.elements || synonyms.reduce<unknown>(
      (found, syn) => found || p[syn], undefined
    );
    return elementsSource ? { ...metadata, elements: elementsSource } : metadata;
  }

  private async importElement(params: Record<string, unknown>): Promise<unknown> {
    const exportPackage = this.parseExportPackage(params.data);
    this.validateExportPackage(exportPackage);
    const elementData = this.deserializeElementData(exportPackage);
    const name = elementData.name as string;
    const description = elementData.description as string;

    if (!name || !description) {
      throw new Error('Invalid element data: missing required fields (name, description)');
    }

    await this.ensureCanImport(name, exportPackage.elementType, params.overwrite === true);
    return this.handlers.elementCRUD.createElement({
      name,
      type: exportPackage.elementType,
      description,
      content: elementData.content as string | undefined,
      metadata: elementData.metadata as Record<string, unknown> | undefined,
    });
  }

  private parseExportPackage(data: unknown): ExportPackage {
    if (typeof data === 'string') {
      try {
        return JSON.parse(data) as ExportPackage;
      } catch (error) {
        throw new Error(`Invalid export package: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (typeof data === 'object' && data !== null) {
      return data as ExportPackage;
    }
    throw new Error('Invalid export package: data parameter must be a string or object');
  }

  private validateExportPackage(exportPackage: ExportPackage): void {
    const requiredFields = ['exportVersion', 'elementType', 'format', 'data'] as const;
    const missingFields = requiredFields.filter(
      (field) => !exportPackage[field as keyof ExportPackage]
    );
    if (missingFields.length > 0) {
      throw new Error(`Invalid export package: missing fields: ${missingFields.join(', ')}`);
    }
  }

  private deserializeElementData(exportPackage: ExportPackage): Record<string, unknown> {
    try {
      return exportPackage.format === 'yaml'
        ? this.parseYamlElementData(exportPackage.data)
        : JSON.parse(exportPackage.data) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Failed to deserialize element data: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private parseYamlElementData(data: string): Record<string, unknown> {
    const parsed = yaml.load(data, { schema: yaml.JSON_SCHEMA });
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Invalid YAML data: expected object');
    }
    return parsed as Record<string, unknown>;
  }

  private async ensureCanImport(name: string, type: string, overwrite: boolean): Promise<void> {
    if (overwrite) {
      return;
    }
    try {
      await this.handlers.elementCRUD.getElementDetails(name, type);
      throw new Error(`Element already exists: ${name}. Use overwrite:true to replace it.`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('already exists')) {
        throw error;
      }
    }
  }

  private async exportElement(
    name: string,
    type: string,
    format: 'json' | 'yaml' = 'json'
  ): Promise<ExportPackage> {
    if (!name) {
      throw new Error('Export operation requires name parameter');
    }
    if (!type) {
      throw new Error('Export operation requires type parameter (via elementType or params.type)');
    }

    const elementDetails = await this.handlers.elementCRUD.getElementDetails(name, type);
    return {
      exportVersion: '1.0',
      exportedAt: new Date().toISOString(),
      elementType: type,
      elementName: name,
      format,
      data: format === 'yaml'
        ? yaml.dump(elementDetails, { indent: 2, lineWidth: 120, noRefs: true })
        : JSON.stringify(elementDetails, null, 2),
    };
  }
}
