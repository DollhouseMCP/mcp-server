import type { DeletionCleanup } from './deletionActivation.js';
import { visitSequentially } from '../../utils/visitSequentially.js';
import * as path from 'node:path';
import { ElementType } from '../../portfolio/PortfolioManager.js';
import type { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { ElementCrudContext } from './types.js';
import {
  normalizeElementTypeInput,
  formatValidElementTypesList,
  getElementTypeLabel,
  ElementManagerOperations
} from './helpers.js';
import { logger } from '../../utils/logger.js';
import type { IFileOperationsService } from '../../services/FileOperationsService.js';
import { ElementNotFoundError } from '../../utils/ErrorHandler.js';
import { ElementMissingError } from '../../elements/base/ElementReadError.js';
import { ValidationError } from '../../security/errors.js';
import type { DeletionReport, ElementDeletionTarget } from '../../elements/base/ElementDeletion.js';
import type { IElement } from '../../types/elements/IElement.js';

type ElementManagerWithDelete<T extends IElement> = ElementManagerOperations<T> & {
  resolveDeletionTarget(identifier: string): Promise<ElementDeletionTarget<T>>;
  deleteResolved(target: ElementDeletionTarget<T>, onCommitted?: () => void): Promise<DeletionReport>;
};

interface DeleteElementArgs {
  name: string;
  type: string;
  deleteData?: boolean;
}

export async function deleteElement(context: ElementCrudContext, args: DeleteElementArgs) {
  await context.ensureInitialized();
  const { type: normalizedType } = normalizeElementTypeInput(args.type);

  try {
    const { name, type, deleteData } = args;

    if (!normalizedType) {
      return invalidType(type);
    }

    // PersonaManager.deleteResolved owns persona deactivation in the standard flow.
    if (normalizedType === ElementType.MEMORY) {
      return await deleteMemory(context, name, deleteData);
    }

    return await deleteStandardElement(context, normalizedType, name, deleteData);
  } catch (error) {
    if (error instanceof ElementMissingError) {
      throw new ElementNotFoundError(normalizedType ? getElementTypeLabel(normalizedType) : args.type, args.name);
    }
    // FIX: Issue #275 - Re-throw ElementNotFoundError so callers can handle it; a refused caller
    // reference fails the operation the same way.
    if (error instanceof ElementNotFoundError || error instanceof ValidationError) {
      throw error;
    }
    logger.error('ElementCRUDHandler.deleteElement', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      content: [{
        type: "text",
        text: `❌ Failed to delete element: ${message}`
      }]
    };
  }
}

async function deleteStandardElement(
  context: ElementCrudContext,
  type: ElementType,
  name: string,
  deleteData?: boolean
) {
  const manager = getManagerForType(context, type);
  if (!manager) {
    return unsupportedType(type);
  }

  const target = await manager.resolveDeletionTarget(name);
  if (target.kind === 'repair') {
    const cleanup = await context.prepareElementDeletion?.(type, target.storageIdentity, target.storageIdentity, target);
    return withWarning(success(type, target.storageIdentity), await deleteAndFinish(manager, target, cleanup, type, target.storageIdentity));
  }
  const element = target.element;

  const fileOps = context.fileOperations;
  const elementName = element.metadata?.name || name;
  const dataFiles = await collectDataFiles(context.portfolioManager, type, elementName, fileOps);

  // Multi-turn interaction: prompt user if data files exist and no preference given.
  if (dataFiles.length > 0 && deleteData === undefined) {
    return promptForDataFiles(type, dataFiles);
  }

  // Issue #615: When deleteData is provided (follow-up call after prompt),
  // re-validate that the element still exists. State may have changed between
  // the initial prompt and the user's confirmation response.
  if (deleteData !== undefined) {
    await manager.resolveDeletionTarget(name);
  }

  const filename = target.storageIdentity;

  const cleanup = await context.prepareElementDeletion?.(type, elementName, filename, element);
  const warning = await deleteAndFinish(manager, target, cleanup, type, elementName);

  if (deleteData && dataFiles.length > 0) {
    const results = await removeDataFiles(context.portfolioManager, dataFiles, fileOps);
    return withWarning(successWithDataFiles(type, name, results), warning);
  }

  if (deleteData === false && dataFiles.length > 0) {
    return withWarning(successPreserveData(type, name, dataFiles), warning);
  }

  return withWarning(success(type, elementName), warning);
}

// FIX: Issue #281 - deletePersona removed, PERSONA now uses standard deleteStandardElement flow

async function deleteMemory(
  context: ElementCrudContext,
  name: string,
  deleteData?: boolean
) {
  const target = await context.memoryManager.resolveDeletionTarget(name);
  if (target.kind === 'repair') {
    const cleanup = await context.prepareElementDeletion?.(ElementType.MEMORY, target.storageIdentity, target.storageIdentity, target);
    return withWarning(success(ElementType.MEMORY, target.storageIdentity),
      await deleteAndFinish(context.memoryManager, target, cleanup, ElementType.MEMORY, target.storageIdentity));
  }
  const memory = target.element;

  // Deactivate if currently active
  if (memory.getStatus?.() === 'active' && memory.deactivate) {
    await memory.deactivate();
  }

  const memoryName = memory.metadata.name;

  // Delegate to manager — handles file mode, DB mode, path resolution, file lock, events
  const filePath = target.storageIdentity;
  const cleanup = await context.prepareElementDeletion?.(ElementType.MEMORY, memoryName, filePath, memory);
  const warning = await deleteAndFinish(context.memoryManager, target, cleanup, ElementType.MEMORY, memoryName);
  context.memoryManager.clearCache();

  // Clean up storage data if requested (handler-level concern, not manager's)
  const storageFailure = deleteData
    ? await cleanupMemoryStorage(context.portfolioManager.getElementDir(ElementType.MEMORY), memoryName, context.fileOperations)
    : undefined;
  const storageDeleted = deleteData && !storageFailure;

  logger.info(`Memory deleted: ${memoryName}${storageDeleted ? ' (with storage)' : ''}`);
  return {
    content: [{
      type: "text",
      text: `✅ Successfully deleted memory '${memoryName}'${storageDeleted ? ' and its storage data' : ''}${warning}`
        + (storageFailure ? `\n\n⚠️ Its storage data could not be deleted: ${storageFailure}` : '')
    }]
  };
}

async function deleteAndFinish(
  manager: Pick<ElementManagerWithDelete<any>, 'deleteResolved'>,
  target: ElementDeletionTarget<any>, cleanup: DeletionCleanup | undefined, type: string, name: string,
): Promise<string> {
  try {
    let report: DeletionReport;
    if (cleanup?.onCommitted) {
      let committed = false;
      const notifyCommitted = () => {
        committed = true;
        cleanup.onCommitted?.();
      };
      try {
        report = await manager.deleteResolved(target, notifyCommitted);
      } catch (error) {
        if (committed) await finishDeletion(cleanup, type, name);
        throw error;
      }
      if (!committed) notifyCommitted();
    } else {
      report = await manager.deleteResolved(target);
    }
    const warning = await finishDeletion(cleanup, type, name);
    return report.notices.map(notice => `\n⚠️ ${notice}`).join('') + warning;
  } finally {
    cleanup?.settle?.();
  }
}

async function finishDeletion(cleanup: (() => Promise<void>) | undefined, type: string, name: string): Promise<string> {
  try {
    await cleanup?.();
    return '';
  } catch (error) {
    logger.warn('Post-delete activation cleanup failed', { type, name, error });
    return '\n⚠️ Cleanup warning: activation state could not be fully cleared.';
  }
}

function withWarning<T extends { content: Array<{ text: string }> }>(result: T, warning: string): T {
  result.content[0].text += warning;
  return result;
}

// MemoryManager.resolveDeletionTarget owns memory path resolution.
// via validateAndResolvePath() (file mode) or storage layer (DB mode).

/** Deletes the memory's storage data (.storage directory); absent data is already deleted. Returns the failure reason otherwise. */
async function cleanupMemoryStorage(
  memoryDir: string,
  memoryName: string,
  fileOps: IFileOperationsService
): Promise<string | undefined> {
  const storagePath = path.join(memoryDir, '.storage', `${memoryName}.json`);
  try {
    await fileOps.deleteFile(storagePath);
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    logger.warn('Memory storage deletion failed', { memoryName, code });
    return code ? `storage error ${code}` : 'storage error';
  }
}

function invalidType(type: string) {
  return {
    content: [{
      type: "text",
      text: `❌ Invalid element type: ${type}\nValid types: ${formatValidElementTypesList()}`
    }]
  };
}

function unsupportedType(type: ElementType) {
  const labelPlural = getElementTypeLabel(type, { plural: true });
  return {
    content: [{
      type: "text",
      text: `❌ Element type '${labelPlural}' is not yet supported for deletion`
    }]
  };
}

function success(type: ElementType, name: string) {
  const label = getElementTypeLabel(type);
  return {
    content: [{
      type: "text",
      text: `✅ Successfully deleted ${label} '${name}'`
    }]
  };
}

function promptForDataFiles(type: ElementType, dataFiles: string[]) {
  const label = getElementTypeLabel(type);
  return {
    content: [{
      type: "text",
      text: `⚠️  This ${label} has associated data files:\n${dataFiles.join('\n')}\n\nWould you like to delete these data files as well?\n\n• To delete everything (element + data), say: "Yes, delete all data"\n• To keep the data files, say: "No, keep the data"\n• To cancel, say: "Cancel"`
    }]
  };
}

function successWithDataFiles(type: ElementType, name: string, results: string[]) {
  const label = getElementTypeLabel(type);
  return {
    content: [{
      type: "text",
      text: `✅ Successfully deleted ${label} '${name}'\n\nAssociated data files:\n${results.join('\n')}`
    }]
  };
}

function successPreserveData(type: ElementType, name: string, dataFiles: string[]) {
  const label = getElementTypeLabel(type);
  return {
    content: [{
      type: "text",
      text: `✅ Successfully deleted ${label} '${name}'\n\n⚠️ Associated data files were preserved:\n${dataFiles.join('\n')}`
    }]
  };
}

function getManagerForType(context: ElementCrudContext, type: ElementType): ElementManagerWithDelete<any> | null {
  return (context.getManagerForType(type) as ElementManagerWithDelete<any> | undefined) ?? null;
}

async function collectDataFiles(
  portfolio: PortfolioManager,
  type: ElementType,
  name: string,
  fileOps: IFileOperationsService
): Promise<string[]> {
  if (type !== ElementType.AGENT) {
    return [];
  }

  const stateDir = path.join(portfolio.getElementDir(ElementType.AGENT), '.state');
  const stateFile = path.join(stateDir, `${name}-state.json`);

  try {
    const stat = await fileOps.stat(stateFile);
    return [`- .state/${path.basename(stateFile)} (${(stat.size / 1024).toFixed(2)} KB)`];
  } catch {
    return [];
  }
}

async function removeDataFiles(
  portfolio: PortfolioManager,
  files: string[],
  fileOps: IFileOperationsService
) {
  const results: string[] = [];
  const agentDir = portfolio.getElementDir(ElementType.AGENT);

  await visitSequentially(files[Symbol.iterator](), async (entry) => {
    const relativePath = entry.replace(/^-\s*/, '').split(' ')[0];
    const fullPath = path.join(agentDir, relativePath);

    try {
      await fileOps.deleteFile(fullPath, ElementType.AGENT, { source: 'deleteElement.removeDataFiles' });
      results.push(`${entry} ✓ deleted`);
    } catch (error) {
      logger.warn(`Failed to delete associated data file ${relativePath}: ${error}`);
      results.push(`${entry} ⚠️ deletion failed`);
    }
  });

  return results;
}

// firstExisting removed — no longer needed (path resolution moved to MemoryManager).
