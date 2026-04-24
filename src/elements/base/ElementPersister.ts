/**
 * ElementPersister - Save, delete, exists, and content-validation logic.
 *
 * Owns the full save() and delete() method bodies plus the exists(),
 * validatePath(), and validateSerializedContent() helpers.
 * Services that need to call subclass-overridable methods (serializeElement,
 * beforeSave, afterSave, afterDelete, canDelete, onSaveError,
 * createBackupBeforeSave, createBackupBeforeDelete) receive them via
 * the ElementPersisterHost interface so late binding is preserved.
 * Extracted from BaseElementManager; no behaviour changed.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { IElement } from '../../types/elements/IElement.js';
import { ElementType } from '../../portfolio/types.js';
import { logger } from '../../utils/logger.js';
import { FileLockManager } from '../../security/fileLockManager.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { sanitizeInput } from '../../security/InputValidator.js';
import { ContentValidator } from '../../security/contentValidator.js';
import { SecurityError } from '../../security/errors.js';
import { SECURITY_LIMITS } from '../../security/constants.js';
import { SecureYamlParser } from '../../security/secureYamlParser.js';
import { FileOperationsService } from '../../services/FileOperationsService.js';
import { ElementTransactionScope } from './ElementTransactionScope.js';
import { type IStorageLayer, type IWritableStorageLayer, isWritableStorageLayer } from '../../storage/IStorageLayer.js';
import { getGatekeeperAuthoringErrors } from '../../handlers/mcp-aql/policies/ElementPolicies.js';
import type { ElementCache } from './ElementCache.js';
import type { ElementEventCoordinator } from './ElementEventCoordinator.js';
import type { ElementLoader, ElementTypeToContext } from './ElementLoader.js';

/**
 * Host interface: the persister calls back into BaseElementManager for
 * methods that subclasses may override (template-method pattern).
 */
export interface ElementPersisterHost<T extends IElement> {
  readonly elementType: ElementType;
  serializeElement(element: T): Promise<string>;
  /**
   * Validate serialized content before writing.
   * Declared in the host interface so MemoryManager's override (pure-YAML
   * validation) is dispatched correctly via the host reference.
   */
  validateSerializedContent(content: string): void;
  beforeSave?(element: T, filePath: string): Promise<void>;
  afterSave?(element: T, filePath: string): Promise<void>;
  afterDelete?(filePath: string): Promise<void>;
  canDelete?(element: T): Promise<{ allowed: boolean; reason?: string }>;
  onSaveError?(element: T, filePath: string, error: unknown): void;
  createBackupBeforeSave(absolutePath: string): Promise<void>;
  createBackupBeforeDelete(absolutePath: string): Promise<boolean>;
  getElementLabel(): string;
  getElementLabelCapitalized(): string;
  extractNameFromPath(relativePath: string): string;
  normalizeAndValidatePath(filePath: string): Promise<{ relativePath: string; absolutePath: string }>;
  readonly constructor: { name: string };
}

export class ElementPersister<T extends IElement> {
  constructor(
    private readonly host: ElementPersisterHost<T>,
    private readonly cache: ElementCache<T>,
    private readonly events: ElementEventCoordinator<T>,
    private readonly loader: ElementLoader<T>,
    private readonly fileLockManager: FileLockManager,
    private readonly fileOperations: FileOperationsService,
    private readonly storageLayer: IStorageLayer,
    private readonly elementTypeToContext: ElementTypeToContext,
  ) {}

