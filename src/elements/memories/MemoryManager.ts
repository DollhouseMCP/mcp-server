/**
 * MemoryManager - Implementation of IElementManager for Memory elements
 * Handles CRUD operations and lifecycle management for memories implementing IElement
 * 
 * FIXES IMPLEMENTED:
 * 1. CRITICAL: Fixed race conditions in file operations by using FileLockManager for atomic reads/writes
 * 2. HIGH: Fixed unvalidated YAML parsing vulnerability by using SecureYamlParser
 * 3. MEDIUM: All user inputs are now validated and sanitized
 * 4. MEDIUM: Audit logging added for security operations
 * 5. MEDIUM: Path validation prevents directory traversal attacks
 */

import { Memory, MemoryMetadata } from './Memory.js';
import { ElementValidationResult } from '../../types/elements/IElement.js';
import { ElementType } from '../../portfolio/types.js';
import { toSingularLabel } from '../../utils/elementTypeNormalization.js';
import { BaseElementManager } from '../base/BaseElementManager.js';
import {
  getValidatedScanCooldown,
  getValidatedIndexDebounce,
  STORAGE_LAYER_CONFIG
} from '../../config/performance-constants.js';
import type { IStorageLayer } from '../../storage/IStorageLayer.js';
import { MemoryStorageLayer } from '../../storage/MemoryStorageLayer.js';
import { MemoryMetadataExtractor } from '../../storage/MemoryMetadataExtractor.js';
import { LRUCache } from '../../cache/LRUCache.js';
import { FileLockManager } from '../../security/fileLockManager.js';
import { SecurityMonitor } from '../../security/securityMonitor.js';
import { logger } from '../../utils/logger.js';
import { sanitizeInput } from '../../security/InputValidator.js';
import { ContentValidator } from '../../security/contentValidator.js';
import { SecureYamlParser } from '../../security/secureYamlParser.js';
import { SECURITY_LIMITS } from '../../security/constants.js';
import { MEMORY_CONSTANTS, MEMORY_SECURITY_EVENTS } from './constants.js';
import { MemoryType } from './types.js';
import { ValidationRegistry } from '../../services/validation/ValidationRegistry.js';
import { TriggerValidationService } from '../../services/validation/TriggerValidationService.js';
import { ValidationService } from '../../services/validation/ValidationService.js';
import { SerializationService } from '../../services/SerializationService.js';
import { MetadataService } from '../../services/MetadataService.js';
import { FileOperationsService } from '../../services/FileOperationsService.js';
import { FileWatchService } from '../../services/FileWatchService.js';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import { PortfolioManager } from '../../portfolio/PortfolioManager.js';
import { ElementMessages } from '../../utils/elementMessages.js';
import { sanitizeGatekeeperPolicy, getGatekeeperAuthoringErrors } from '../../handlers/mcp-aql/policies/ElementPolicies.js';

// Issue #83: Centralized active element limits (configurable via env vars)
import { getActiveElementLimitConfig, getMaxActiveLimit } from '../../config/active-element-limits.js';

/**
 * Issue #13: Utility function to check if a filename is a backup file
 * Backup files should not be loaded by list() - they are archived data, not active memories
 *
 * Backup patterns include:
 * - .backup- timestamp pattern (e.g., name.backup-2025-11-14-22-40-57-303.yaml)
 * - Any file with 'backup' in the name (case-insensitive)
 * - Files in backup/ or backups/ directories (handled at directory level)
 *
 * @param filename - The filename to check (without directory path)
 * @returns true if the file is a backup file that should be excluded
 */
function isBackupFile(filename: string): boolean {
  return filename.includes('.backup-') || filename.toLowerCase().includes('backup');
}

/**
 * Issue #39: Check if a memory name contains backup patterns (corrupted name)
 * This can happen when backup file metadata leaks into the canonical file
 *
 * Pattern: name.backup-YYYY-MM-DD-HH-mm-ss-SSS or name.backup-...-vN
 *
 * @param name - The memory name to check
 * @returns true if the name contains backup patterns indicating corruption
 */
function isCorruptedBackupName(name: string): boolean {
  // Check for .backup- timestamp pattern in the name
  return /\.backup-\d{4}-\d{2}-\d{2}/.test(name);
}

/**
 * Issue #39: Extract the original name from a corrupted backup name
 *
 * Examples:
 * - "dollhousemcp-baseline-knowledge.backup-2025-11-14-22-40-57-303"
 *   -> "dollhousemcp-baseline-knowledge"
 * - "my-memory.backup-2025-01-01-00-00-00-000-v2"
 *   -> "my-memory"
 *
 * @param corruptedName - The corrupted name containing backup pattern
 * @returns The original name with backup suffix removed
 */
function extractOriginalName(corruptedName: string): string {
  // Remove .backup-YYYY-MM-DD-HH-mm-ss-SSS and any -vN suffix
  return corruptedName.replace(/\.backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3}(-v\d+)?$/, '');
}

// Internal interface for parsed YAML structure
interface ParsedMemoryData {
  data: Record<string, any>;
  content: string;
}

export class MemoryManager extends BaseElementManager<Memory> {
  private readonly memoriesDir: string;
  // Phase 2: Bounded content hash index replaces unbounded Map
  private contentHashIndex = new LRUCache<string>({
    name: 'memory:contentHash',
    maxSize: 5000,
    maxMemoryMB: 5,
    ttlMs: 0,
  });
  private contentHashByPath = new LRUCache<string>({
    name: 'memory:contentHashReverse',
    maxSize: 5000,
    maxMemoryMB: 5,
    ttlMs: 0,
  });
  private triggerValidationService: TriggerValidationService;
  private validationService: ValidationService;
  private serializationService: SerializationService;

  // Track active memories by name (stable identifier) - Issue #18 Phase 4
  private activeMemoryNames: Set<string> = new Set();

  constructor(
    portfolioManager: PortfolioManager,
    fileLockManager: FileLockManager,
    fileOperationsService: FileOperationsService,
    validationRegistry: ValidationRegistry,
    serializationService: SerializationService,
    private metadataService: MetadataService,
    fileWatchService?: FileWatchService,
    memoryBudget?: import('../../cache/CacheMemoryBudget.js').CacheMemoryBudget,
    backupService?: import('../../services/BackupService.js').BackupService
  ) {
    super(ElementType.MEMORY, portfolioManager, fileLockManager, { fileWatchService, memoryBudget, backupService }, fileOperationsService, validationRegistry);
    this.memoriesDir = this.elementDir;
    this.triggerValidationService = validationRegistry.getTriggerValidationService();
    this.validationService = validationRegistry.getValidationService();
    this.serializationService = serializationService;
  }

  /**
   * Phase 2: Override factory to use MemoryStorageLayer for multi-directory scanning.
   */
  protected override createStorageLayer(fileOperationsService: FileOperationsService): IStorageLayer {
    // Note: Use this.elementDir (set by BaseElementManager before this is called),
    // not this.memoriesDir (set after super() returns).
    return new MemoryStorageLayer(fileOperationsService, {
      memoriesDir: this.elementDir,
      scanCooldownMs: getValidatedScanCooldown(),
      indexDebounceMs: getValidatedIndexDebounce(),
      fileFilter: (filename: string) => !isBackupFile(filename),
    });
  }

  protected override getElementLabel(): string {
    return 'memory';
  }

  // MemoryManager has its own backup system (moveToUserBackup) and its
  // save/delete don't call super — no-op the universal backup hooks.
  protected override async createBackupBeforeSave(): Promise<void> { /* no-op */ }
  protected override async createBackupBeforeDelete(): Promise<boolean> { return false; }

  /**
   * Override clearCache to also clear memory-specific caches.
   * Phase 2: Removed unbounded memoryCache and dateFoldersCache.
   */
  override clearCache(): void {
    super.clearCache();
    this.contentHashIndex.clear();
    this.contentHashByPath.clear();
  }

  /**
   * Override dispose to flush MemoryStorageLayer _index.json and clear caches.
   * Prevents resource leaks and "Jest did not exit" warnings in tests.
   */
  override dispose(): void {
    // storageLayer.clear() cancels pending _index.json debounced writes,
    // preventing ENOTEMPTY errors when tests delete temp directories.
    super.dispose();  // Calls BaseElementManager.dispose() — runs storageLayer.clear() + watcher cleanup
    this.contentHashIndex.clear();
    this.contentHashByPath.clear();
  }

  /**
   * Resolve memory file path across different storage locations
   * Searches in this order: system/, adapters/, date folders, root (legacy)
   * Extracted method to reduce cognitive complexity (PR #7)
   * @private
   */
  private async resolveMemoryPath(filePath: string): Promise<string> {
    // Check if it's a relative path (no date folder)
    if (!filePath.includes(path.sep) || !filePath.match(/^\d{4}-\d{2}-\d{2}/)) {
      // Search in system/ folder first
      const systemPath = path.join(this.memoriesDir, 'system', filePath);
      if (await this.fileOperations.exists(systemPath)) {
        return systemPath;
      }

      // Then check adapters/ folder
      const adapterPath = path.join(this.memoriesDir, 'adapters', filePath);
      if (await this.fileOperations.exists(adapterPath)) {
        return adapterPath;
      }

      // Then search in date folders
      const dateFolders = await this.getDateFolders();
      for (const dateFolder of dateFolders) {
        const testPath = path.join(this.memoriesDir, dateFolder, filePath);
        if (await this.fileOperations.exists(testPath)) {
          return testPath;
        }
      }

      // Fall back to root directory for backward compatibility during transition
      return await this.validateAndResolvePath(filePath);
    } else {
      return await this.validateAndResolvePath(filePath);
    }
  }

