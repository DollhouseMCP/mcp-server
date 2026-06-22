/**
 * PortfolioSyncManager - Handles synchronization between local and GitHub portfolios
 * 
 * Features:
 * - Download elements from GitHub portfolio
 * - Upload elements with consent
 * - Version comparison and diff viewing
 * - Privacy-first with explicit permissions
 * - Conflict resolution strategies
 * - Bulk operations with configuration checks
 */

import * as path from 'path';
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import { ConfigManager, DollhouseConfig } from '../config/ConfigManager.js';
import { PortfolioManager } from './PortfolioManager.js';
import { PortfolioRepoManager } from './PortfolioRepoManager.js';
import { GitHubPortfolioIndexer, GitHubIndexEntry } from './GitHubPortfolioIndexer.js';
import { TokenManager } from '../security/tokenManager.js';
import { ContentValidator } from '../security/contentValidator.js';
import { UnicodeValidator } from '../security/validators/unicodeValidator.js';
import { SecureYamlParser } from '../security/secureYamlParser.js';
import { ElementType } from './types.js';
import { PortfolioElementAdapter } from '../tools/portfolio/PortfolioElementAdapter.js';
import { IFileOperationsService } from '../services/FileOperationsService.js';

export interface SyncOperation {
  operation: 'download' | 'upload' | 'compare' | 'list-remote';
  element_name?: string;
  element_type?: ElementType;
  bulk?: boolean;
  version?: string;
  show_diff?: boolean;
  force?: boolean;
  confirm?: boolean;
}

export interface SyncResult {
  success: boolean;
  message: string;
  data?: any;
  elements?: SyncElementInfo[];
  conflicts?: ConflictInfo[];
}

export interface SyncElementInfo {
  name: string;
  type: ElementType;
  localVersion?: string;
  remoteVersion?: string;
  status: 'new' | 'updated' | 'conflict' | 'unchanged' | 'local-only';
  action?: 'download' | 'upload' | 'skip';
}

export interface ConflictInfo {
  element: string;
  type: ElementType;
  localVersion: string;
  remoteVersion: string;
  localModified: Date;
  remoteModified: Date;
  resolution?: 'local' | 'remote' | 'manual';
}

export interface VersionInfo {
  version: string;
  timestamp: Date;
  author: string;
  hash: string;
  size: number;
  source: 'local' | 'remote';
}

export interface ElementDiff {
  element: string;
  type: ElementType;
  changes: {
    metadata?: {
      field: string;
      oldValue: any;
      newValue: any;
    }[];
    content?: {
      additions: number;
      deletions: number;
      diff: string;
    };
  };
}

export interface PortfolioSyncManagerDependencies {
  configManager: ConfigManager;
  portfolioManager: PortfolioManager;
  portfolioRepoManager: PortfolioRepoManager;
  indexer: GitHubPortfolioIndexer;
  fileOperations: IFileOperationsService;
  tokenManager: TokenManager;
  /**
   * Phase 4.5 follow-up: optional storage-layer factory. When present AND
   * the factory produces a writable (database-backed) layer for the element
   * type, `downloadElement` writes through it instead of the legacy
   * filesystem-only path. Closes the bug where DB-mode sync downloads
   * landed on tmpfs and vanished on restart. Same correctness pattern as
   * the ElementInstaller and PortfolioPullHandler fixes.
   */
  storageLayerFactory?: import('../storage/IStorageLayerFactory.js').IStorageLayerFactory;
}

export class PortfolioSyncManager {
  private configManager: ConfigManager;
  private portfolioManager: PortfolioManager;
  private repoManager: PortfolioRepoManager;
  private indexer: GitHubPortfolioIndexer;
  private fileOperations: IFileOperationsService;
  private tokenManager: TokenManager;
  private readonly storageLayerFactory?: import('../storage/IStorageLayerFactory.js').IStorageLayerFactory;

  constructor(dependencies: PortfolioSyncManagerDependencies) {
    this.configManager = dependencies.configManager;
    this.portfolioManager = dependencies.portfolioManager;
    this.repoManager = dependencies.portfolioRepoManager;
    this.indexer = dependencies.indexer;
    this.fileOperations = dependencies.fileOperations;
    this.tokenManager = dependencies.tokenManager;
    this.storageLayerFactory = dependencies.storageLayerFactory;
  }
  
