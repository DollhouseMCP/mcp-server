/**
 * PortfolioPullHandler - Handles pulling portfolio elements from GitHub
 * 
 * This handler implements the pull functionality for sync_portfolio,
 * enabling users to download their portfolio from GitHub to local storage.
 * Supports multiple sync modes (additive, mirror, backup) and dry-run.
 */

import { PortfolioRepoManager } from '../portfolio/PortfolioRepoManager.js';
import { GitHubPortfolioIndexer } from '../portfolio/GitHubPortfolioIndexer.js';
import { PortfolioManager } from '../portfolio/PortfolioManager.js';
import { PortfolioIndexManager } from '../portfolio/PortfolioIndexManager.js';
import { ElementType } from '../portfolio/types.js';
import { logger } from '../utils/logger.js';
import { PortfolioSyncComparer, SyncMode, SyncAction, type SyncActions } from '../sync/PortfolioSyncComparer.js';
import { PortfolioDownloader } from '../sync/PortfolioDownloader.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { SecurityMonitor } from '../security/securityMonitor.js';
import { IFileOperationsService } from '../services/FileOperationsService.js';
import { TokenManager } from '../security/tokenManager.js';
import * as path from 'path';
import { TenantMemoryOperationProvider, type BoundMemoryOperation } from '../storage/TenantMemoryOperationProvider.js';
import { isWritableStorageLayer } from '../storage/IStorageLayer.js';
import type { DatabaseTenantMemoryRegistry } from '../storage/DatabaseTenantMemoryRegistry.js';

export interface PullOptions {
  direction: string;
  mode?: string;
  force?: boolean;
  dryRun?: boolean;
  confirmDeletions?: boolean;
}

export interface PullResult {
  content: Array<{
    type: string;
    text: string;
  }>;
}

export interface PortfolioPullHandlerDependencies {
  portfolioRepoManager: PortfolioRepoManager;
  githubIndexer: GitHubPortfolioIndexer;
  portfolioManager: PortfolioManager;
  indexManager?: PortfolioIndexManager;
  memoryRegistry?: DatabaseTenantMemoryRegistry;
  syncComparer: PortfolioSyncComparer;
  downloader: PortfolioDownloader;
  fileOperations: IFileOperationsService;
  tokenManager: TokenManager;
  /**
   * Phase 4.5 follow-up: optional storage-layer factory. When present AND
   * the factory produces a writable (database-backed) layer for the element
   * type, `downloadAndSaveElement` writes through it instead of the legacy
   * filesystem-only `fileOperations.writeFile` path. This closes the bug
   * where portfolio pulls in DB mode landed on per-user portfolio files
   * (often tmpfs in containerized deployments) and vanished on every
   * restart. Same correctness pattern as the ElementInstaller fix.
   */
  storageLayerFactory?: import('../storage/IStorageLayerFactory.js').IStorageLayerFactory;
}

export class PortfolioPullHandler {
  private memoryOperation?: { readonly provider: TenantMemoryOperationProvider; readonly operation: BoundMemoryOperation };

  /** The parent binds one authenticated operation; this clone never selects a manager again. */
  bindMemoryOperation(provider: TenantMemoryOperationProvider, operation: BoundMemoryOperation,
    indexManager: PortfolioIndexManager): PortfolioPullHandler {
    if (!(provider instanceof TenantMemoryOperationProvider)) throw new TypeError('Actual memory provider required');
    if (this.memoryRegistry) provider.assertRegistry(this.memoryRegistry);
    provider.assertOperation(operation);
    const bound = new PortfolioPullHandler({ portfolioRepoManager: this.portfolioRepoManager,
      githubIndexer: this.githubIndexer, portfolioManager: this.portfolioManager, indexManager,
      syncComparer: this.syncComparer, downloader: this.downloader, fileOperations: this.fileOperations,
      tokenManager: this.tokenManager, storageLayerFactory: this.storageLayerFactory, memoryRegistry: this.memoryRegistry });
    bound.memoryOperation = Object.freeze({ provider, operation });
    return bound;
  }