  /**
   * Save an element to file or database.
   * Identical to the former BaseElementManager.save() body.
   */
  async save(element: T, filePath: string, options?: { exclusive?: boolean }): Promise<void> {
    const { relativePath, absolutePath } = await this.host.normalizeAndValidatePath(filePath);

    await this.fileLockManager.withLock(`element:${absolutePath}`, async () => {
      const correlationId = randomUUID();
      const transaction = new ElementTransactionScope(this.host.getElementLabel(), correlationId);

      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_EDITED',
        severity: 'LOW',
        source: `${this.host.constructor.name}.save`,
        details: `Saving ${this.host.getElementLabel()}: ${element.metadata.name} v${element.metadata.version || 'unknown'}`,
        additionalData: {
          elementId: element.id,
          elementType: this.host.getElementLabel(),
          author: element.metadata.author,
          version: element.metadata.version,
        },
      });

      this.events.eventDispatcher.emit(
        'element:save:start',
        this.events.createEventPayload({ correlationId, filePath: relativePath, element }),
      );

      const isDbMode = isWritableStorageLayer(this.storageLayer);
      let savedRelativePath = relativePath;

      transaction.addCommit(async () => {
        this.cache.cacheElement(element, savedRelativePath);
        if (!isDbMode) {
          await this.storageLayer.notifySaved(savedRelativePath, absolutePath);
        }
        this.events.eventDispatcher.emitAsync(
          'element:save:success',
          this.events.createEventPayload({ correlationId, filePath: savedRelativePath, element }),
        );
      });

      transaction.addRollback(async (error) => {
        this.events.eventDispatcher.emitAsync(
          'element:save:error',
          this.events.createEventPayload({ correlationId, filePath: relativePath, element, error }),
        );
        if (this.host.onSaveError) {
          try {
            this.host.onSaveError(element, relativePath, error);
          } catch (hookErr) {
            logger.warn(`onSaveError hook threw (swallowed): ${String(hookErr)}`);
          }
        }
      });

      await transaction.run(async () => {
        if (this.host.beforeSave) {
          await this.host.beforeSave(element, relativePath);
        }

        const content = await this.host.serializeElement(element);
        // Dispatch through the host so subclass overrides (e.g. MemoryManager) are called.
        this.host.validateSerializedContent(content);

        if (isDbMode) {
          const elementId = await (this.storageLayer as IWritableStorageLayer).writeContent(
            this.host.elementType,
            element.metadata.name,
            content,
            {
              author: element.metadata.author ?? '',
              version: element.metadata.version ?? '1.0.0',
              description: element.metadata.description ?? '',
              tags: element.metadata.tags ?? [],
            },
            {
              exclusive: options?.exclusive ?? false,
              elementLabel: this.host.getElementLabelCapitalized(),
            },
          );
          savedRelativePath = elementId;
        } else if (options?.exclusive) {
          await this.fileOperations.createDirectory(path.dirname(absolutePath));
          const created = await this.fileOperations.createFileExclusive(absolutePath, content, {
            source: `${this.host.constructor.name}.save`,
          });
          if (!created) {
            throw new Error(`${this.host.getElementLabelCapitalized()} '${element.metadata.name}' already exists`);
          }
        } else {
          await this.fileOperations.createDirectory(path.dirname(absolutePath));
          await this.host.createBackupBeforeSave(absolutePath);
          await this.fileOperations.writeFile(absolutePath, content, { encoding: 'utf-8' });
        }

        if (this.host.afterSave) {
          await this.host.afterSave(element, savedRelativePath);
        }
      });

      logger.info(`${this.host.getElementLabelCapitalized()} saved: ${element.metadata.name}`);
    });
  }

  /**
   * Delete an element from file or database.
   * Identical to the former BaseElementManager.delete() body.
   */
  async delete(filePath: string): Promise<void> {
    const { relativePath, absolutePath } = await this.host.normalizeAndValidatePath(filePath);

    await this.fileLockManager.withLock(`element:${absolutePath}`, async () => {
      SecurityMonitor.logSecurityEvent({
        type: 'ELEMENT_DELETED',
        severity: 'MEDIUM',
        source: `${this.host.constructor.name}.delete`,
        details: `Attempting to delete ${this.host.getElementLabel()}: ${filePath}`,
      });

      const correlationId = randomUUID();
      const transaction = new ElementTransactionScope(this.host.getElementLabel(), correlationId);

      this.events.eventDispatcher.emit(
        'element:delete:start',
        this.events.createEventPayload({ correlationId, filePath: relativePath }),
      );

      const isDbMode = isWritableStorageLayer(this.storageLayer);

      transaction.addCommit(async () => {
        this.cache.uncacheByPath(relativePath);
        if (!isDbMode) {
          this.storageLayer.notifyDeleted(relativePath);
        }
        this.events.eventDispatcher.emitAsync(
          'element:delete:success',
          this.events.createEventPayload({ correlationId, filePath: relativePath }),
        );
      });

      transaction.addRollback(async (error) => {
        this.events.eventDispatcher.emitAsync(
          'element:delete:error',
          this.events.createEventPayload({ correlationId, filePath: relativePath, error }),
        );
      });

      await transaction.run(async () => {
        if (this.host.canDelete) {
          const elementForValidation = isDbMode
            ? await this.loader.loadElementSnapshotFromDb(relativePath)
            : await this.loader.loadElementSnapshot(absolutePath, relativePath);
          const decision = await this.host.canDelete(elementForValidation);
          if (!decision.allowed) {
            throw new Error(decision.reason ?? `Deletion not permitted for ${this.host.getElementLabel()}`);
          }
        }

        if (isDbMode) {
          const elementName = this.storageLayer.getNameById?.(relativePath)
            ?? this.host.extractNameFromPath(relativePath);
          await (this.storageLayer as IWritableStorageLayer).deleteContent(this.host.elementType, elementName);
        } else {
          const movedToBackup = await this.host.createBackupBeforeDelete(absolutePath);
          if (!movedToBackup) {
            await this.fileOperations.deleteFile(absolutePath, this.host.elementType, {
              source: `${this.host.constructor.name}.delete`,
            });
          }
        }

        if (this.host.afterDelete) {
          await this.host.afterDelete(relativePath);
        }
      });

      logger.info(`${this.host.getElementLabelCapitalized()} deleted: ${filePath}`);
    });
  }

  /**
   * Check if an element exists.
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      if (isWritableStorageLayer(this.storageLayer)) {
        const name = this.host.extractNameFromPath(filePath);
        return this.storageLayer.getPathByName(name) !== undefined
          || this.storageLayer.getPathByName(filePath) !== undefined;
      }
      const { absolutePath } = await this.host.normalizeAndValidatePath(filePath);
      return await this.fileOperations.exists(absolutePath);
    } catch {
      return false;
    }
  }

  /**
   * Validate a file path (surface-area check before touching disk).
   */
  validatePath(filePath: string): boolean {
    try {
      const sanitized = sanitizeInput(filePath, 255);
      if (!sanitized || path.isAbsolute(sanitized)) return false;
      if (sanitized.includes('..')) return false;
      const ext = path.extname(sanitized).toLowerCase();
      const allowedExtensions = ['.md', '.markdown', '.txt', '.yml', '.yaml'];
      return ext === '' || allowedExtensions.includes(ext);
    } catch {
      return false;
    }
  }

  /**
   * Default implementation of validateSerializedContent used by BaseElementManager.
   * Validates frontmatter-based elements (markdown + YAML frontmatter).
   * MemoryManager overrides validateSerializedContent on the host to handle pure YAML.
   */
  defaultValidateSerializedContent(content: string): void {
    const validateGatekeeperMetadata = (record: Record<string, unknown> | undefined, sourceLabel: string) => {
      const errors = getGatekeeperAuthoringErrors(record);
      if (errors.length > 0) {
        throw new Error(
          `Invalid gatekeeper policy in serialized ${this.host.getElementLabel()} ${sourceLabel}: ${[...new Set(errors)].join('; ')}`,
        );
      }
    };

    const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
    const frontmatterMatch = frontmatterRegex.exec(content);

    if (frontmatterMatch) {
      const yamlContent = frontmatterMatch[1];
      const bodyContent = content.substring(frontmatterMatch[0].length);

      if (yamlContent.length <= SECURITY_LIMITS.MAX_YAML_LENGTH) {
        if (!ContentValidator.validateYamlContent(yamlContent)) {
          SecurityMonitor.logSecurityEvent({
            type: 'YAML_INJECTION_ATTEMPT',
            severity: 'CRITICAL',
            source: `${this.host.constructor.name}.validateSerializedContent`,
            details: `Malicious YAML pattern detected in serialized output for ${this.host.getElementLabel()}`,
            metadata: { yamlLength: yamlContent.length },
          });
          throw new SecurityError(
            `Serialized ${this.host.getElementLabel()} contains malicious YAML patterns — write blocked. ` +
            `Review the element's metadata and instructions for suspicious anchor/alias patterns.`,
            'critical',
          );
        }
      }

      const frontmatterData = SecureYamlParser.parseRawYaml(yamlContent, SECURITY_LIMITS.MAX_YAML_LENGTH);
      validateGatekeeperMetadata(frontmatterData, 'frontmatter');

      const contentContext = this.elementTypeToContext[this.host.elementType];
      const bodyValidation = ContentValidator.validateAndSanitize(bodyContent, { contentContext });
      if (!bodyValidation.isValid && bodyValidation.severity === 'critical') {
        throw new SecurityError(
          `Critical security threat detected in serialized body content: ${bodyValidation.detectedPatterns?.join(', ')}`,
          'critical',
        );
      }
    }
  }
}