  /**
   * Main handler for sync operations
   */
  public async handleSyncOperation(params: SyncOperation): Promise<SyncResult> {
    try {
      const config = this.configManager.getConfig();
      const configFailure = this.validateSyncOperationConfig(params, config);
      if (configFailure) {
        return configFailure;
      }
      return await this.dispatchSyncOperation(params);
    } catch (error) {
      logger.error('Sync operation failed', {
        operation: params.operation,
        error: error instanceof Error ? error.message : String(error)
      });
      
      return {
        success: false,
        message: `Sync operation failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private validateSyncOperationConfig(
    params: SyncOperation,
    config: DollhouseConfig
  ): SyncResult | null {
    if (!config.sync.enabled && params.operation !== 'list-remote') {
      return {
        success: false,
        message: 'Sync is disabled. Enable it with: dollhouse_config --action update --setting sync.enabled --value true'
      };
    }

    if (!params.bulk) {
      return null;
    }
    const bulkAllowed = this.isBulkOperationAllowed(params.operation, config);
    return bulkAllowed.allowed ? null : { success: false, message: bulkAllowed.message };
  }

  private async dispatchSyncOperation(params: SyncOperation): Promise<SyncResult> {
    switch (params.operation) {
      case 'list-remote':
        return await this.listRemoteElements(params.element_type);
      case 'download':
        return await this.handleDownloadOperation(params);
      case 'upload':
        return await this.handleUploadOperation(params);
      case 'compare':
        return await this.handleCompareOperation(params);
      default:
        return {
          success: false,
          message: `Unknown operation: ${params.operation}`
        };
    }
  }

  private async handleDownloadOperation(params: SyncOperation): Promise<SyncResult> {
    if (params.bulk) {
      return await this.bulkDownload(params.element_type, params.confirm);
    }
    if (!params.element_name) {
      return { success: false, message: 'Element name required for individual download' };
    }
    return await this.downloadElement(
      params.element_name,
      params.element_type!,
      params.version,
      params.force
    );
  }

  private async handleUploadOperation(params: SyncOperation): Promise<SyncResult> {
    if (params.bulk) {
      return await this.bulkUpload(params.element_type, params.confirm);
    }
    if (!params.element_name) {
      return { success: false, message: 'Element name required for individual upload' };
    }
    return await this.uploadElement(params.element_name, params.element_type!, params.confirm);
  }

  private async handleCompareOperation(params: SyncOperation): Promise<SyncResult> {
    if (!params.element_name || !params.element_type) {
      return { success: false, message: 'Element name and type required for comparison' };
    }
    return await this.compareVersions(params.element_name, params.element_type, params.show_diff);
  }
  
  /**
   * Check if bulk operation is allowed
   */
  private isBulkOperationAllowed(operation: string, config: DollhouseConfig): { allowed: boolean; message: string } {
    if (operation === 'download' && !config.sync.bulk.download_enabled) {
      return {
        allowed: false,
        message: 'Bulk download is disabled. Enable with: dollhouse_config --action update --setting sync.bulk.download_enabled --value true'
      };
    }
    
    if (operation === 'upload' && !config.sync.bulk.upload_enabled) {
      return {
        allowed: false,
        message: 'Bulk upload is disabled. Enable with: dollhouse_config --action update --setting sync.bulk.upload_enabled --value true'
      };
    }
    
    return { allowed: true, message: '' };
  }
  
  /**
   * List elements available in GitHub portfolio
   */
  private async listRemoteElements(filterType?: ElementType): Promise<SyncResult> {
    try {
      // Get GitHub token
      const token = await this.tokenManager.getGitHubTokenAsync();
      if (!token) {
        return {
          success: false,
          message: 'GitHub authentication required. Use setup_github_auth first.'
        };
      }
      
      this.repoManager.setToken(token);
      
      // Get index of GitHub portfolio
      const index = await this.indexer.getIndex();
      
      if (!index || index.totalElements === 0) {
        return {
          success: true,
          message: 'No elements found in GitHub portfolio',
          elements: []
        };
      }
      
      // Format elements for display
      const elements: SyncElementInfo[] = [];
      
      for (const [type, entries] of index.elements) {
        // Skip if filtering by type and this isn't the requested type
        if (filterType && type !== filterType) {
          continue;
        }
        
        for (const entry of entries) {
          elements.push({
            name: entry.name,
            type: type,
            remoteVersion: entry.version,
            status: 'unchanged',
            action: 'download'
          });
        }
      }
      
      return {
        success: true,
        message: `Found ${elements.length} elements in GitHub portfolio`,
        elements
      };
      
    } catch (error) {
      return {
        success: false,
        message: `Failed to list remote elements: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }
  
  /**
   * Download a specific element from GitHub
   */
  private async downloadElement(
    elementName: string,
    elementType: ElementType,
    version?: string,
    force?: boolean
  ): Promise<SyncResult> {
    try {
      const config = this.configManager.getConfig();
      const validationFailure = this.validateDownloadElementName(elementName);
      if (validationFailure) {
        return validationFailure;
      }

      const token = await this.requireGitHubToken();
      if (!token) {
        return { success: false, message: 'GitHub authentication required' };
      }
      this.repoManager.setToken(token);

      const index = await this.indexer.getIndex();
      const entries = index.elements.get(elementType) || [];
      const entry = this.findRemoteElementEntry(elementName, entries);
      if (!entry) {
        return this.buildRemoteElementNotFoundResult(elementName, elementType, entries);
      }

      const localPath = this.portfolioManager.getElementPath(elementType, `${elementName}.md`);
      const localContent = await this.readLocalElementContent(localPath, 'PortfolioSyncManager.downloadElement');
      const remoteContent = await this.fetchRemoteElementContent(entry.downloadUrl, token);
      const securityFailure = this.validateRemoteContent(remoteContent);
      if (securityFailure) {
        return securityFailure;
      }

      const conflictResult = await this.resolveDownloadConflict({
        elementName,
        elementType,
        localPath,
        localContent,
        remoteContent,
        entry,
        config,
        force,
      });
      if (conflictResult) {
        return conflictResult;
      }

      const persistedViaStorageLayer = await this.persistDownloadedElement(
        elementName,
        elementType,
        localPath,
        remoteContent
      );

      logger.info('Element downloaded from GitHub', {
        element: elementName,
        type: elementType,
        version: entry.version,
        target: persistedViaStorageLayer ? 'storage-layer' : 'filesystem',
      });
      
      return {
        success: true,
        message: `Successfully downloaded '${elementName}' (${elementType}) from GitHub portfolio`
      };
      
    } catch (error) {
      return {
        success: false,
        message: `Failed to download element: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private validateDownloadElementName(elementName: string): SyncResult | null {
    const validation = UnicodeValidator.normalize(elementName);
    return validation.isValid
      ? null
      : {
          success: false,
          message: `Invalid element name: ${validation.detectedIssues?.[0] || 'unknown error'}`
        };
  }

  private async requireGitHubToken(): Promise<string | null> {
    return await this.tokenManager.getGitHubTokenAsync();
  }

  private findRemoteElementEntry(
    elementName: string,
    entries: GitHubIndexEntry[]
  ): GitHubIndexEntry | undefined {
    const exactMatch = entries.find(e => e.name === elementName);
    if (exactMatch) {
      return exactMatch;
    }

    const caseInsensitiveMatch = entries.find(e => e.name.toLowerCase() === elementName.toLowerCase());
    if (caseInsensitiveMatch) {
      return caseInsensitiveMatch;
    }

    const fuzzyMatch = this.findFuzzyMatch(elementName, entries);
    if (fuzzyMatch) {
      logger.info(`Fuzzy match found: '${elementName}' matched to '${fuzzyMatch.name}'`);
    }
    return fuzzyMatch ?? undefined;
  }

  private buildRemoteElementNotFoundResult(
    elementName: string,
    elementType: ElementType,
    entries: GitHubIndexEntry[]
  ): SyncResult {
    const suggestions = this.getSuggestions(elementName, entries);
    const suggestionText = suggestions.length > 0
      ? `\n\nDid you mean one of these?\n${suggestions.map(s => `  • ${s.name}`).join('\n')}`
      : '';
    return {
      success: false,
      message: `Element '${elementName}' (${elementType}) not found in GitHub portfolio${suggestionText}`
    };
  }

  private async readLocalElementContent(localPath: string, source: string): Promise<string | null> {
    try {
      return await this.fileOperations.readFile(localPath, { source });
    } catch {
      return null;
    }
  }

  private async fetchRemoteElementContent(downloadUrl: string, token: string): Promise<string> {
    const response = await fetch(downloadUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3.raw'
      }
    });
    if (!response.ok) {
      throw new Error(`Failed to download: ${response.statusText}`);
    }
    return await response.text();
  }

  private validateRemoteContent(remoteContent: string): SyncResult | null {
    const validationResult = ContentValidator.validateAndSanitize(remoteContent);
    if (validationResult.isValid || validationResult.severity !== 'critical') {
      return null;
    }
    return {
      success: false,
      message: `Security issue detected in remote content: ${validationResult.detectedPatterns?.join(', ')}`
    };
  }

  private async resolveDownloadConflict(args: {
    elementName: string;
    elementType: ElementType;
    localPath: string;
    localContent: string | null;
    remoteContent: string;
    entry: GitHubIndexEntry;
    config: DollhouseConfig;
    force?: boolean;
  }): Promise<SyncResult | null> {
    const { elementName, elementType, localPath, localContent, remoteContent, entry, config, force } = args;
    if (!localContent) {
      return null;
    }
    const localHash = createHash('sha256').update(localContent).digest('hex');
    const remoteHash = createHash('sha256').update(remoteContent).digest('hex');
    if (localHash === remoteHash) {
      return { success: true, message: `Element '${elementName}' is already up to date` };
    }
    if (!config.sync.individual.require_confirmation || force) {
      return null;
    }

    const diff = await this.generateDiff(localContent, remoteContent);
    const conflictInfo = await this.buildConflictInfo(elementName, elementType, localPath, localContent, entry);
    logger.warn('Sync conflict detected', { element: elementName, type: elementType, conflict: conflictInfo });
    return {
      success: false,
      message: `Local version exists. Please confirm download will overwrite:\n\n${diff}\n\nTo proceed, use --force flag`,
      data: { requiresConfirmation: true },
      conflicts: [conflictInfo]
    };
  }

  private async persistDownloadedElement(
    elementName: string,
    elementType: ElementType,
    localPath: string,
    remoteContent: string
  ): Promise<boolean> {
    const { persistElementViaFactory } = await import('../storage/persistElementViaFactory.js');
    const elementDir = path.dirname(localPath);
    const persistedViaStorageLayer = await persistElementViaFactory(
      this.storageLayerFactory,
      elementType,
      elementName,
      remoteContent,
      { elementDir, fileExtension: path.extname(localPath) || '.md', scanCooldownMs: 0 },
      { exclusive: false },
    );

    if (!persistedViaStorageLayer) {
      await this.fileOperations.createDirectory(elementDir);
      await this.fileOperations.writeFile(localPath, remoteContent, { source: 'PortfolioSyncManager.downloadElement' });
    }
    return persistedViaStorageLayer;
  }
  
  /**
   * Upload a specific element to GitHub
   */
  private async uploadElement(
    elementName: string,
    elementType: ElementType,
    confirm?: boolean
  ): Promise<SyncResult> {
    try {
      const config = this.configManager.getConfig();
      const localPath = this.portfolioManager.getElementPath(elementType, `${elementName}.md`);
      const content = await this.readUploadContent(elementName, elementType, localPath);
      if (typeof content !== 'string') {
        return content;
      }

      const parsed = SecureYamlParser.parse(content, {
        maxYamlSize: 64 * 1024,
        validateContent: false,
        validateFields: false
      });

      const uploadValidationFailure = this.validateUploadContent(elementName, content, parsed.data, config);
      if (uploadValidationFailure) {
        return uploadValidationFailure;
      }

      if (config.sync.individual.require_confirmation && !confirm) {
        return {
          success: false,
          message: `Please confirm upload of '${elementName}' (${elementType}) to GitHub.\n\nContent preview:\n${content.substring(0, 500)}...\n\nTo proceed, use --confirm flag`,
          data: { requiresConfirmation: true }
        };
      }

      const token = await this.requireGitHubToken();
      if (!token) {
        return {
          success: false,
          message: 'GitHub authentication required'
        };
      }
      
      // Create a PortfolioElement for the adapter (fixes Issue #913)
      // Using PortfolioElementAdapter instead of incomplete IElement implementation
      const portfolioElement = {
        type: elementType,
        metadata: {
          name: elementName,
          description: parsed.data?.description || '',
          author: parsed.data?.author || 'unknown',
          created: parsed.data?.created || new Date().toISOString(),
          updated: new Date().toISOString(),
          version: parsed.data?.version || '1.0.0',
          tags: parsed.data?.tags || []
        },
        content: content
      };
      
      const adapter = new PortfolioElementAdapter(portfolioElement);
      this.repoManager.setToken(token);
      return await this.saveElementToGitHub(adapter, elementName, elementType, token);
      
    } catch (error) {
      return {
        success: false,
        message: `Failed to upload element: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private async readUploadContent(
    elementName: string,
    elementType: ElementType,
    localPath: string
  ): Promise<string | SyncResult> {
    try {
      return await this.fileOperations.readFile(localPath, { source: 'PortfolioSyncManager.uploadElement' });
    } catch {
      return {
        success: false,
        message: `Element '${elementName}' (${elementType}) not found locally`
      };
    }
  }

  private validateUploadContent(
    elementName: string,
    content: string,
    parsedData: any,
    config: DollhouseConfig
  ): SyncResult | null {
    if (parsedData?.privacy?.local_only === true) {
      return {
        success: false,
        message: `Element '${elementName}' is marked as local-only and cannot be uploaded`
      };
    }

    const validationResult = ContentValidator.validateAndSanitize(content);
    if (!validationResult.isValid && validationResult.severity === 'critical') {
      return {
        success: false,
        message: `Security issue detected: ${validationResult.detectedPatterns?.join(', ')}`
      };
    }

    return config.sync.privacy.scan_for_secrets
      ? this.validateNoUploadSecrets(content)
      : null;
  }

  private validateNoUploadSecrets(content: string): SyncResult | null {
    logger.debug('Scanning for secrets before upload');
    const secretPatterns = [
      /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/gi,
      /secret\s*[:=]\s*['"][^'"]+['"]/gi,
      /password\s*[:=]\s*['"][^'"]+['"]/gi,
      /token\s*[:=]\s*['"][^'"]+['"]/gi,
      /private[_-]?key\s*[:=]\s*['"][^'"]+['"]/gi
    ];

    return secretPatterns.some(pattern => pattern.test(content))
      ? {
          success: false,
          message: 'Potential secret detected in content. Please review and remove sensitive information before uploading.'
        }
      : null;
  }

  private async saveElementToGitHub(
    adapter: PortfolioElementAdapter,
    elementName: string,
    elementType: ElementType,
    token: string
  ): Promise<SyncResult> {
    logger.debug('[BULK_SYNC_DEBUG] Upload element attempt', {
      elementName,
      elementType,
      hasToken: !!token,
      tokenPrefix: token.substring(0, 10) + '...',
      adapterHasMetadata: !!adapter.metadata,
      timestamp: new Date().toISOString()
    });

    try {
      const url = await this.repoManager.saveElement(adapter, true);
      logger.info('Element uploaded to GitHub', { element: elementName, type: elementType, url });
      return {
        success: true,
        message: `Successfully uploaded '${elementName}' (${elementType}) to GitHub portfolio`,
        data: { url }
      };
    } catch (uploadError) {
      if (uploadError instanceof Error && uploadError.message.includes('repository does not exist')) {
        return {
          success: false,
          message: 'GitHub portfolio repository not found. Please initialize it first using init_portfolio tool.'
        };
      }
      throw uploadError;
    }
  }
  
  /**
   * Compare local and remote versions
   */
  private async compareVersions(
    elementName: string,
    elementType: ElementType,
    showDiff?: boolean
  ): Promise<SyncResult> {
    try {
      const localPath = this.portfolioManager.getElementPath(elementType, `${elementName}.md`);
      const local = await this.loadLocalVersion(localPath);
      const token = await this.requireGitHubToken();
      if (!token) {
        return { success: false, message: 'GitHub authentication required' };
      }

      const index = await this.indexer.getIndex();
      const entries = index.elements.get(elementType) || [];
      const entry = entries.find(e => e.name === elementName);
      const remote = entry ? await this.loadRemoteVersion(entry, token) : { version: null, content: null };
      const result = await this.buildVersionComparisonResult(
        elementName,
        elementType,
        local,
        remote,
        showDiff
      );

      return {
        success: true,
        message: `Version comparison for '${elementName}' (${elementType})`,
        data: result
      };
      
    } catch (error) {
      return {
        success: false,
        message: `Failed to compare versions: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private async loadLocalVersion(
    localPath: string
  ): Promise<{ version: VersionInfo | null; content: string | null }> {
    try {
      const content = await this.fileOperations.readFile(localPath, { source: 'PortfolioSyncManager.compareVersions' });
      const parsed = SecureYamlParser.parse(content, {
        maxYamlSize: 64 * 1024,
        validateContent: false,
        validateFields: false
      });
      return {
        content,
        version: {
          version: parsed.data?.version || '1.0.0',
          timestamp: new Date(parsed.data?.updated || parsed.data?.created || Date.now()),
          author: parsed.data?.author || 'unknown',
          hash: createHash('sha256').update(content).digest('hex'),
          size: Buffer.byteLength(content),
          source: 'local'
        }
      };
    } catch {
      return { version: null, content: null };
    }
  }

  private async loadRemoteVersion(
    entry: GitHubIndexEntry,
    token: string
  ): Promise<{ version: VersionInfo | null; content: string | null }> {
    const response = await fetch(entry.downloadUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3.raw'
      }
    });
    if (!response.ok) {
      return { version: null, content: null };
    }

    const content = await response.text();
    return {
      content,
      version: {
        version: entry.version || '1.0.0',
        timestamp: entry.lastModified,
        author: entry.author || 'unknown',
        hash: createHash('sha256').update(content).digest('hex'),
        size: entry.size,
        source: 'remote'
      }
    };
  }

  private async buildVersionComparisonResult(
    elementName: string,
    elementType: ElementType,
    local: { version: VersionInfo | null; content: string | null },
    remote: { version: VersionInfo | null; content: string | null },
    showDiff?: boolean
  ): Promise<any> {
    const result: any = {
      element: elementName,
      type: elementType,
      local: local.version,
      remote: remote.version
    };

    result.status = this.getVersionComparisonStatus(local.version, remote.version);
    if (showDiff && local.content && remote.content && result.status === 'different') {
      result.diff = await this.generateDiff(local.content, remote.content);
    }
    return result;
  }

  private getVersionComparisonStatus(
    localVersion: VersionInfo | null,
    remoteVersion: VersionInfo | null
  ): 'identical' | 'different' | 'local-only' | 'remote-only' | 'not-found' {
    if (localVersion && remoteVersion) {
      return localVersion.hash === remoteVersion.hash ? 'identical' : 'different';
    }
    if (localVersion) return 'local-only';
    if (remoteVersion) return 'remote-only';
    return 'not-found';
  }
  
  /**
   * Bulk download elements
   */
  private async bulkDownload(elementType?: ElementType, confirm?: boolean): Promise<SyncResult> {
    const config = this.configManager.getConfig();

    if (!config.sync.bulk.download_enabled) {
      return {
        success: false,
        message: 'Bulk download is not enabled in configuration'
      };
    }
    
    // Get list of remote elements
    const remoteResult = await this.listRemoteElements();
    if (!remoteResult.success || !remoteResult.elements) {
      return remoteResult;
    }
    
    // Filter by type if specified
    let elementsToDownload = remoteResult.elements;
    if (elementType) {
      elementsToDownload = elementsToDownload.filter(e => e.type === elementType);
    }
    
    if (elementsToDownload.length === 0) {
      return {
        success: true,
        message: 'No elements to download',
        elements: []
      };
    }

    if (config.sync.bulk.require_preview && !confirm) {
      return this.buildBulkDownloadPreview(elementsToDownload);
    }

    const results = PortfolioSyncManager.createBulkDownloadResults();
    for (const element of elementsToDownload) {
      await this.downloadBulkElement(element, results);
    }

    return {
      success: results.failed.length === 0,
      message: PortfolioSyncManager.buildBulkDownloadSummary(results),
      data: results
    };
  }

  private buildBulkDownloadPreview(elementsToDownload: SyncElementInfo[]): SyncResult {
    return {
      success: false,
      message: `Bulk download preview:\n\n${elementsToDownload.length} elements will be downloaded:\n${elementsToDownload.map(e => `- ${e.name} (${e.type})`).join('\n')}\n\nTo proceed, use --confirm flag`,
      data: { requiresConfirmation: true },
      elements: elementsToDownload
    };
  }

  private static createBulkDownloadResults(): {
    downloaded: string[];
    skipped: string[];
    failed: Array<{ name: string; error: string }>;
  } {
    return { downloaded: [], skipped: [], failed: [] };
  }

  private async downloadBulkElement(
    element: SyncElementInfo,
    results: ReturnType<typeof PortfolioSyncManager.createBulkDownloadResults>
  ): Promise<void> {
    try {
      const result = await this.downloadElement(element.name, element.type, undefined, true);
      if (result.success) {
        results.downloaded.push(element.name);
      } else if (result.message?.includes('already up to date')) {
        results.skipped.push(element.name);
      } else {
        results.failed.push({ name: element.name, error: result.message || 'Unknown error' });
      }
    } catch (error) {
      results.failed.push({
        name: element.name,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private static buildBulkDownloadSummary(
    results: ReturnType<typeof PortfolioSyncManager.createBulkDownloadResults>
  ): string {
    let message = `Bulk download complete:\n`;
    message += `- Downloaded: ${results.downloaded.length} elements\n`;
    message += `- Skipped (up to date): ${results.skipped.length} elements\n`;
    message += `- Failed: ${results.failed.length} elements`;
    if (results.failed.length > 0) {
      message += `\n\nFailed downloads:\n${results.failed.map(f => `- ${f.name}: ${f.error}`).join('\n')}`;
    }
    return message;
  }
  
  /**
   * Bulk upload elements
   */
  private async bulkUpload(elementType?: ElementType, confirm?: boolean): Promise<SyncResult> {
    const config = this.configManager.getConfig();
    
    if (!config.sync.bulk.upload_enabled) {
      return {
        success: false,
        message: 'Bulk upload is not enabled in configuration'
      };
    }
    
    const localElements = await this.listLocalElementsForUpload(elementType);
    
    if (localElements.length === 0) {
      return {
        success: true,
        message: 'No local elements to upload',
        elements: []
      };
    }
    
    if (config.sync.bulk.require_preview && !confirm) {
      return this.buildBulkUploadPreview(localElements);
    }

    const results = PortfolioSyncManager.createBulkUploadResults();
    for (const element of localElements) {
      await this.uploadBulkElement(element, results);
    }

    return {
      success: results.failed.length === 0,
      message: PortfolioSyncManager.buildBulkUploadSummary(results),
      data: results
    };
  }

  private async listLocalElementsForUpload(
    elementType?: ElementType
  ): Promise<Array<{ name: string; type: ElementType; path: string }>> {
    const types = elementType ? [elementType] : [
      ElementType.PERSONA,
      ElementType.SKILL,
      ElementType.TEMPLATE,
      ElementType.AGENT,
      ElementType.MEMORY,
      ElementType.ENSEMBLE
    ];
    const localElements: Array<{ name: string; type: ElementType; path: string }> = [];
    for (const type of types) {
      await this.collectLocalElementsOfType(type, localElements);
    }
    return localElements;
  }

  private async collectLocalElementsOfType(
    type: ElementType,
    localElements: Array<{ name: string; type: ElementType; path: string }>
  ): Promise<void> {
    const dir = this.portfolioManager.getElementDir(type);
    try {
      const files = await this.fileOperations.listDirectory(dir);
      for (const file of files) {
        if (file.endsWith('.md')) {
          localElements.push({ name: file.replace('.md', ''), type, path: path.join(dir, file) });
        }
      }
    } catch {
      logger.debug(`Directory for ${type} does not exist yet`);
    }
  }

  private buildBulkUploadPreview(
    localElements: Array<{ name: string; type: ElementType; path: string }>
  ): SyncResult {
    const previewElements: SyncElementInfo[] = localElements.map(e => ({
      name: e.name,
      type: e.type,
      status: 'local-only' as const,
      action: 'upload' as const
    }));
    return {
      success: false,
      message: `Bulk upload preview:\n\n${localElements.length} elements will be uploaded:\n${localElements.map(e => `- ${e.name} (${e.type})`).join('\n')}\n\nTo proceed, use --confirm flag`,
      data: { requiresConfirmation: true },
      elements: previewElements
    };
  }

  private static createBulkUploadResults(): {
    uploaded: string[];
    skipped: string[];
    failed: Array<{ name: string; error: string }>;
  } {
    return { uploaded: [], skipped: [], failed: [] };
  }

  private async uploadBulkElement(
    element: { name: string; type: ElementType },
    results: ReturnType<typeof PortfolioSyncManager.createBulkUploadResults>
  ): Promise<void> {
    try {
      const result = await this.uploadElement(element.name, element.type, true);
      if (result.success) {
        results.uploaded.push(element.name);
      } else if (result.message?.includes('local-only')) {
        results.skipped.push(element.name);
      } else {
        results.failed.push({ name: element.name, error: result.message || 'Unknown error' });
      }
    } catch (error) {
      results.failed.push({
        name: element.name,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private static buildBulkUploadSummary(
    results: ReturnType<typeof PortfolioSyncManager.createBulkUploadResults>
  ): string {
    let message = `Bulk upload complete:\n`;
    message += `- Uploaded: ${results.uploaded.length} elements\n`;
    message += `- Skipped (local-only): ${results.skipped.length} elements\n`;
    message += `- Failed: ${results.failed.length} elements`;
    if (results.failed.length > 0) {
      message += `\n\nFailed uploads:\n${results.failed.map(f => `- ${f.name}: ${f.error}`).join('\n')}`;
    }
    return message;
  }
  
  /**
   * Generate diff between two content versions
   */
  private async generateDiff(local: string, remote: string): Promise<string> {
    // Simple line-based diff for now
    const localLines = local.split('\n');
    const remoteLines = remote.split('\n');
    
    let diff = '';
    const maxLines = Math.max(localLines.length, remoteLines.length);
    
    for (let i = 0; i < maxLines && i < 10; i++) { // Show first 10 lines of diff
      const localLine = localLines[i] || '';
      const remoteLine = remoteLines[i] || '';
      
      if (localLine !== remoteLine) {
        if (localLine && !remoteLine) {
          diff += `- ${localLine}\n`;
        } else if (!localLine && remoteLine) {
          diff += `+ ${remoteLine}\n`;
        } else {
          diff += `- ${localLine}\n`;
          diff += `+ ${remoteLine}\n`;
        }
      }
    }
    
    if (maxLines > 10) {
      diff += `\n... ${maxLines - 10} more lines ...`;
    }
    
    return diff || 'No differences found';
  }

  /**
   * Build conflict metadata for UX/logging
   */
  private async buildConflictInfo(
    elementName: string,
    elementType: ElementType,
    localPath: string,
    localContent: string,
    remoteEntry: GitHubIndexEntry
  ): Promise<ConflictInfo> {
    const localMeta = this.extractMetadata(localContent);
    let localModified = new Date();
    try {
      const stats = await this.fileOperations.stat(localPath);
      localModified = stats.mtime;
    } catch {
      // Ignore - use current date fallback
    }

    const remoteModified = remoteEntry.lastModified ? new Date(remoteEntry.lastModified) : new Date();

    return {
      element: elementName,
      type: elementType,
      localVersion: localMeta.version ?? 'unknown',
      remoteVersion: remoteEntry.version ?? 'unknown',
      localModified,
      remoteModified
    };
  }

  private extractMetadata(content: string): { version?: string } {
    try {
      const parsed = SecureYamlParser.parse(content, {
        maxYamlSize: 64 * 1024,
        validateContent: false,
        validateFields: false
      });
      return {
        version: parsed.data?.version
      };
    } catch {
      return {};
    }
  }
  
  /**
   * Find a fuzzy match for an element name
   */
  private findFuzzyMatch(searchName: string, entries: GitHubIndexEntry[]): GitHubIndexEntry | null {
    const search = searchName.toLowerCase().replaceAll(/[-_]/g, '');
    let bestMatch: typeof entries[0] | null = null;
    let bestScore = 0;
    
    for (const entry of entries) {
      // Normalize the entry name for comparison
      const normalized = entry.name.toLowerCase().replaceAll(/[-_]/g, '');
      
      // Calculate similarity score
      const score = this.calculateSimilarity(search, normalized);
      if (score > bestScore && score > 0.5) { // Minimum threshold of 0.5
        bestScore = score;
        bestMatch = entry;
      }
    }
    
    return bestMatch;
  }
  
  /**
   * Get suggestions for similar element names
   */
  private getSuggestions(searchName: string, entries: GitHubIndexEntry[]): Array<{name: string}> {
    const search = searchName.toLowerCase().replaceAll(/[-_]/g, '');
    const scored: Array<{entry: typeof entries[0]; score: number}> = [];
    
    for (const entry of entries) {
      const normalized = entry.name.toLowerCase().replaceAll(/[-_]/g, '');
      const score = this.calculateSimilarity(search, normalized);
      if (score > 0.3) { // Lower threshold for suggestions
        scored.push({ entry, score });
      }
    }
    
    // Sort by score and return top 5
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(s => ({ name: s.entry.name }));
  }
  
  /**
   * Calculate similarity between two strings
   * Returns a score between 0 and 1
   */
  private calculateSimilarity(a: string, b: string): number {
    if (a === b) return 1.0;
    if (a.includes(b) || b.includes(a)) return 0.8;

    const wordsA = a.split(/[^a-z0-9]+/);
    const wordsB = b.split(/[^a-z0-9]+/);
    return this.calculateWordSimilarity(wordsA, wordsB);
  }

  private calculateWordSimilarity(wordsA: string[], wordsB: string[]): number {
    const overlapScore = PortfolioSyncManager.calculateWordOverlapScore(wordsA, wordsB);
    if (overlapScore > 0) {
      return overlapScore;
    }
    return PortfolioSyncManager.hasPartialWordMatch(wordsA, wordsB) ? 0.5 : 0;
  }

  private static calculateWordOverlapScore(wordsA: string[], wordsB: string[]): number {
    let matches = 0;
    for (const wordA of wordsA) {
      if (wordA && wordsB.some(wordB => wordB === wordA)) {
        matches++;
      }
    }
    
    if (matches > 0) {
      const overlap = (matches * 2) / (wordsA.length + wordsB.length);
      return Math.max(0.6, overlap); // At least 0.6 for any word match
    }
    return 0;
  }

  private static hasPartialWordMatch(wordsA: string[], wordsB: string[]): boolean {
    for (const wordA of wordsA) {
      for (const wordB of wordsB) {
        if (
          wordA.length > 3 &&
          wordB.length > 3 &&
          (wordA.includes(wordB) || wordB.includes(wordA))
        ) {
          return true;
        }
      }
    }
    return false;
  }
}