  private preparedPull?: Readonly<{ mode: SyncMode; username: string; repository: string;
    totalElements: number; localCount: number; actions: SyncActions }>;

  /** Guard BOTH before either direction mutates; retain only copied primitive decisions. */
  async preflightCombinedPull(options: PullOptions): Promise<void> {
    this.assertMemoryOperation();
    if (!this.memoryOperation) throw new Error('Authentic selected portfolio pull operation required');
    if (!this.memoryOperation.operation.manager.isGuardedHeadUpdateEnabled()) return;
    const mode = this.validateSyncMode(options.mode);
    const remote = await this.githubIndexer.getIndex(true);
    this.assertMemoryOperation();
    const local = await this.getAllLocalElements();
    this.assertMemoryOperation();
    const compared = this.syncComparer.compareElements(remote?.elements ?? new Map(), local, mode);
    const copy = (actions: SyncAction[]): SyncAction[] => {
      const result = actions.map(a => Object.freeze({type:a.type,name:a.name,path:a.path,action:a.action,
        reason:a.reason,localSha:a.localSha,remoteSha:a.remoteSha}));
      Object.freeze(result);
      return result;
    };
    const actions = Object.freeze({toAdd:copy(compared.toAdd),toUpdate:copy(compared.toUpdate),
      toDelete:copy(compared.toDelete),toSkip:copy(compared.toSkip)});
    for (const action of [...actions.toAdd,...actions.toUpdate,...actions.toDelete]) this.assertMutationType(action.type);
    this.preparedPull = Object.freeze({mode,username:remote?.username ?? '',repository:remote?.repository ?? '',
      totalElements:remote?.totalElements ?? 0,localCount:this.countElements(local),actions});
  }

  private originalBindingFailure?: { readonly cause: unknown };
  private assertMemoryOperation(): void {
    if (this.originalBindingFailure) throw this.originalBindingFailure.cause;
    if (!this.memoryOperation) return;
    try { this.memoryOperation.provider.assertOperation(this.memoryOperation.operation); }
    catch (cause) { this.originalBindingFailure = { cause }; throw cause; }
  }

  private assertMutationType(type: ElementType): void {
    this.assertMemoryOperation();
    if (!this.memoryOperation) return;
    if (!Object.values(ElementType).includes(type)) throw new Error('Unknown portfolio mutation type');
    if (type === ElementType.MEMORY && this.memoryOperation.operation.manager.isGuardedHeadUpdateEnabled()) {
      throw new Error('Guarded database memories support admitted UPDATE only; portfolio pull cannot create, replace or delete them');
    }
  }

  private portfolioRepoManager: PortfolioRepoManager;
  private githubIndexer: GitHubPortfolioIndexer;
  private portfolioManager: PortfolioManager;
  private readonly fixedIndex?: PortfolioIndexManager;
  private readonly memoryRegistry?: DatabaseTenantMemoryRegistry;
  private get indexManager(): PortfolioIndexManager {
    this.assertMemoryOperation();
    if (!this.fixedIndex) throw new Error('Authentic selected portfolio index required');
    return this.fixedIndex;
  }
  private syncComparer: PortfolioSyncComparer;
  private downloader: PortfolioDownloader;
  private readonly fileOperations: IFileOperationsService;
  private readonly tokenManager: TokenManager;
  private readonly storageLayerFactory?: import('../storage/IStorageLayerFactory.js').IStorageLayerFactory;

  constructor(dependencies: PortfolioPullHandlerDependencies) {
    if (!dependencies.portfolioManager) {
      throw new Error('PortfolioPullHandler requires a PortfolioManager instance');
    }
    if (!dependencies.githubIndexer) {
      throw new Error('PortfolioPullHandler requires a GitHubPortfolioIndexer instance');
    }
    if (!dependencies.indexManager && !dependencies.memoryRegistry) {
      throw new Error('PortfolioPullHandler requires a PortfolioIndexManager instance');
    }

    this.portfolioRepoManager = dependencies.portfolioRepoManager;
    this.githubIndexer = dependencies.githubIndexer;
    this.portfolioManager = dependencies.portfolioManager;
    this.fixedIndex = dependencies.indexManager;
    this.memoryRegistry = dependencies.memoryRegistry;
    this.syncComparer = dependencies.syncComparer;
    this.downloader = dependencies.downloader;
    this.fileOperations = dependencies.fileOperations;
    this.tokenManager = dependencies.tokenManager;
    this.storageLayerFactory = dependencies.storageLayerFactory;
  }

