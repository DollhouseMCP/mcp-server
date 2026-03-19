import * as path from 'path';
import { ElementType } from '../../portfolio/PortfolioManager.js';
import type { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { ElementCrudContext } from './types.js';
import {
  findElementFlexibly,
  normalizeElementTypeInput,
  formatValidElementTypesList,
  getElementFilename,
  getElementTypeLabel,
  resolveElementByName,
  ElementManagerOperations
} from './helpers.js';
import { logger } from '../../utils/logger.js';
import type { IFileOperationsService } from '../../services/FileOperationsService.js';
import { ElementNotFoundError } from '../../utils/ErrorHandler.js';

type ElementManagerWithDelete<T> = ElementManagerOperations<T> & {
  delete(filePath: string): Promise<void>;
};

interface DeleteElementArgs {
  name: string;
  type: string;
  deleteData?: boolean;
}

export async function deleteElement(context: ElementCrudContext, args: DeleteElementArgs) {
  await context.ensureInitialized();

  try {
    const { name, type, deleteData } = args;

    const { type: normalizedType } = normalizeElementTypeInput(type);

    if (!normalizedType) {
      return invalidType(type);
    }

    // FIX: Issue #281 - PERSONA now uses standard flow (PersonaManager.delete() handles auto-deactivation)
    if (normalizedType === ElementType.MEMORY) {
      return await deleteMemory(context, name, deleteData);
    }

    return await deleteStandardElement(context, normalizedType, name, deleteData);
  } catch (error) {
    // FIX: Issue #275 - Re-throw ElementNotFoundError so callers can handle it
    if (error instanceof ElementNotFoundError) {
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

  const element = await resolveElementByName(manager, type, name);

  if (!element) {
    // FIX: Issue #275 - Throw error instead of returning content for missing elements
    const label = getElementTypeLabel(type);
    throw new ElementNotFoundError(label, name);
  }

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
    const recheck = await resolveElementByName(manager, type, name);
    if (!recheck) {
      const label = getElementTypeLabel(type);
      throw new ElementNotFoundError(label, name);
    }
  }

  const filePathCandidate = (element as any).filePath || (element as any).filename;
  const filename = typeof filePathCandidate === 'string' && filePathCandidate.length > 0
    ? filePathCandidate
    : getElementFilename(type, elementName);

  await manager.delete(filename);

  if (deleteData && dataFiles.length > 0) {
    const results = await removeDataFiles(context.portfolioManager, dataFiles, fileOps);
    return successWithDataFiles(type, name, results);
  }

  if (deleteData === false && dataFiles.length > 0) {
    return successPreserveData(type, name, dataFiles);
  }

  return success(type, elementName);
}

// FIX: Issue #281 - deletePersona removed, PERSONA now uses standard deleteStandardElement flow

async function deleteMemory(
  context: ElementCrudContext,
  name: string,
  deleteData?: boolean
) {
  const memories = await context.memoryManager.list();
  const memory = findElementFlexibly(name, memories);

  if (!memory) {
    // FIX: Issue #275 - Throw error instead of returning content for missing elements
    throw new ElementNotFoundError('Memory', name);
  }

  // Deactivate if currently active
  if (memory.getStatus && memory.getStatus() === 'active' && memory.deactivate) {
    await memory.deactivate();
  }

  const fileOps = context.fileOperations;
  const memoryDir = context.portfolioManager.getElementDir(ElementType.MEMORY);
  const memoryName = memory.metadata.name;

  // Build list of candidate file paths and find the actual file
  const fileCandidates = await buildMemoryPathCandidates(memory, memoryDir, fileOps);
  const memoryPath = await firstExisting(fileOps, fileCandidates);

  if (!memoryPath) {
    return {
      content: [{
        type: "text",
        text: `❌ Memory file '${memoryName}.yaml' not found in portfolio`
      }]
    };
  }

  // Back up the memory file before deleting (non-fatal)
  let movedByBackup = false;
  if (context.backupService) {
    try {
      const result = await context.backupService.backupBeforeDelete(memoryPath, ElementType.MEMORY);
      movedByBackup = !!result.movedOriginal;
    } catch (err) {
      logger.warn(`[deleteMemory] Backup failed: ${err}`);
    }
  }

  // Only delete if backup didn't already move the file
  if (!movedByBackup) {
    await fileOps.deleteFile(memoryPath, ElementType.MEMORY, { source: 'deleteElement.deleteMemory' });
  }

  // Invalidate memory manager caches so the storage layer index
  // reflects the deletion (the handler bypasses memoryManager.delete()).
  context.memoryManager.clearCache();

  // Clean up storage data if requested
  if (deleteData) {
    await cleanupMemoryStorage(memoryDir, memoryName, fileOps);
  }

  logger.info(`Memory deleted: ${memoryName}${deleteData ? ' (with storage)' : ''}`);
  return {
    content: [{
      type: "text",
      text: `✅ Successfully deleted memory '${memoryName}'${deleteData ? ' and its storage data' : ''}`
    }]
  };
}

/**
 * Build list of candidate file paths where a memory file might exist.
 * Checks persisted path, date-organized folders, and root memory directory.
 */
async function buildMemoryPathCandidates(
  memory: any,
  memoryDir: string,
  fileOps: IFileOperationsService
): Promise<string[]> {
  const candidates: string[] = [];
  const memoryName = memory.metadata.name;

  // Check for persisted file path on the memory object
  const persistedPath = typeof memory.getFilePath === 'function'
    ? memory.getFilePath()
    : (memory as any).filePath;

  if (persistedPath && typeof persistedPath === 'string') {
    candidates.push(path.isAbsolute(persistedPath) ? persistedPath : path.join(memoryDir, persistedPath));
  }

  // Add today's date folder and root folder as fallbacks
  const today = new Date().toISOString().split('T')[0];
  candidates.push(path.join(memoryDir, today, `${memoryName}.yaml`));
  candidates.push(path.join(memoryDir, `${memoryName}.yaml`));

  // Scan for date-organized directories and add them (most recent first)
  try {
    const dirs = await fileOps.listDirectory(memoryDir);
    const dateDirs = dirs.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    for (const dir of dateDirs.reverse()) {
      candidates.unshift(path.join(memoryDir, dir, `${memoryName}.yaml`));
    }
  } catch {
    // Directory listing failed - continue with existing candidates
  }

  return candidates;
}

/**
 * Clean up memory storage data file (.storage directory).
 * Silently ignores missing files (ENOENT).
 */
async function cleanupMemoryStorage(
  memoryDir: string,
  memoryName: string,
  fileOps: IFileOperationsService
): Promise<void> {
  const storagePath = path.join(memoryDir, '.storage', `${memoryName}.json`);
  try {
    await fileOps.deleteFile(storagePath);
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      logger.debug(`Memory storage deletion warning: ${error.message}`);
    }
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
  switch (type) {
    // FIX: Issue #281 - PERSONA now uses standard flow
    case ElementType.PERSONA:
      return context.personaManager as ElementManagerWithDelete<any>;
    case ElementType.SKILL:
      return context.skillManager as ElementManagerWithDelete<any>;
    case ElementType.TEMPLATE:
      return context.templateManager as ElementManagerWithDelete<any>;
    case ElementType.AGENT:
      return context.agentManager as ElementManagerWithDelete<any>;
    case ElementType.ENSEMBLE:
      return context.ensembleManager as ElementManagerWithDelete<any>;
    default:
      return null;
  }
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

  for (const entry of files) {
    const relativePath = entry.replace(/^-\s*/, '').split(' ')[0];
    const fullPath = path.join(agentDir, relativePath);

    try {
      await fileOps.deleteFile(fullPath, ElementType.AGENT, { source: 'deleteElement.removeDataFiles' });
      results.push(`${entry} ✓ deleted`);
    } catch (error) {
      logger.warn(`Failed to delete associated data file ${relativePath}: ${error}`);
      results.push(`${entry} ⚠️ deletion failed`);
    }
  }

  return results;
}

async function firstExisting(fileOps: IFileOperationsService, paths: string[]) {
  for (const candidate of paths) {
    if (await fileOps.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}