  /**
   * Load a memory from file
   * SECURITY FIX #1: Uses FileLockManager.atomicReadFile() instead of fs.readFile()
   * to prevent race conditions and ensure atomic file operations
   * @param filePath Path to the memory file to load
   * @returns Promise resolving to the loaded Memory instance
   * @throws {Error} When file cannot be found or path validation fails
   * @throws {Error} When YAML parsing fails or content is malformed
   * @throws {Error} When memory validation fails after loading
   */
  override async load(filePath: string): Promise<Memory> {
    try {
      // Resolve path using extracted helper method
      const fullPath = await this.resolveMemoryPath(filePath);

      // Ensure fullPath is defined
      if (!fullPath) {
        throw new Error(`Could not resolve path: ${filePath}`);
      }

      // Phase 2: Check base class LRU cache (replaces removed memoryCache Map)
      const cached = this.getCachedByAbsolutePath(fullPath);
      if (cached) return cached;

      // CRITICAL FIX: Use FileOperationsService for atomic file read
      // Previously: const content = await fs.readFile(fullPath, 'utf-8');
      // Now: Uses FileOperationsService which wraps FileLockManager
      const content = await this.fileOperations.readFile(fullPath, { encoding: 'utf-8' });
      
      // HIGH SEVERITY FIX: Use SecureYamlParser to prevent YAML injection attacks
      // Uses SerializationService which wraps SecureYamlParser and handles pure YAML automatically

      // Memory files are pure YAML (unlike other elements which are markdown with frontmatter)
      // SerializationService.parseFrontmatter() automatically detects and wraps pure YAML

      // Handle empty content edge case (for backward compatibility with existing tests/files)
      let parsed: ParsedMemoryData;

      if (content.trim() === '') {
        // Empty or all whitespace file - create minimal valid structure
        parsed = { data: {}, content: '' };
      } else {
        const parseResult = this.serializationService.parseFrontmatter(content, {
          maxYamlSize: MEMORY_CONSTANTS.MAX_YAML_SIZE,
          validateContent: false,  // FIX (#1206): Local files are pre-trusted
          source: 'MemoryManager.load',
          schema: 'json'  // FIX #1430: Preserve booleans (autoLoad) and numbers (priority)
        });

        // Convert to ParsedMemoryData format
        parsed = {
          data: parseResult.data,
          content: parseResult.content
        };
      }

      // Extract metadata and markdown content
      const { metadata, content: markdownContentFromFile } = this.parseMemoryFile(parsed);

      // Create memory instance
      const memory = new Memory(metadata, this.metadataService);

      // Fix #918: Read instructions from root-level YAML (where serializeElement writes them).
      // Previously instructions were written to root but never read back — silent data loss.
      const rootInstructions = parsed.data?.instructions;
      if (rootInstructions && typeof rootInstructions === 'string') {
        memory.instructions = rootInstructions;
      }

      // Strip format_version from runtime metadata (Fix #912)
      delete (memory.metadata as any).format_version;

      // Load saved entries if present
      // Memory files have entries as a top-level key in the YAML
      const entries = parsed.data?.entries;
      if (entries) {
        memory.deserialize(JSON.stringify({
          id: memory.id,
          type: memory.type,
          version: memory.version,
          metadata: memory.metadata,
          extensions: memory.extensions,
          entries: entries
        }));
      }

      // If markdown content exists after the frontmatter, add it as a memory entry
      // This preserves content from seed memories and memory files with markdown sections
      if (markdownContentFromFile && markdownContentFromFile.trim() && parsed.content && parsed.content.trim()) {
        await memory.addEntry(
          parsed.content.trim(),
          [],  // tags
          { loadedAt: new Date().toISOString() },  // metadata
          'file'  // source
        );
      }
      
      // FIX #1320: Set file path on memory for persistence (store relative path)
      // Normalize to forward slashes so paths are consistent across platforms
      // (path.relative() returns backslashes on Windows).
      const relativePath = path.relative(this.memoriesDir, fullPath).split(path.sep).join('/');
      memory.setFilePath(relativePath);

      // Cache via base class LRU cache
      this.cacheElement(memory, relativePath);

      // Routine load — debug level only. Security event for MEMORY_LOADED was
      // generating ~128K entries/session, overwhelming the 5K security ring buffer
      // with 25x turnover (backpressure). Downgraded per Issue #1687 analysis.
      logger.debug(`[MemoryManager] Loaded memory from ${path.basename(fullPath)}`);
      
      return memory;
      
    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: MEMORY_SECURITY_EVENTS.MEMORY_LOAD_FAILED,
        severity: 'MEDIUM',
        source: 'MemoryManager.load',
        details: `Failed to load memory from ${filePath}: ${error}`
      });
      throw new Error(`Failed to load memory: ${error}`);
    }
  }

  /**
   * Move existing memory file to user backup directory
   * Issue #49: Prevents duplicate files by backing up instead of versioning
   */
  private async moveToUserBackup(existingPath: string): Promise<void> {
    const date = new Date();
    const dateFolder = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const backupDir = path.join(this.memoriesDir, 'backups', 'user', dateFolder);
    await this.fileOperations.createDirectory(backupDir);

    const filename = path.basename(existingPath);
    const timestamp = date.toISOString().replace(/[:.]/g, '-');
    const backupName = filename.replace('.yaml', `.backup-${timestamp}.yaml`);

    await this.fileOperations.renameFile(existingPath, path.join(backupDir, backupName));
    logger.info(`[MemoryManager] Issue #49: Moved existing file to backup: ${backupName}`);

    // Issue #654: Prune excess backups for this memory in this date folder
    await this.pruneBackupsForMemory(backupDir, filename);
  }

  /**
   * Prune excess backups for a specific memory in a date folder.
   * Keeps only the N most recent backups (by timestamp in filename).
   * Issue #654: Prevents unbounded backup growth (was 197k+ files).
   */
  private async pruneBackupsForMemory(backupDir: string, memoryFilename: string): Promise<void> {
    const maxBackups = STORAGE_LAYER_CONFIG.MAX_BACKUPS_PER_MEMORY;
    const baseName = memoryFilename.replace('.yaml', '');

    try {
      const allFiles = await this.fileOperations.listDirectory(backupDir);
      // Find all backups for this specific memory
      const memoryBackups = allFiles
        .filter(f => f.startsWith(`${baseName}.backup-`) && f.endsWith('.yaml'))
        .sort((a, b) => a.localeCompare(b)); // Lexicographic sort = chronological for ISO timestamps

      if (memoryBackups.length <= maxBackups) return;

      // Delete oldest backups (keep the last N)
      const toDelete = memoryBackups.slice(0, memoryBackups.length - maxBackups);
      for (const file of toDelete) {
        try {
          await this.fileOperations.deleteFile(
            path.join(backupDir, file),
            ElementType.MEMORY,
            { source: 'MemoryManager.pruneBackupsForMemory' }
          );
        } catch (error) {
          logger.debug(`[MemoryManager] Failed to prune backup ${file}:`, error);
        }
      }

      if (toDelete.length > 0) {
        logger.info(`[MemoryManager] Issue #654: Pruned ${toDelete.length} excess backups for ${baseName} (kept ${maxBackups})`);
      }
    } catch (error) {
      // Non-fatal — backup pruning is best-effort
      logger.debug(`[MemoryManager] Backup pruning failed for ${backupDir}:`, error);
    }
  }

  /**
   * Generate path for memory storage based on memory type
   * Routes memories to appropriate folders:
   * - SYSTEM: system/
   * - ADAPTER: adapters/
   * - USER: YYYY-MM-DD/ (date-based folders)
   * @param element Memory element to save
   * @param memoryType Type of memory (defaults to USER)
   * @param fileName Optional custom filename
   * @returns Full path to memory file
   */
  private async generateMemoryPath(element: Memory, memoryType?: MemoryType, fileName?: string): Promise<string> {
    const type = memoryType || MemoryType.USER;
    let targetDir: string;

    // Route to appropriate folder based on memory type
    switch (type) {
      case MemoryType.SYSTEM:
        targetDir = path.join(this.memoriesDir, 'system');
        break;
      case MemoryType.ADAPTER:
        targetDir = path.join(this.memoriesDir, 'adapters');
        break;
      case MemoryType.USER:
      default: {
        // User memories go in date-based folders (existing behavior)
        const date = new Date();
        const dateFolder = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        targetDir = path.join(this.memoriesDir, dateFolder);
        break;
      }
    }

    // Ensure target directory exists
    await this.fileOperations.createDirectory(targetDir);

    // Generate filename using unified normalization
    // Note: Memory files use .yaml extension, so we use normalizeFilename() directly
    const baseName = fileName || `${this.normalizeFilename(element.metadata.name || 'memory')}.yaml`;

    // Issue #49: Check if file exists and move to backup if so (instead of version suffixes)
    const targetPath = path.join(targetDir, baseName);
    if (await this.fileOperations.exists(targetPath)) {
      await this.moveToUserBackup(targetPath);
    }
    return targetPath;
  }

  /**
   * Determine memory type from file path
   * @param filePath Relative path within memories directory
   * @returns Memory type based on path
   */
  private getMemoryTypeFromPath(filePath: string): MemoryType {
    if (filePath.startsWith('system/') || filePath.startsWith('system\\')) {
      return MemoryType.SYSTEM;
    }
    if (filePath.startsWith('adapters/') || filePath.startsWith('adapters\\')) {
      return MemoryType.ADAPTER;
    }
    return MemoryType.USER;
  }

  /**
   * Ensure all required folder structure exists
   * Creates system/, backups/system/, backups/user/, adapters/ folders
   */
  private async ensureFolderStructure(): Promise<void> {
    const folders = [
      path.join(this.memoriesDir, 'system'),
      path.join(this.memoriesDir, 'backups', 'system'),
      path.join(this.memoriesDir, 'backups', 'user'),
      path.join(this.memoriesDir, 'adapters')
    ];

    for (const folder of folders) {
      await this.fileOperations.createDirectory(folder);
    }
  }

  /**
   * Calculate SHA-256 hash of memory content for deduplication
   * Implements Issue #994 - Content-based deduplication
   */
  private calculateContentHash(element: Memory): string {
    const content = JSON.stringify({
      metadata: element.metadata,
      entries: JSON.parse(element.serialize()).entries
    });
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Get all date folders in memories directory.
   * Phase 2: Removed local cache — MemoryStorageLayer scan cooldown handles the hot path.
   * This method is now only used by resolveMemoryPath() as a fallback.
   * @returns Array of date folder names
   */
  private async getDateFolders(): Promise<string[]> {
    try {
      const entries = await this.fileOperations.listDirectory(this.memoriesDir);
      return entries
        .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name))
        .sort((a, b) => a.localeCompare(b))
        .reverse(); // Most recent first
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Save a memory to file
   * SECURITY FIX #1: Uses FileLockManager.atomicWriteFile() for atomic operations
   * @param element Memory element to save
   * @param filePath Optional custom file path, defaults to type-based path
   * @returns Promise that resolves when save is complete
   * @throws {Error} When memory validation fails before saving
   * @throws {Error} When path validation fails or file system errors occur
   * @throws {Error} When atomic write operation fails
   */
  override async save(element: Memory, filePath?: string): Promise<void> {
    try {
      // Issue #39: Auto-repair corrupted backup names before saving
      const memoryName = element.metadata.name;
      if (isCorruptedBackupName(memoryName)) {
        const originalName = extractOriginalName(memoryName);
        logger.warn(
          `[MemoryManager] Issue #39: Detected corrupted backup name '${memoryName}', ` +
          `auto-repairing to '${originalName}'`
        );
        element.metadata.name = originalName;

        SecurityMonitor.logSecurityEvent({
          type: MEMORY_SECURITY_EVENTS.MEMORY_SAVED,
          severity: 'MEDIUM',
          source: 'MemoryManager.save',
          details: `Issue #39: Auto-repaired corrupted backup name: '${memoryName}' -> '${originalName}'`
        });
      }

      // Validate element
      const validation = element.validate();
      if (!validation.valid) {
        throw new Error(`Invalid memory: ${validation.errors?.map(e => e.message).join(', ')}`);
      }

      // Calculate content hash for deduplication
      const contentHash = this.calculateContentHash(element);
      const existingPath = this.contentHashIndex.get(contentHash);

      if (existingPath) {
        // Log duplicate detection
        SecurityMonitor.logSecurityEvent({
          type: 'MEMORY_DUPLICATE_DETECTED',
          severity: 'LOW',
          source: 'MemoryManager.save',
          details: `Duplicate content detected. Existing: ${existingPath}`
        });
      }

      // Detect memory type from metadata or default to USER
      const memoryMeta = element.metadata as MemoryMetadata;
      const memoryType = memoryMeta.memoryType || MemoryType.USER;

      // Save path precedence:
      // 1) explicit filePath argument
      // 2) existing persisted path on the element (existingFilePath)
      // 3) newly generated date/type-based path for first-time saves
      // Keeping #2 ahead of #3 prevents loaded memories from being copied into a new
      // date folder on each save (Issue #699).
      const existingFilePath = element.getFilePath();
      const fullPath = filePath
        ? await this.validateAndResolvePath(filePath)
        : existingFilePath
          ? await this.validateAndResolvePath(existingFilePath)
          : await this.generateMemoryPath(element, memoryType);

      // Ensure parent directory exists
      await this.fileOperations.createDirectory(path.dirname(fullPath));

      const yamlContent = await this.serializeElement(element);

      // Fix #916/#918: Size enforcement on Memory's custom save path
      // (BaseElementManager.save() has this but Memory overrides it entirely)
      if (yamlContent.length > SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES) {
        SecurityMonitor.logSecurityEvent({
          type: MEMORY_SECURITY_EVENTS.MEMORY_SAVE_FAILED,
          severity: 'HIGH',
          source: 'MemoryManager.save.sizeEnforcement',
          details: `Memory exceeds maximum file size (${yamlContent.length} > ${SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES})`,
          metadata: { contentLength: yamlContent.length, limit: SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES }
        });
        throw new Error(
          `Memory exceeds maximum file size (${yamlContent.length} > ${SECURITY_LIMITS.MAX_PERSONA_SIZE_BYTES})`
        );
      }

      // Fix #908/#918: YAML bomb detection on Memory's custom save path
      const validationStart = Date.now();
      if (yamlContent.length <= SECURITY_LIMITS.MAX_YAML_LENGTH) {
        if (!ContentValidator.validateYamlContent(yamlContent)) {
          SecurityMonitor.logSecurityEvent({
            type: 'YAML_INJECTION_ATTEMPT',
            severity: 'CRITICAL',
            source: 'MemoryManager.save.yamlBombDetection',
            details: 'Serialized memory contains malicious YAML patterns — write blocked',
            metadata: { contentLength: yamlContent.length }
          });
          throw new Error('Serialized memory contains malicious YAML patterns — write blocked');
        }
      }
      const validationMs = Date.now() - validationStart;
      if (validationMs > 50) {
        logger.warn(`[MemoryManager] Write-path YAML validation took ${validationMs}ms for ${yamlContent.length} bytes`);
      }

      const parsedYaml = SecureYamlParser.parseRawYaml(yamlContent, SECURITY_LIMITS.MAX_YAML_LENGTH);
      const gatekeeperErrors = [
        ...getGatekeeperAuthoringErrors(parsedYaml),
        ...getGatekeeperAuthoringErrors(
          parsedYaml.metadata && typeof parsedYaml.metadata === 'object' && !Array.isArray(parsedYaml.metadata)
            ? parsedYaml.metadata as Record<string, unknown>
            : undefined
        ),
      ];
      if (gatekeeperErrors.length > 0) {
        throw new Error(
          `Invalid gatekeeper policy in serialized memory YAML: ${[...new Set(gatekeeperErrors)].join('; ')}`
        );
      }

      // CRITICAL FIX: Use FileOperationsService for atomic file write
      // Previously: await fs.writeFile(fullPath, yamlContent, 'utf-8');
      // Now: Uses FileOperationsService which wraps FileLockManager
      await this.fileOperations.writeFile(fullPath, yamlContent, { encoding: 'utf-8' });

      // FIX #1320: Set file path on memory after successful save
      // Normalize to forward slashes so paths are consistent across platforms
      // (path.relative() returns backslashes on Windows).
      const relativePath = path.relative(this.memoriesDir, fullPath).split(path.sep).join('/');
      element.setFilePath(relativePath);

      // Cache via base class LRU cache
      this.cacheElement(element, relativePath);

      // Phase 2: Notify storage layer of save
      const relPath = path.relative(this.memoriesDir, fullPath).split(path.sep).join('/');
      await this.storageLayer.notifySaved(relPath, fullPath);

      // Update bounded content hash index
      this.contentHashIndex.set(contentHash, fullPath);
      this.contentHashByPath.set(fullPath, contentHash);

      // Log successful save
      const stats = element.getStats();
      SecurityMonitor.logSecurityEvent({
        type: MEMORY_SECURITY_EVENTS.MEMORY_SAVED,
        severity: 'LOW',
        source: 'MemoryManager.save',
        details: `Saved memory to ${path.basename(fullPath)} with ${stats.totalEntries} entries`
      });

    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: MEMORY_SECURITY_EVENTS.MEMORY_SAVE_FAILED,
        severity: 'HIGH',
        source: 'MemoryManager.save',
        details: `Failed to save memory to ${filePath}: ${error}`
      });
      throw new Error(`Failed to save memory: ${error}`);
    }
  }
  /**
   * Handle memory load failure
   * FIX (SonarCloud): Extract duplicated error handling to reduce code duplication
   * @private
   */
  private handleLoadFailure(
    file: string,
    error: unknown,
    failedLoads: Array<{ file: string; error: string }>
  ): void {
    const errorMsg = error instanceof Error ? error.message : String(error);
    failedLoads.push({ file, error: errorMsg });
    // Only log security event if load() didn't suppress this as a repeat
    if (!this.isLoadErrorSuppressed(file)) {
      SecurityMonitor.logSecurityEvent({
        type: MEMORY_SECURITY_EVENTS.MEMORY_LIST_ITEM_FAILED,
        severity: 'LOW',
        source: 'MemoryManager.list',
        details: `Failed to load ${file}: ${error}`
      });
    }
  }

  /**
   * List all available memories from all locations.
   * Phase 2: Delegates multi-directory scanning to MemoryStorageLayer.
   * Storage layer handles: system/, adapters/, date folders, root, backup filtering, cooldown.
   *
   * Issue #18 Phase 4: Apply active status to memories that are in the active set.
   */
  override async list(): Promise<Memory[]> {
    const failedLoads: Array<{ file: string; error: string }> = [];

    try {
      await this.fileOperations.createDirectory(this.memoriesDir);

      // Storage layer handles multi-directory scan + cooldown
      const indexedPaths = await this.storageLayer.getIndexedPaths();

      // Load through LRU cache
      const memories: Memory[] = [];
      for (const relativePath of indexedPaths) {
        try {
          const memory = await this.load(relativePath);
          // Ensure memoryType is set based on location
          const memoryMeta = memory.metadata as MemoryMetadata;
          if (!memoryMeta.memoryType) {
            memoryMeta.memoryType = MemoryMetadataExtractor.inferMemoryType(relativePath) as MemoryType;
          }
          memories.push(memory);
        } catch (error) {
          this.handleLoadFailure(relativePath, error, failedLoads);
        }
      }

      if (failedLoads.length > 0) {
        logger.warn(`[MemoryManager] Failed to load ${failedLoads.length} memories:`,
          failedLoads.map(f => `  - ${f.file}: ${f.error}`).join('\n'));
      }

      // Deduplicate by file path (preserves existing behavior)
      const uniqueMemories = new Map<string, Memory>();
      for (const memory of memories) {
        const filePath = memory.getFilePath();
        if (filePath && !uniqueMemories.has(filePath)) {
          uniqueMemories.set(filePath, memory);
        } else if (!filePath) {
          uniqueMemories.set(`no-path-${memory.metadata.name}-${Date.now()}`, memory);
        }
      }

      const resultMemories = Array.from(uniqueMemories.values());

      // Issue #18 Phase 4: Apply active status to memories in the active set
      for (const memory of resultMemories) {
        if (this.activeMemoryNames.has(memory.metadata.name)) {
          await memory.activate();
        }
      }

      return resultMemories;

    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Activate a memory by name or identifier
   * Issue #18 Phase 4: Context-loading activation strategy
   * Issue #24 (LOW PRIORITY): Performance optimization using findByName()
   * Issue #24 (LOW PRIORITY): Consistent error messages using ElementMessages
   * Issue #24 (LOW PRIORITY): Cleanup trigger for memory leak prevention
   */
  async activateMemory(identifier: string): Promise<{ success: boolean; message: string; memory?: Memory }> {
    // PERFORMANCE FIX: Use findByName() instead of list()
    const memory = await this.findByName(identifier);

    if (!memory) {
      return {
        success: false,
        // CONSISTENCY FIX: Use standardized error message format
        message: ElementMessages.notFound(ElementType.MEMORY, identifier)
      };
    }

    // MEMORY LEAK FIX: Check if cleanup is needed before adding
    this.checkAndCleanupActiveSet();

    // Add to active set (by name, which is stable across reloads)
    this.activeMemoryNames.add(memory.metadata.name);

    // Update memory status in memory
    await memory.activate();

    // Routine activation — debug only (was flooding security buffer)
    logger.debug(`[MemoryManager] Memory activated: ${memory.metadata.name}`);

    logger.info(`Memory activated: ${memory.metadata.name}`);

    return {
      success: true,
      // CONSISTENCY FIX: Use standardized success message format
      message: ElementMessages.activated(ElementType.MEMORY, memory.metadata.name),
      memory
    };
  }

  /**
   * Deactivate a memory by name or identifier
   * Issue #18 Phase 4: Remove from active set
   * Issue #24 (LOW PRIORITY): Performance optimization using findByName()
   * Issue #24 (LOW PRIORITY): Consistent error messages using ElementMessages
   */
  async deactivateMemory(identifier: string): Promise<{ success: boolean; message: string }> {
    // PERFORMANCE FIX: Use findByName() instead of list()
    const memory = await this.findByName(identifier);

    if (!memory) {
      return {
        success: false,
        // CONSISTENCY FIX: Use standardized error message format
        message: ElementMessages.notFound(ElementType.MEMORY, identifier)
      };
    }

    // Remove from active set
    this.activeMemoryNames.delete(memory.metadata.name);

    // Update memory status in memory
    await memory.deactivate();

    logger.info(`Memory deactivated: ${memory.metadata.name}`);

    return {
      success: true,
      // CONSISTENCY FIX: Use standardized success message format
      message: ElementMessages.deactivated(ElementType.MEMORY, memory.metadata.name)
    };
  }

  /**
   * Get all active memories
   * Issue #18 Phase 4: Return memories that are in the active set
   */
  async getActiveMemories(): Promise<Memory[]> {
    const memories = await this.list();
    return memories.filter(m => this.activeMemoryNames.has(m.metadata.name));
  }

  /**
   * Issue #39: Scan all memories and repair corrupted backup names
   * This method loads all memories, checks for corrupted names, repairs them,
   * and saves the corrected files back to disk.
   *
   * @param onProgress Optional callback for progress updates during long operations
   * @returns Object with repair statistics and list of repaired memories
   */
  async repairCorruptedNames(
    onProgress?: (processed: number, total: number, current?: string) => void
  ): Promise<{
    scanned: number;
    repaired: number;
    errors: number;
    repairedMemories: Array<{ original: string; repaired: string; path: string }>;
    errorDetails: Array<{ name: string; error: string }>;
  }> {
    const result = {
      scanned: 0,
      repaired: 0,
      errors: 0,
      repairedMemories: [] as Array<{ original: string; repaired: string; path: string }>,
      errorDetails: [] as Array<{ name: string; error: string }>
    };

    logger.info('[MemoryManager] Issue #39: Starting corrupted name repair scan...');

    try {
      // Force fresh scan — repair must see current disk state, not cached index
      this.storageLayer.invalidate();
      const memories = await this.list();
      result.scanned = memories.length;

      let processed = 0;
      for (const memory of memories) {
        const currentName = memory.metadata.name;
        processed++;

        // Report progress
        if (onProgress) {
          onProgress(processed, memories.length, currentName);
        }

        if (isCorruptedBackupName(currentName)) {
          const repairedName = extractOriginalName(currentName);
          const filePath = memory.getFilePath() || 'unknown';

          try {
            // Update the name
            memory.metadata.name = repairedName;

            // Save the repaired memory
            await this.save(memory);

            result.repaired++;
            result.repairedMemories.push({
              original: currentName,
              repaired: repairedName,
              path: filePath
            });

            logger.info(
              `[MemoryManager] Issue #39: Repaired '${currentName}' -> '${repairedName}' at ${filePath}`
            );
          } catch (error) {
            result.errors++;
            result.errorDetails.push({
              name: currentName,
              error: error instanceof Error ? error.message : String(error)
            });
            logger.error(`[MemoryManager] Issue #39: Failed to repair '${currentName}':`, error);
          }
        }
      }

      logger.info(
        `[MemoryManager] Issue #39: Repair scan complete. ` +
        `Scanned: ${result.scanned}, Repaired: ${result.repaired}, Errors: ${result.errors}`
      );

      if (result.repaired > 0) {
        SecurityMonitor.logSecurityEvent({
          type: MEMORY_SECURITY_EVENTS.MEMORY_SAVED,
          severity: 'MEDIUM',
          source: 'MemoryManager.repairCorruptedNames',
          details: `Issue #39: Repaired ${result.repaired} corrupted memory names`,
          additionalData: {
            scanned: result.scanned,
            repaired: result.repaired,
            errors: result.errors
          }
        });
      }

      return result;
    } catch (error) {
      logger.error('[MemoryManager] Issue #39: Repair scan failed:', error);
      throw error;
    }
  }

  /**
   * Issue #39: Clean up excessive backup files in a directory
   * Removes versioned backup files (e.g., name.backup-...-v2.yaml, -v3.yaml, etc.)
   * keeping only the most recent backup (without version suffix)
   *
   * @param targetDir Directory to clean up (defaults to system/ folder)
   * @param dryRun If true, only reports what would be deleted without actually deleting
   * @param onProgress Optional callback for progress updates during long operations
   * @returns Object with cleanup statistics
   */
  async cleanupExcessiveBackups(
    targetDir?: string,
    dryRun: boolean = false,
    onProgress?: (processed: number, total: number, current?: string) => void
  ): Promise<{
    scanned: number;
    deleted: number;
    errors: number;
    deletedFiles: string[];
    keptFiles: string[];
    errorDetails: Array<{ file: string; error: string }>;
  }> {
    const dir = targetDir || path.join(this.memoriesDir, 'system');
    const result = {
      scanned: 0,
      deleted: 0,
      errors: 0,
      deletedFiles: [] as string[],
      keptFiles: [] as string[],
      errorDetails: [] as Array<{ file: string; error: string }>
    };

    logger.info(`[MemoryManager] Issue #39: Starting backup cleanup in ${dir}${dryRun ? ' (DRY RUN)' : ''}...`);

    try {
      const files = await this.fileOperations.listDirectory(dir);
      result.scanned = files.length;

      // Group backup files by base name
      const backupGroups = new Map<string, string[]>();

      for (const file of files) {
        // Match versioned backup files: name.backup-YYYY-MM-DD-HH-mm-ss-SSS-vN.yaml
        const versionedMatch = file.match(/^(.+\.backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}-\d{3})-v(\d+)\.yaml$/);
        if (versionedMatch) {
          const baseName = versionedMatch[1];
          const existing = backupGroups.get(baseName) || [];
          existing.push(file);
          backupGroups.set(baseName, existing);
        }
      }

      // Delete all versioned backup files
      let processed = 0;
      const totalVersionedFiles = Array.from(backupGroups.values()).reduce((sum, files) => sum + files.length, 0);

      for (const [baseName, versionedFiles] of backupGroups) {
        // Keep the base backup file (without -vN), delete all versioned ones
        const baseBackupFile = `${baseName}.yaml`;
        if (files.includes(baseBackupFile)) {
          result.keptFiles.push(baseBackupFile);
        }

        for (const versionedFile of versionedFiles) {
          processed++;

          // Report progress
          if (onProgress) {
            onProgress(processed, totalVersionedFiles, versionedFile);
          }

          const fullPath = path.join(dir, versionedFile);
          try {
            if (!dryRun) {
              await this.fileOperations.deleteFile(fullPath, ElementType.MEMORY, {
                source: 'MemoryManager.cleanupExcessiveBackups'
              });
            }
            result.deleted++;
            result.deletedFiles.push(versionedFile);
            logger.debug(`[MemoryManager] Issue #39: ${dryRun ? 'Would delete' : 'Deleted'} ${versionedFile}`);
          } catch (error) {
            result.errors++;
            result.errorDetails.push({
              file: versionedFile,
              error: error instanceof Error ? error.message : String(error)
            });
            logger.error(`[MemoryManager] Issue #39: Failed to delete ${versionedFile}:`, error);
          }
        }
      }

      logger.info(
        `[MemoryManager] Issue #39: Backup cleanup complete${dryRun ? ' (DRY RUN)' : ''}. ` +
        `Scanned: ${result.scanned}, ${dryRun ? 'Would delete' : 'Deleted'}: ${result.deleted}, Errors: ${result.errors}`
      );

      if (result.deleted > 0 && !dryRun) {
        SecurityMonitor.logSecurityEvent({
          type: MEMORY_SECURITY_EVENTS.MEMORY_CLEARED,
          severity: 'LOW',
          source: 'MemoryManager.cleanupExcessiveBackups',
          details: `Issue #39: Cleaned up ${result.deleted} excessive backup files`,
          additionalData: {
            directory: dir,
            scanned: result.scanned,
            deleted: result.deleted,
            errors: result.errors
          }
        });
      }

      return result;
    } catch (error) {
      logger.error('[MemoryManager] Issue #39: Backup cleanup failed:', error);
      throw error;
    }
  }

  /**
   * Check if active set cleanup is needed and perform cleanup if necessary
   * Issue #24 (LOW PRIORITY): Memory leak prevention
   * @private
   */
  private checkAndCleanupActiveSet(): void {
    const { max, cleanupThreshold } = getActiveElementLimitConfig('memories');

    // Below threshold — no action needed
    if (this.activeMemoryNames.size < cleanupThreshold) {
      return;
    }

    // At or above max — warn before cleanup
    if (this.activeMemoryNames.size >= max) {
      logger.warn(
        `Active memories limit reached (${max}). ` +
        `Consider deactivating unused memories or setting DOLLHOUSE_MAX_ACTIVE_MEMORIES to a higher value.`
      );

      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_LOADED',
        severity: 'MEDIUM',
        source: 'MemoryManager.checkAndCleanupActiveSet',
        details: `Active memories limit reached: ${this.activeMemoryNames.size}/${max}`
      });
    }

    // At or above threshold — proactively clean stale entries
    void this.cleanupStaleActiveMemories();
  }

  /**
   * Clean up stale entries from active memories set
   * Issue #24 (LOW PRIORITY): Memory leak prevention
   * @private
   */
  private async cleanupStaleActiveMemories(): Promise<void> {
    try {
      const startSize = this.activeMemoryNames.size;
      const memories = await this.list();
      const existingMemoryNames = new Set(memories.map(m => m.metadata.name));

      const staleNames: string[] = [];
      for (const activeName of this.activeMemoryNames) {
        if (!existingMemoryNames.has(activeName)) {
          this.activeMemoryNames.delete(activeName);
          staleNames.push(activeName);
        }
      }

      const endSize = this.activeMemoryNames.size;
      const removed = startSize - endSize;

      if (removed > 0) {
        logger.info(
          `Cleaned up ${removed} stale active memory reference(s). ` +
          `Active memories: ${endSize}/${getMaxActiveLimit('memories')}`
        );

        SecurityMonitor.logSecurityEvent({
          type: 'MEMORY_DELETED',
          severity: 'LOW',
          source: 'MemoryManager.cleanupStaleActiveMemories',
          details: `Removed ${removed} stale active memory references`,
          additionalData: {
            removedCount: removed,
            activeCount: endSize,
            staleNames: staleNames.join(', ')
          }
        });
      }
    } catch (error) {
      logger.error('Failed to cleanup stale active memories:', error);

      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_DELETED',
        severity: 'LOW',
        source: 'MemoryManager.cleanupStaleActiveMemories',
        details: `Cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
  
  /**
   * Check root files for load failures
   * FIX (SonarCloud S3776): Extract to reduce cognitive complexity
   * @private
   */
  private async checkRootFiles(
    failures: Array<{ file: string; error: string }>
  ): Promise<number> {
    const rootFiles = await this.fileOperations.listDirectory(this.memoriesDir)
      .then(files => files.filter(f => f.endsWith('.yaml')))
      .catch(() => []);

    for (const file of rootFiles) {
      try {
        await this.load(file);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        failures.push({ file, error: errorMsg });
      }
    }

    return rootFiles.length;
  }

  /**
   * Check date folder files for load failures
   * FIX (SonarCloud S3776): Extract to reduce cognitive complexity
   * @private
   */
  private async checkDateFolderFiles(
    dateFolder: string,
    failures: Array<{ file: string; error: string }>
  ): Promise<number> {
    const files = await this.fileOperations.listDirectory(path.join(this.memoriesDir, dateFolder))
      .then(files => files.filter(f => f.endsWith('.yaml')))
      .catch(() => []);

    for (const file of files) {
      try {
        await this.load(path.join(dateFolder, file));
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        failures.push({ file: `${dateFolder}/${file}`, error: errorMsg });
      }
    }

    return files.length;
  }

  /**
   * Get diagnostic information about memory loading status
   * FIX (#1206): New method to expose failed loads to users
   */
  async getLoadStatus(): Promise<{
    total: number;
    loaded: number;
    failed: number;
    failures: Array<{ file: string; error: string }>;
  }> {
    const failures: Array<{ file: string; error: string }> = [];
    let totalFiles = 0;

    try {
      const dateFolders = await this.getDateFolders();

      // Check root files
      totalFiles += await this.checkRootFiles(failures);

      // Check date folders
      for (const dateFolder of dateFolders) {
        totalFiles += await this.checkDateFolderFiles(dateFolder, failures);
      }

      return {
        total: totalFiles,
        loaded: totalFiles - failures.length,
        failed: failures.length,
        failures
      };
    } catch (error) {
      throw new Error(`Failed to get load status: ${error}`);
    }
  }

  /**
   * Get memories marked for auto-loading on server initialization.
   * Phase 2: Queries index for autoLoad entries instead of loading all memories.
   * Drops from ~70s to <30ms for typical portfolios with 14k memories.
   * Issue #1430: Auto-load baseline memories feature
   *
   * @returns Promise resolving to array of auto-load memories sorted by priority
   */
  async getAutoLoadMemories(): Promise<Memory[]> {
    try {
      // Ensure index is populated
      await this.storageLayer.scan();

      // Phase 2: Query index for autoLoad entries — does NOT load all files
      const memStorageLayer = this.storageLayer as MemoryStorageLayer;
      const autoLoadEntries = memStorageLayer.getAutoLoadEntries();

      logger.info(`[MemoryManager] getAutoLoadMemories: Found ${autoLoadEntries.length} auto-load entries in index`);

      // Load only matching memories (typically 3-5)
      const autoLoadMemories: Memory[] = [];
      for (const entry of autoLoadEntries) {
        try {
          const memory = await this.load(entry.filePath);
          autoLoadMemories.push(memory);
          logger.debug(`[MemoryManager]   - ${entry.name}: priority=${entry.priority ?? 999} (LOADED)`);
        } catch (error) {
          logger.warn(`[MemoryManager] Failed to load auto-load memory ${entry.filePath}: ${error}`);
        }
      }

      // Sort by priority (already sorted from getAutoLoadEntries, but ensure consistency)
      autoLoadMemories.sort((a, b) => {
        const pa = (a.metadata as MemoryMetadata).priority ?? 999;
        const pb = (b.metadata as MemoryMetadata).priority ?? 999;
        return pa - pb;
      });

      return autoLoadMemories;
    } catch (error) {
      logger.error('[MemoryManager] Failed to get auto-load memories:', error);
      return [];
    }
  }

  /**
   * Install seed memories from the seed-elements directory
   * Issue #1430: Copy baseline memory to user portfolio on first run
   *
   * Copies seed files from src/seed-elements/memories/ to the user's portfolio
   * if they don't already exist. This allows users to have baseline knowledge
   * available immediately without manual installation.
   *
   * @returns Promise resolving when installation is complete
   */
  async installSeedMemories(): Promise<void> {
    logger.info('[MemoryManager] 🌱 Starting seed memory installation...');
    try {
      // Define the seed file
      const seedFileName = 'dollhousemcp-baseline-knowledge.yaml';
      logger.debug(`[MemoryManager] Step 1: Target seed file: ${seedFileName}`);

      // Construct paths
      // When running from dist/elements/memories/MemoryManager.js:
      //   Go up to dist/ then into seed-elements/memories/
      // When running from src/elements/memories/MemoryManager.ts:
      //   Go up to src/ then into seed-elements/memories/
      // FIX: Use fileURLToPath for cross-platform Windows compatibility
      // On Windows, URL.pathname returns /C:/Users/... which is invalid
      // fileURLToPath correctly converts file:// URLs to native paths
      const currentModuleDir = path.dirname(fileURLToPath(import.meta.url));
      logger.debug(`[MemoryManager] Step 2: Current module directory: ${currentModuleDir}`);

      // Try dist location first (production/built code)
      let seedSourcePath = path.resolve(currentModuleDir, '../../seed-elements/memories', seedFileName);
      logger.info(`[MemoryManager] Step 3: Trying seed path (dist): ${seedSourcePath}`);

      // Check if it exists, if not try src location (development/test)
      if (await this.fileOperations.exists(seedSourcePath)) {
        logger.info(`[MemoryManager] ✅ Step 4: Found seed file in dist location`);
      } else {
        logger.warn(`[MemoryManager] ⚠️  Step 4: Seed file not in dist location, trying src...`);
        // Try src location
        seedSourcePath = path.resolve(currentModuleDir, '../../../src/seed-elements/memories', seedFileName);
        logger.info(`[MemoryManager] Step 4b: Trying seed path (src): ${seedSourcePath}`);
      }

      // Check if the seed file exists
      if (!await this.fileOperations.exists(seedSourcePath)) {
        logger.error(`[MemoryManager] ❌ Step 5: Seed file not found at ${seedSourcePath}`);
        return;
      }
      logger.info(`[MemoryManager] ✅ Step 5: Verified seed file exists at: ${seedSourcePath}`);

      // Check if file already exists in user portfolio
      // ISSUE #5: Seed files are system files - ALWAYS use latest version
      // Backup existing if it has user content, then install fresh seed

      logger.info(`[MemoryManager] Step 6: Checking for existing seed memory in portfolio...`);
      let existingMemory: Memory | undefined;

      try {
        // Try to load existing memory
        existingMemory = await this.load(seedFileName);
        logger.info(`[MemoryManager] ✅ Step 7: Found existing seed memory '${seedFileName}'`);
        const existingPath = existingMemory.getFilePath();
        logger.info(`[MemoryManager] Existing file location: ${existingPath}`);
      } catch {
        // Memory doesn't exist - proceed with fresh installation
        logger.info(`[MemoryManager] ℹ️  Step 7: Seed memory '${seedFileName}' not found in portfolio, will install fresh`);
      }

      // If existing memory found, check if we need to reinstall
      if (existingMemory) {
        logger.info(`[MemoryManager] Step 8: Analyzing existing seed memory content...`);
        const entries = existingMemory.getAllEntries();
        logger.debug(`[MemoryManager] Found ${entries.length} entries in existing memory`);

        // Check if memory has meaningful content (not just "entries: []")
        // Empty files often have just the "entries: []" YAML field as content
        let hasContent = entries.length > 0;

        if (hasContent && entries.length === 1) {
          const firstEntry = entries[0];
          const content = firstEntry.content?.trim() || '';
          logger.debug(`[MemoryManager] Single entry content length: ${content.length} chars`);
          // If only content is "entries: []", consider it empty
          if (content === 'entries: []' || content === '') {
            hasContent = false;
            logger.info(`[MemoryManager] Entry appears empty (entries: [] or blank)`);
          }
        }

        if (hasContent) {
          // FIX #1430: Skip reinstallation if seed already exists with content
          // Reinstalling deletes the memory from cache, losing activation status
          logger.info(`[MemoryManager] ✅ Seed memory already installed with content - skipping reinstallation`);
          logger.info(`[MemoryManager] 🎉 Seed memory installation check complete (already installed)`);
          return;
        } else {
          logger.info(`[MemoryManager] Step 9: Existing seed memory is empty (${entries.length} entries), will reinstall`);
        }

        // Delete existing (will be replaced with latest)
        logger.info(`[MemoryManager] Step 10: Removing existing seed memory...`);
        try {
          await this.delete(seedFileName);
          logger.info(`[MemoryManager] ✅ Removed existing seed memory, will install latest version`);
        } catch (deleteError) {
          logger.error(`[MemoryManager] ❌ Failed to delete existing seed memory:`, deleteError);
          throw deleteError;
        }
      }

      // Read the seed file
      logger.info(`[MemoryManager] Step 11: Reading seed file content...`);
      const seedContent = await this.fileOperations.readFile(seedSourcePath, { encoding: 'utf-8' });
      logger.info(`[MemoryManager] ✅ Read seed file: ${seedContent.length} characters`);

      // Parse and create memory instance
      logger.info(`[MemoryManager] Step 12: Parsing seed content and creating memory instance...`);
      let memory: Memory;
      try {
        memory = await this.importElement(seedContent, 'yaml');
        logger.info(`[MemoryManager] ✅ Successfully parsed seed memory`);
        logger.debug(`[MemoryManager] Memory name: ${memory.metadata.name}`);
      } catch (parseError) {
        logger.error(`[MemoryManager] ❌ Failed to parse seed content:`, parseError);
        throw parseError;
      }

      // Set memory type to SYSTEM and ensure autoLoad is enabled
      logger.info(`[MemoryManager] Step 13: Setting memory type to SYSTEM and autoLoad...`);
      const memoryMeta = memory.metadata as MemoryMetadata;
      memoryMeta.memoryType = MemoryType.SYSTEM;
      memoryMeta.autoLoad = true; // Ensure seed memories auto-load
      memoryMeta.priority = 1;   // High priority for baseline knowledge
      logger.debug(`[MemoryManager] Memory type: ${memoryMeta.memoryType}, autoLoad: ${memoryMeta.autoLoad}, priority: ${memoryMeta.priority}`);

      // Save to portfolio (this will use system/ folder based on memoryType)
      logger.info(`[MemoryManager] Step 14: Saving seed memory to portfolio (should go to system/ folder)...`);
      try {
        await this.save(memory);
        logger.info(`[MemoryManager] ✅ Successfully saved seed memory`);
        const savedPath = memory.getFilePath();
        logger.info(`[MemoryManager] Saved to: ${savedPath}`);
      } catch (saveError) {
        logger.error(`[MemoryManager] ❌ Failed to save seed memory:`, saveError);
        throw saveError;
      }

      logger.info(`[MemoryManager] 🎉 Step 15: Seed memory installation COMPLETE!`);

      logger.debug(`[MemoryManager] Installed seed memory: ${seedFileName}`);

    } catch (error) {
      // Log error but don't throw - seed installation should not break server startup
      logger.error('[MemoryManager] Failed to install seed memories:', error);
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_LOAD_FAILED',
        severity: 'LOW',
        source: 'MemoryManager.installSeedMemories',
        details: `Failed to install seed memories: ${error}`
      });
    }
  }


  /**
   * Find memories matching a predicate
   */
  override async find(predicate: (element: Memory) => boolean): Promise<Memory | undefined> {
    const memories = await this.list();
    return memories.find(predicate);
  }
  
  /**
   * Find multiple memories matching a predicate
   */
  override async findMany(predicate: (element: Memory) => boolean): Promise<Memory[]> {
    const memories = await this.list();
    return memories.filter(predicate);
  }
  
  /**
   * Delete a memory file
   * SECURITY: Validates path and logs deletion
   */
  override async delete(filePath: string): Promise<void> {
    try {
      const fullPath = await this.validateAndResolvePath(filePath);

      // Check if file exists
      if (!await this.fileOperations.exists(fullPath)) {
        // File doesn't exist, not an error for delete operation
        return;
      }

      // Delete the file
      await this.fileOperations.deleteFile(fullPath, ElementType.MEMORY, {
        source: 'MemoryManager.delete'
      });

      // Remove from caches
      const relativePath = path.relative(this.memoriesDir, fullPath);
      this.uncacheByPath(relativePath);

      // Phase 2: Notify storage layer of deletion
      this.storageLayer.notifyDeleted(relativePath);

      // Phase 2: Use reverse map for O(1) hash cleanup
      const hash = this.contentHashByPath.get(fullPath);
      if (hash) {
        this.contentHashIndex.delete(hash);
        this.contentHashByPath.delete(fullPath);
      }

      SecurityMonitor.logSecurityEvent({
        type: MEMORY_SECURITY_EVENTS.MEMORY_DELETED,
        severity: 'MEDIUM',
        source: 'MemoryManager.delete',
        details: `Deleted memory file: ${path.basename(fullPath)}`
      });

    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        // File doesn't exist, not an error for delete operation
        return;
      }
      throw error;
    }
  }
  
  /**
   * Check if a memory file exists
   */
  override async exists(filePath: string): Promise<boolean> {
    try {
      const fullPath = await this.validateAndResolvePath(filePath);
      return await this.fileOperations.exists(fullPath);
    } catch {
      return false;
    }
  }
  
  /**
   * Create a new memory with metadata
   */
  async create(metadata: Partial<MemoryMetadata> & { content?: string; instructions?: string }): Promise<Memory> {
    // Use specialized validator for input validation
    const validationResult = await this.validator.validateCreate({
      name: metadata.name,
      description: metadata.description
    });

    if (!validationResult.isValid) {
      throw new Error(`Validation failed: ${validationResult.errors.join(', ')}`);
    }

    // Log warnings if any
    if (validationResult.warnings && validationResult.warnings.length > 0) {
      logger.warn(`Memory creation warnings: ${validationResult.warnings.join(', ')}`);
    }

    // Check for duplicate (moved from createElement handler)
    const existingMemories = await this.list();
    const duplicate = existingMemories.find(m =>
      m.metadata.name?.toLowerCase() === metadata.name?.toLowerCase()
    );
    if (duplicate) {
      throw new Error(`A memory named "${metadata.name}" already exists`);
    }

    // Separate content and instructions from metadata fields
    // Note: BaseElement.constructor generates the element id from the name,
    // so we don't need to set id here — it would be ignored.
    const { content, instructions, ...metadataFields } = metadata;

    // Create instance
    const memory = new Memory(metadataFields, this.metadataService);

    // Set instructions if provided (v2.0 dual-field: memory-level directives)
    if (instructions) {
      memory.instructions = instructions;
    }

    // Add initial entry if content provided (moved from createElement handler)
    if (content) {
      await memory.addEntry(content);
    }

    // Save (moved from createElement handler)
    await this.save(memory);
    // Note: No reload() here — save() caches the element correctly.
    // See Issue #491 for why PersonaManager's reload-after-create was removed.

    logger.info(`Memory created: ${memory.metadata.name}`);
    return memory;
  }
  
  /**
   * Parse YAML data for import
   * Extracted to reduce cognitive complexity (SonarCloud)
   * @private
   */
  private parseYamlForImport(data: string): { parsed: any; markdownContent: string | undefined } {
    // Use SerializationService for consistent parsing
    const result = this.serializationService.parseFrontmatter(data, {
      maxYamlSize: MEMORY_CONSTANTS.MAX_YAML_SIZE,
      validateContent: true,
      source: 'MemoryManager.parseYamlForImport',
      schema: 'json'  // FIX #1430: Preserve booleans (autoLoad) and numbers (priority)
    });

    return {
      parsed: result.data,
      markdownContent: result.content
    };
  }

  /**
   * Create memory from parsed data
   * Extracted to reduce cognitive complexity (SonarCloud)
   * @private
   */
  private async createMemoryFromParsed(
    parsed: any,
    markdownContent: string | undefined
  ): Promise<Memory> {
    // Handle different structures from YAML parsing
    // Support both formats (see commit feb5ce0 on main):
    // 1. Frontmatter-style (seed files): metadata fields at top level
    // 2. Saved memory files: nested under 'metadata' key
    // This matches main's parseMemoryFile logic: yamlData.metadata || yamlData
    const metadata = parsed.metadata || parsed;
    const entries = parsed.entries || parsed.data?.entries;

    // Validate required fields
    if (!metadata?.name) {
      throw new Error('Memory must have metadata with name');
    }

    // Create memory instance
    const memory = new Memory(metadata, this.metadataService);

    // Load entries if present
    if (entries) {
      memory.deserialize(JSON.stringify({
        id: memory.id,
        type: memory.type,
        version: memory.version,
        metadata: memory.metadata,
        extensions: memory.extensions,
        entries: entries
      }));
    }

    // If markdown content exists after the frontmatter, add it as a memory entry
    // This preserves content from seed memories and imported YAML files with markdown sections
    if (markdownContent?.trim()) {
      await memory.addEntry(
        markdownContent.trim(),
        [],  // tags
        { importedAt: new Date().toISOString() },  // metadata
        'import'  // source
      );
    }

    return memory;
  }

  /**
   * Import a memory from JSON/YAML string
   * SECURITY: Full validation of imported content
   * @param data JSON or YAML string containing memory data
   * @param format Format of the input data ('json' or 'yaml')
   * @returns Promise resolving to the imported Memory instance
   * @throws {Error} When JSON/YAML parsing fails
   * @throws {Error} When imported data is missing required fields
   * @throws {Error} When YAML content exceeds maximum allowed size
   * @throws {Error} When imported memory fails validation
   */
  override async importElement(
    data: string,
    format: 'json' | 'yaml' | 'markdown' = 'yaml'
  ): Promise<Memory> {
    try {
      let parsed: any;
      let markdownContent: string | undefined;

      if (format === 'json') {
        parsed = JSON.parse(data);
      } else {
        // HIGH SEVERITY FIX: Use secure YAML parsing
        // Memory import expects pure YAML (not frontmatter), so we parse it securely
        try {
          const result = this.parseYamlForImport(data);
          parsed = result.parsed;
          markdownContent = result.markdownContent;
        } catch (yamlError) {
          throw new Error(`Invalid YAML: ${yamlError}`);
        }

        // Validate it's an object
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('YAML must contain an object');
        }
      }

      return await this.createMemoryFromParsed(parsed, markdownContent);

    } catch (error) {
      SecurityMonitor.logSecurityEvent({
        type: MEMORY_SECURITY_EVENTS.MEMORY_IMPORT_FAILED,
        severity: 'MEDIUM',
        source: 'MemoryManager.importElement',
        details: `Failed to import memory: ${error}`
      });
      throw new Error(`Failed to import memory: ${error}`);
    }
  }
  
  /**
   * Export a memory to YAML string
   */
  override async exportElement(
    element: Memory,
    format: 'json' | 'yaml' | 'markdown' = 'yaml'
  ): Promise<string> {
    if (format === 'json') {
      return element.serialize();
    }

    const stats = element.getStats();
    const data = {
      metadata: element.metadata,
      extensions: element.extensions,
      stats: {
        totalEntries: stats.totalEntries,
        totalSize: stats.totalSize,
        oldestEntry: stats.oldestEntry?.toISOString(),
        newestEntry: stats.newestEntry?.toISOString()
      },
      entries: JSON.parse(element.serialize()).entries
    };

    // SECURITY FIX: Use secure YAML dumping
    // FIX #1430: Use JSON_SCHEMA to preserve booleans (autoLoad) and numbers (priority)
    // JSON_SCHEMA = FAILSAFE + bool/int/float/null (safer than DEFAULT which adds timestamps)
    return this.serializationService.dumpYaml(data, {
      schema: 'json',
      noRefs: true,
      skipInvalid: true,
      sortKeys: true
    });
  }

  protected override async parseMetadata(data: any): Promise<MemoryMetadata> {
    const { metadata } = this.parseMemoryFile({ data, content: '' });
    return metadata;
  }

  protected override createElement(metadata: MemoryMetadata, _content: string): Memory {
    const memory = new Memory(metadata, this.metadataService);
    // Extract instructions from metadata if present (v2 dual-field)
    if (metadata.instructions) {
      memory.instructions = metadata.instructions;
      delete metadata.instructions;
    }
    return memory;
  }

  protected override async serializeElement(element: Memory): Promise<string> {
    const stats = element.getStats();
    // Issue #755: Serialize type as singular and persist unique_id
    const metadata = { ...element.metadata };
    metadata.type = toSingularLabel(ElementType.MEMORY) as any;
    (metadata as any).format_version = 'v2';  // Fix #912/#918: Explicit format marker
    (metadata as any).unique_id = element.id;
    const payload: Record<string, unknown> = {
      metadata,
      ...(element.instructions ? { instructions: element.instructions } : {}),
      extensions: element.extensions,
      stats: {
        totalEntries: stats.totalEntries,
        totalSize: stats.totalSize,
        oldestEntry: stats.oldestEntry?.toISOString(),
        newestEntry: stats.newestEntry?.toISOString(),
        topTags: Array.from(stats.tagFrequency.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([tag, count]) => ({ tag, count }))
      },
      entries: JSON.parse(element.serialize()).entries
    };

    // FIX #1430: Use JSON_SCHEMA to preserve booleans (autoLoad) and numbers (priority)
    // JSON_SCHEMA = FAILSAFE + bool/int/float/null (safer than DEFAULT which adds timestamps)
    return this.serializationService.dumpYaml(payload, {
      schema: 'json',
      noRefs: true,
      skipInvalid: true,
      sortKeys: true
    });
  }
  
  /**
   * Validate a memory element
   */
  override validate(element: Memory): ElementValidationResult {
    return element.validate();
  }
  
  /**
   * Validate and resolve a file path
   * SECURITY: Prevents directory traversal attacks
   */
  override validatePath(filePath: string): boolean {
    try {
      // Perform synchronous validation checks
      const normalized = path.normalize(filePath);
      
      // Check for path traversal attempts
      if (normalized.includes('..') || path.isAbsolute(normalized)) {
        return false;
      }
      
      // Ensure proper extension
      if (!normalized.endsWith('.md') && !normalized.endsWith('.yaml') && !normalized.endsWith('.yml')) {
        return false;
      }
      
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Get the element type this manager handles
   */
  override getElementType(): ElementType {
    return ElementType.MEMORY;
  }

  /**
   * Get the file extension for memory files
   */
  override getFileExtension(): string {
    return '.yaml';
  }
  
  // Private helper methods
  
  /**
   * Validate and resolve a file path to prevent security issues
   * @param filePath Path to validate and resolve
   * @returns Promise resolving to the validated full path
   * @throws {Error} When path contains traversal attempts (../)
   * @throws {Error} When path is absolute or invalid
   * @throws {Error} When file extension is not allowed (.md, .yaml, .yml)
   * @throws {Error} When resolved path would be outside memories directory
   */
  private async validateAndResolvePath(filePath: string): Promise<string> {
    // SECURITY FIX: Comprehensive path validation
    // Enhanced validation inspired by Jeet Singh (@jeetsingh008) - PR #1035

    // First normalize the path to resolve any ./ or ../ sequences
    const normalized = path.normalize(filePath);

    // Check for path traversal attempts - both in original and normalized
    // Check both the normalized path and the original for any traversal patterns
    if (normalized.includes('..') ||
        filePath.includes('..') ||
        path.isAbsolute(normalized) ||
        path.isAbsolute(filePath)) {
      SecurityMonitor.logSecurityEvent({
        type: 'PATH_TRAVERSAL_ATTEMPT',
        severity: 'HIGH',
        source: 'MemoryManager.validateAndResolvePath',
        details: `Blocked path traversal attempt: ${filePath}`
      });
      throw new Error('Invalid file path: Path traversal detected');
    }
    
    // Ensure proper extension - memories should only be .yaml or .yml
    if (!normalized.endsWith('.yaml') && !normalized.endsWith('.yml')) {
      throw new Error('Memory files must have .yaml or .yml extension');
    }
    
    // Construct full path
    const fullPath = path.join(this.memoriesDir, normalized);
    
    // Verify it's within memories directory
    const relative = path.relative(this.memoriesDir, fullPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('File path must be within memories directory');
    }
    
    return fullPath;
  }
  
  private parseMemoryFile(parsed: ParsedMemoryData): { metadata: MemoryMetadata; content: string } {
    // FIX: SecureYamlParser returns data in 'data' property, not 'metadata'
    // For markdown files with YAML frontmatter, the structure is:
    // parsed.data = YAML frontmatter values
    // parsed.content = markdown content after frontmatter

    // For pure YAML memory files, we need to check if metadata is directly in data
    const yamlData = parsed.data || {};

    // Memory files saved by the system have metadata as a top-level key
    const metadataSource = yamlData.metadata || yamlData;

    // Extract metadata with validation
    // SECURITY FIX: Validate BEFORE sanitization to prevent bypass attacks
    const nameInput = metadataSource.name || 'Unnamed Memory';
    const nameResult = this.validationService.validateAndSanitizeInput(nameInput, {
      maxLength: SECURITY_LIMITS.MAX_NAME_LENGTH,
      allowSpaces: true
    });
    if (!nameResult.isValid) {
      throw new Error(`Invalid memory name: ${nameResult.errors?.join(', ')}`);
    }

    // FIX: Must specify fieldType: 'description' to allow punctuation like colons, semicolons, etc.
    let sanitizedDescription = '';
    if (metadataSource.description) {
      const descResult = this.validationService.validateAndSanitizeInput(metadataSource.description, {
        maxLength: SECURITY_LIMITS.MAX_DESCRIPTION_LENGTH,
        allowSpaces: true,
        fieldType: 'description'
      });
      if (!descResult.isValid) {
        throw new Error(`Invalid memory description: ${descResult.errors?.join(', ')}`);
      }
      sanitizedDescription = descResult.sanitizedValue!;
    }

    const metadata: MemoryMetadata = {
      name: nameResult.sanitizedValue!,
      description: sanitizedDescription,
      version: metadataSource.version || '1.0.0',
      author: metadataSource.author,
      created: metadataSource.created,
      modified: metadataSource.modified || new Date().toISOString(),
      tags: Array.isArray(metadataSource.tags) ?
        metadataSource.tags.map((tag: string) => sanitizeInput(tag, MEMORY_CONSTANTS.MAX_TAG_LENGTH)) :
        [],
      // FIX #1124: Extract triggers for Enhanced Index support
      // Enhanced trigger validation logging for Issue #1139
      triggers: [],  // Will be set below with enhanced logging
      storageBackend: metadataSource.storage_backend || metadataSource.storageBackend || MEMORY_CONSTANTS.DEFAULT_STORAGE_BACKEND,
      retentionDays: metadataSource.retention_policy?.default ?
        this.parseRetentionDays(metadataSource.retention_policy.default) :
        (metadataSource.retentionDays || MEMORY_CONSTANTS.DEFAULT_RETENTION_DAYS),
      privacyLevel: metadataSource.privacy_level || metadataSource.privacyLevel || MEMORY_CONSTANTS.DEFAULT_PRIVACY_LEVEL,
      searchable: metadataSource.searchable !== false,
      maxEntries: metadataSource.maxEntries || MEMORY_CONSTANTS.MAX_ENTRIES_DEFAULT,
      // FIX #1430: Extract auto-load configuration
      autoLoad: metadataSource.autoLoad,
      priority: metadataSource.priority,
      // Memory type classification
      memoryType: metadataSource.memoryType,
      // Issue #524 — Gatekeeper policy (all element types)
      gatekeeper: sanitizeGatekeeperPolicy(metadataSource.gatekeeper, nameResult.sanitizedValue || 'unknown', 'memory'),
    };

    // Enhanced trigger validation and logging
    // NOTE: Memory triggers may evolve to support date patterns (2024-Q3),
    // semantic markers (recall-context), or natural language phrases.
    // Kept separate from Skills (technical) and Personas (character names).
    if (Array.isArray(metadataSource.triggers)) {
      const validationResult = this.triggerValidationService.validateTriggers(
        metadataSource.triggers,
        ElementType.MEMORY,
        metadata.name || 'unknown'
      );
      metadata.triggers = validationResult.validTriggers;
    }

    // Extract content (if any)
    const content = parsed.content || '';

    return { metadata, content };
  }

  /**
   * Helper to parse retention days from various formats
   */
  private parseRetentionDays(retention: string | number): number {
    if (typeof retention === 'number') return retention;
    if (retention === 'permanent' || retention === 'perpetual') return 999999;
    const regex = /(\d+)\s*days?/i;
    const match = regex.exec(retention);
    return match ? Number.parseInt(match[1]) : MEMORY_CONSTANTS.DEFAULT_RETENTION_DAYS;
  }

  /**
   * Estimate tokens in memory content (rough approximation)
   * Uses 1 token ≈ 0.75 words for English text
   * @param content Memory content to estimate
   * @returns Estimated token count
   */
  public estimateTokens(content: string): number {
    if (!content || typeof content !== 'string') return 0;

    // Simple word count approximation
    const words = content.trim().split(/\s+/).length;

    // 1 token ≈ 0.75 words (conservative estimate)
    return Math.ceil(words / 0.75);
  }

  /**
   * Load and activate auto-load memories during server initialization
   * Issue #1430: Auto-load baseline memories feature
   *
   * This method is called by Container.preparePortfolio() during server startup
   * to automatically load memories marked with autoLoad: true
   *
   * Architecture Note:
   * This implementation follows the DI-aligned pattern where managers own all operations
   * for their element type. Auto-load logic lives in MemoryManager (not ServerStartup)
   * because MemoryManager already owns all memory operations (CRUD, activation, etc.)
   *
   * @returns Promise resolving to auto-load statistics
   */
  async loadAndActivateAutoLoadMemories(): Promise<{
    loaded: number;
    skipped: number;
    totalTokens: number;
    errors: string[];
  }> {
    const startTime = Date.now();
    let loaded = 0;
    let skipped = 0;
    let totalTokens = 0;
    const errors: string[] = [];

    try {
      // Check for emergency disable
      const emergencyDisabled = process.env.DOLLHOUSE_DISABLE_AUTOLOAD === 'true';
      if (emergencyDisabled) {
        logger.info('[MemoryManager] Auto-load disabled via DOLLHOUSE_DISABLE_AUTOLOAD');
        // Keep as security event — emergency disable is a notable operational decision
        SecurityMonitor.logSecurityEvent({
          type: 'MEMORY_LOADED',
          severity: 'MEDIUM',
          source: 'MemoryManager.loadAndActivateAutoLoadMemories',
          details: 'Auto-load memories disabled via emergency environment variable',
          additionalData: { reason: 'DOLLHOUSE_DISABLE_AUTOLOAD=true' }
        });
        return { loaded: 0, skipped: 0, totalTokens: 0, errors: [] };
      }

      // Install seed memories first
      await this.installSeedMemories();

      // Get auto-load memories
      const autoLoadMemories = await this.getAutoLoadMemories();

      if (autoLoadMemories.length === 0) {
        logger.debug('[MemoryManager] No auto-load memories configured');
        return { loaded: 0, skipped: 0, totalTokens: 0, errors: [] };
      }

      logger.info(`[MemoryManager] Found ${autoLoadMemories.length} auto-load memories`);

      // Process each auto-load memory
      for (const memory of autoLoadMemories) {
        try {
          const memoryName = memory.metadata.name || 'unknown';

          // Validate memory before loading
          const validation = memory.validate();
          if (!validation.valid) {
            const errorMsg = `Validation failed for '${memoryName}': ${validation.errors?.map(e => e.message).join(', ')}`;
            errors.push(errorMsg);
            logger.warn(`[MemoryManager] ${errorMsg}`);
            skipped++;
            continue;
          }

          // Estimate tokens
          const estimatedTokens = this.estimateTokens(memory.content || '');

          // Activate the memory
          // FIX Issue #35: Add to activeMemoryNames set so getActiveMemories() returns it
          this.activeMemoryNames.add(memoryName);
          await memory.activate();
          loaded++;
          totalTokens += estimatedTokens;

          logger.info(`[MemoryManager] Auto-loaded: ${memoryName} (~${estimatedTokens} tokens)`);

          // Routine auto-load — debug only (was flooding security buffer)
          logger.debug(`[MemoryManager] Auto-loaded: ${memoryName} (~${estimatedTokens} tokens, priority: ${(memory.metadata as any).priority})`);

        } catch (error) {
          const memoryName = memory.metadata.name || 'unknown';
          const errorMsg = `Failed to load '${memoryName}': ${error instanceof Error ? error.message : String(error)}`;
          errors.push(errorMsg);
          logger.warn(`[MemoryManager] ${errorMsg}`);
          skipped++;
        }
      }

      const elapsedTime = Date.now() - startTime;
      logger.info(
        `[MemoryManager] Auto-load complete: ${loaded} memories activated ` +
        `(~${totalTokens} tokens), ${skipped} skipped, ${errors.length} errors, ${elapsedTime}ms`
      );

      // Summary event — fires once per startup, keep as security event
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_LOADED',
        severity: 'LOW',
        source: 'MemoryManager.loadAndActivateAutoLoadMemories',
        details: `Auto-load complete: ${loaded} loaded, ${skipped} skipped, ${errors.length} errors`,
        additionalData: {
          loadedCount: loaded,
          skippedCount: skipped,
          errorCount: errors.length,
          totalTokens,
          loadTimeMs: elapsedTime
        }
      });

      return { loaded, skipped, totalTokens, errors };

    } catch (error) {
      // Don't fail startup if auto-load fails, but provide detailed diagnostics
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorType = error instanceof Error ? error.constructor.name : 'Unknown';

      logger.warn(
        `[MemoryManager] Failed to load auto-load memories (${errorType}): ${errorMessage}`
      );

      // Log failure
      SecurityMonitor.logSecurityEvent({
        type: 'MEMORY_LOAD_FAILED',
        severity: 'MEDIUM',
        source: 'MemoryManager.loadAndActivateAutoLoadMemories',
        details: `Auto-load memories failed: ${errorType} - ${errorMessage}`,
        additionalData: {
          errorType,
          errorMessage,
          loadTimeMs: Date.now() - startTime
        }
      });

      return { loaded: 0, skipped: 0, totalTokens: 0, errors: [errorMessage] };
    }
  }
}