  /**
   * Execute the pull operation from GitHub to local portfolio
   */
  async executePull(options: PullOptions, personaIndicator: string): Promise<PullResult> {
    this.assertMemoryOperation();
    if (this.memoryRegistry && !this.memoryOperation) throw new Error('Authentic selected portfolio pull operation required');
    try {
      logger.info('Starting portfolio pull operation', { options });

      // Step 0: Ensure portfolio directory structure exists
      if (!this.memoryOperation) await this.portfolioManager.initialize();
      this.assertMemoryOperation();

      // Step 1: Validate sync mode
      const syncMode = this.preparedPull?.mode ?? this.validateSyncMode(options.mode);
      
      // Step 2: Fetch GitHub portfolio index
      const progressMessages: string[] = [];
      progressMessages.push('🔍 Fetching portfolio from GitHub...');
      
      const githubIndex = this.preparedPull ?? await this.githubIndexer.getIndex(true);
      this.assertMemoryOperation();
      
      if (!githubIndex || githubIndex.totalElements === 0) {
        return {
          content: [{
            type: "text",
            text: `${personaIndicator}⚠️ No elements found in GitHub portfolio. Nothing to pull.`
          }]
        };
      }
      
      progressMessages.push(`📊 Found ${githubIndex.totalElements} elements on GitHub`);
      
      // Step 3: Get local portfolio state
      if (!this.preparedPull) await this.indexManager.rebuildIndex();
      this.assertMemoryOperation();
      const localElements = this.preparedPull ? new Map<ElementType, any[]>() : await this.getAllLocalElements();
      this.assertMemoryOperation();
      progressMessages.push(`📁 Found ${this.preparedPull?.localCount ?? this.countElements(localElements)} local elements`);
      
      // Step 4: Compare and determine sync actions
      const syncActions = this.preparedPull?.actions ?? this.syncComparer.compareElements(
        'elements' in githubIndex ? githubIndex.elements : new Map(), localElements, syncMode
      );
      
      // Step 5: Handle dry-run mode
      if (options.dryRun) {
        return this.formatDryRunResults(syncActions, progressMessages, personaIndicator);
      }
      
      // Step 6: Check for deletions requiring confirmation
      if (syncActions.toDelete.length > 0 && 
          syncMode === 'mirror' && 
          !options.force && 
          options.confirmDeletions !== false) {
        return {
          content: [{
            type: "text",
            text: `${personaIndicator}⚠️ Pull operation would delete ${syncActions.toDelete.length} local elements.\n\n` +
                  `Elements to delete:\n${syncActions.toDelete.map(a => `  - ${a.name}`).join('\n')}\n\n` +
                  `To proceed, run with \`force: true\` or \`confirmDeletions: false\``
          }]
        };
      }
      
      // Discover the entire mutation set before launching any partial write.
      for (const action of [...syncActions.toAdd, ...syncActions.toUpdate, ...syncActions.toDelete]) {
        this.assertMutationType(action.type);
      }
      if (this.memoryOperation) {
        await this.portfolioManager.initialize();
        this.assertMemoryOperation();
      }
      // Step 7: Execute sync actions
      const results = await this.executeSyncActions(
        syncActions, 
        githubIndex.username, 
        githubIndex.repository,
        progressMessages
      );
      
      this.assertMemoryOperation();
      // Step 8: Return success summary
      return {
        content: [{
          type: "text",
          text: `${personaIndicator}✅ **Portfolio Pull Complete**\n\n` +
                progressMessages.join('\n') + '\n\n' +
                `**Summary:**\n` +
                `  📥 Added: ${results.added}\n` +
                `  🔄 Updated: ${results.updated}\n` +
                `  🔗 Skipped: ${results.skipped}\n` +
                (results.deleted > 0 ? `  🗑️ Deleted: ${results.deleted}\n` : '') +
                `\nYour local portfolio is now synchronized with GitHub!`
        }]
      };
      
    } catch (error) {
      if (this.memoryOperation) throw error;
      logger.error('Portfolio pull failed', { error });
      return {
        content: [{
          type: "text",
          text: `${personaIndicator}❌ Failed to pull portfolio: ${error instanceof Error ? error.message : String(error)}`
        }]
      };
    }
  }

  /**
   * Validate and normalize sync mode
   * SECURITY FIX: Added Unicode normalization to prevent homograph attacks
   */
  private validateSyncMode(mode?: string): SyncMode {
    const validModes: SyncMode[] = ['additive', 'mirror', 'backup'];
    
    // SECURITY FIX: Normalize Unicode to prevent homograph attacks
    const normalizedMode = mode ? 
      UnicodeValidator.normalize(mode).normalizedContent : 
      'additive';
    
    const syncMode = normalizedMode.toLowerCase() as SyncMode;
    
    if (!validModes.includes(syncMode)) {
      throw new Error(`Invalid sync mode: ${mode}. Valid modes are: ${validModes.join(', ')}`);
    }
    
    return syncMode;
  }

  /**
   * Get all local elements organized by type
   */
  private async getAllLocalElements(): Promise<Map<ElementType, any[]>> {
    const elements = new Map<ElementType, any[]>();
    const elementTypes = Object.values(ElementType);
    
    for (const type of elementTypes) {
      const typeElements = await this.indexManager.getElementsByType(type);
      this.assertMemoryOperation();
      if (typeElements.length > 0) {
        elements.set(type, typeElements);
      }
    }
    
    return elements;
  }

  /**
   * Count total elements in a map
   */
  private countElements(elements: Map<ElementType, any[]>): number {
    let count = 0;
    for (const typeElements of elements.values()) {
      count += typeElements.length;
    }
    return count;
  }

  /**
   * Format dry-run results for display
   */
  private formatDryRunResults(
    syncActions: { toAdd: SyncAction[], toUpdate: SyncAction[], toDelete: SyncAction[], toSkip: SyncAction[] },
    progressMessages: string[],
    personaIndicator: string
  ): PullResult {
    const lines = [
      `${personaIndicator}🔍 **Dry Run Results**`,
      '',
      ...progressMessages,
      '',
      '**Planned Actions:**'
    ];
    
    if (syncActions.toAdd.length > 0) {
      lines.push(`\n📥 **To Add (${syncActions.toAdd.length}):**`);
      syncActions.toAdd.forEach(action => {
        lines.push(`  - ${action.type}/${action.name}`);
      });
    }
    
    if (syncActions.toUpdate.length > 0) {
      lines.push(`\n🔄 **To Update (${syncActions.toUpdate.length}):**`);
      syncActions.toUpdate.forEach(action => {
        lines.push(`  - ${action.type}/${action.name}`);
      });
    }
    
    if (syncActions.toDelete.length > 0) {
      lines.push(`\n🗑️ **To Delete (${syncActions.toDelete.length}):**`);
      syncActions.toDelete.forEach(action => {
        lines.push(`  - ${action.type}/${action.name}`);
      });
    }
    
    if (syncActions.toSkip.length > 0) {
      lines.push(`\n🔗 **To Skip (${syncActions.toSkip.length}):**`);
      syncActions.toSkip.forEach(action => {
        lines.push(`  - ${action.type}/${action.name} (${action.reason})`);
      });
    }
    
    lines.push('', 'Run without `dryRun: true` to execute these changes.');
    
    return {
      content: [{
        type: "text",
        text: lines.join('\n')
      }]
    };
  }

  /**
   * Execute the sync actions
   */
  private async executeSyncActions(
    syncActions: { toAdd: SyncAction[], toUpdate: SyncAction[], toDelete: SyncAction[], toSkip: SyncAction[] },
    username: string,
    repository: string,
    progressMessages: string[]
  ): Promise<{ added: number, updated: number, deleted: number, skipped: number }> {
    const results = {
      added: 0,
      updated: 0,
      deleted: 0,
      skipped: syncActions.toSkip.length
    };
    
    // PERFORMANCE: Process downloads in parallel batches for improved speed
    const BATCH_SIZE = 5; // Process 5 downloads at a time to avoid rate limiting
    
    // Helper function to process a batch of actions
    const processBatch = async (actions: SyncAction[], operation: string) => {
      const results = await Promise.allSettled(
        actions.map(async (action) => {
          this.assertMutationType(action.type);
          progressMessages.push(`${operation}: ${action.type}/${action.name}`);
          await this.downloadAndSaveElement(action, username, repository);
          this.assertMemoryOperation();
          return action;
        })
      );
      
      this.assertMemoryOperation();
      if (this.memoryOperation) {
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      }
      return results.map((result, index) => ({
        action: actions[index],
        success: result.status === 'fulfilled',
        error: result.status === 'rejected' ? result.reason : null
      }));
    };
    
    // Process additions in batches
    for (let i = 0; i < syncActions.toAdd.length; i += BATCH_SIZE) {
      const batch = syncActions.toAdd.slice(i, i + BATCH_SIZE);
      const batchResults = await processBatch(batch, '📥 Downloading');
      this.assertMemoryOperation();
      
      for (const result of batchResults) {
        if (result.success) {
          results.added++;
        } else {
          logger.error(`Failed to add ${result.action.type}/${result.action.name}`, { error: result.error });
          progressMessages.push(`❌ Failed to add: ${result.action.type}/${result.action.name}`);
        }
      }
    }
    
    // Process updates in batches
    for (let i = 0; i < syncActions.toUpdate.length; i += BATCH_SIZE) {
      const batch = syncActions.toUpdate.slice(i, i + BATCH_SIZE);
      const batchResults = await processBatch(batch, '🔄 Updating');
      this.assertMemoryOperation();
      
      for (const result of batchResults) {
        if (result.success) {
          results.updated++;
        } else {
          logger.error(`Failed to update ${result.action.type}/${result.action.name}`, { error: result.error });
          progressMessages.push(`❌ Failed to update: ${result.action.type}/${result.action.name}`);
        }
      }
    }
    
    // Process deletions
    for (const action of syncActions.toDelete) {
      try {
        progressMessages.push(`🗑️ Deleting: ${action.type}/${action.name}`);
        await this.deleteLocalElement(action);
        this.assertMemoryOperation();
        results.deleted++;
      } catch (error) {
        if (this.memoryOperation) throw error;
        logger.error(`Failed to delete ${action.type}/${action.name}`, { error });
        progressMessages.push(`❌ Failed to delete: ${action.type}/${action.name}`);
      }
    }
    
    // PERFORMANCE: Batch rebuild index after all operations complete
    if (results.added > 0 || results.updated > 0 || results.deleted > 0) {
      progressMessages.push('🔄 Rebuilding index...');
      await this.indexManager.rebuildIndex();
      this.assertMemoryOperation();
    }
    
    return results;
  }

  /**
   * Download element from GitHub and save locally
   * SECURITY: Added audit logging for GitHub operations
   */
  private async downloadAndSaveElement(
    action: SyncAction,
    username: string,
    repository: string
  ): Promise<void> {
    this.assertMutationType(action.type);
    // NOTE: Token should already be set on portfolioRepoManager (passed as dependency)
    // Don't re-fetch token here - it breaks dependency injection and test environments

    // SECURITY: Log the download operation for audit trail
    SecurityMonitor.logSecurityEvent({
      type: 'PORTFOLIO_FETCH_SUCCESS',
      severity: 'LOW',
      source: 'PortfolioPullHandler.downloadAndSaveElement',
      details: `Downloading element: ${action.type}/${action.name} from ${username}/${repository}`
    });
    
    // Download the element content
    const elementData = await this.downloader.downloadFromGitHub(
      this.portfolioRepoManager,
      action.path,
      username,
      repository
    );
    
    this.assertMutationType(action.type);
    // Save to local portfolio
    const elementDir = this.portfolioManager.getElementDir(action.type);
    const fileName = path.basename(action.path);
    const filePath = path.join(elementDir, fileName);

    // Phase 4.5 follow-up: when a storage-layer factory is wired AND it
    // produces a writable layer for this element type, persist through it
    // instead of writing to filesystem. Without this, DB-mode pulls land
    // on the per-user portfolio dir (typically tmpfs in containers) and
    // vanish on every restart. Filesystem-mode deployments fall through.
    const { persistElementViaFactory } = await import('../storage/persistElementViaFactory.js');
    this.assertMutationType(action.type);
    const elementName = path.basename(action.path, path.extname(action.path));
    const persistedViaStorageLayer = await persistElementViaFactory(
      this.storageLayerFactory,
      action.type,
      elementName,
      elementData.content,
      { elementDir, fileExtension: path.extname(fileName) || '.md', scanCooldownMs: 0 },
      { exclusive: false },
    );

    this.assertMemoryOperation();
    if (!persistedViaStorageLayer) {
      // Ensure parent directory exists before writing (defensive check)
      await this.fileOperations.createDirectory(elementDir);

      this.assertMutationType(action.type);
      await this.fileOperations.writeFile(filePath, elementData.content, {
        encoding: 'utf-8',
        source: 'PortfolioPullHandler.downloadAndSaveElement'
      });
      this.assertMemoryOperation();
    }

    this.assertMemoryOperation();
    // SECURITY: Log successful save for audit trail
    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_CREATED',
      severity: 'LOW',
      source: 'PortfolioPullHandler.downloadAndSaveElement',
      details: `Saved element to: ${action.type}/${fileName}`
    });
    
    // PERFORMANCE: Skip individual index rebuild - will batch rebuild after all operations
  }

  /**
   * Delete local element
   * SECURITY: Added audit logging for deletion operations
   */
  private async deleteLocalElement(action: SyncAction): Promise<void> {
    this.assertMutationType(action.type);
    const elementDir = this.portfolioManager.getElementDir(action.type);
    // Use the original filename from the path to preserve extension
    const fileName = path.basename(action.path) || `${action.name}.md`;
    const filePath = path.join(elementDir, fileName);
    
    // SECURITY: Log deletion attempt for audit trail
    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_DELETED',
      severity: 'MEDIUM',
      source: 'PortfolioPullHandler.deleteLocalElement',
      details: `Attempting to delete: ${action.type}/${fileName}`
    });
    
    const layer = this.memoryOperation && this.storageLayerFactory?.createForElement(action.type,
      { elementDir, fileExtension: path.extname(fileName) || '.md', scanCooldownMs: 0 });
    if (layer && isWritableStorageLayer(layer)) {
      this.assertMutationType(action.type);
      await layer.deleteContent(action.type, action.name);
      this.assertMemoryOperation();
      return;
    }
    this.assertMutationType(action.type);
    await this.fileOperations.deleteFile(filePath, action.type, {
      source: 'PortfolioPullHandler.deleteLocalElement'
    });
    this.assertMemoryOperation();
    // PERFORMANCE: Skip individual index rebuild - will batch rebuild after all operations

    // SECURITY: Log successful deletion
    SecurityMonitor.logSecurityEvent({
      type: 'ELEMENT_DELETED',
      severity: 'MEDIUM',
      source: 'PortfolioPullHandler.deleteLocalElement',
      details: `Successfully deleted: ${action.type}/${fileName}`
    });
  }

  /**
   * Get GitHub token from auth manager
   */
  private async getGitHubToken(): Promise<string> {
    const token = await this.tokenManager.getGitHubTokenAsync();
    this.assertMemoryOperation();
    if (!token) {
      throw new Error('GitHub authentication required. Please run setup_github_auth first.');
    }
    return token;
  }
}
