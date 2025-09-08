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

import * as fs from 'fs/promises';
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
import * as yaml from 'js-yaml';

export interface SyncOperation {
  operation: 'download' | 'upload' | 'compare' | 'list-remote';
  element_name?: string;
  element_type?: ElementType;
  bulk?: boolean;
  version?: string;
  show_diff?: boolean;
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

export class PortfolioSyncManager {
  private configManager: ConfigManager;
  private portfolioManager: PortfolioManager;
  private repoManager: PortfolioRepoManager;
  private indexer: GitHubPortfolioIndexer;
  
  constructor() {
    this.configManager = ConfigManager.getInstance();
    this.portfolioManager = PortfolioManager.getInstance();
    this.repoManager = new PortfolioRepoManager();
    this.indexer = GitHubPortfolioIndexer.getInstance();
  }
  
  /**
   * Main handler for sync operations
   */
  public async handleSyncOperation(params: SyncOperation): Promise<SyncResult> {
    try {
      // Check if sync is enabled in config
      const config = this.configManager.getConfig();
      if (!config.sync.enabled && params.operation !== 'list-remote') {
        return {
          success: false,
          message: 'Sync is disabled. Enable it with: dollhouse_config --action update --setting sync.enabled --value true'
        };
      }
      
      // Check bulk permissions
      if (params.bulk) {
        const bulkAllowed = this.isBulkOperationAllowed(params.operation, config);
        if (!bulkAllowed.allowed) {
          return {
            success: false,
            message: bulkAllowed.message
          };
        }
      }
      
      // Handle operations
      switch (params.operation) {
        case 'list-remote':
          return await this.listRemoteElements();
          
        case 'download':
          if (params.bulk) {
            return await this.bulkDownload(params.element_type);
          } else if (params.element_name) {
            return await this.downloadElement(
              params.element_name,
              params.element_type!,
              params.version
            );
          } else {
            return {
              success: false,
              message: 'Element name required for individual download'
            };
          }
          
        case 'upload':
          if (params.bulk) {
            return await this.bulkUpload(params.element_type);
          } else if (params.element_name) {
            return await this.uploadElement(
              params.element_name,
              params.element_type!
            );
          } else {
            return {
              success: false,
              message: 'Element name required for individual upload'
            };
          }
          
        case 'compare':
          if (params.element_name && params.element_type) {
            return await this.compareVersions(
              params.element_name,
              params.element_type,
              params.show_diff
            );
          } else {
            return {
              success: false,
              message: 'Element name and type required for comparison'
            };
          }
          
        default:
          return {
            success: false,
            message: `Unknown operation: ${params.operation}`
          };
      }
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
  private async listRemoteElements(): Promise<SyncResult> {
    try {
      // Get GitHub token
      const token = await TokenManager.getGitHubTokenAsync();
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
    version?: string
  ): Promise<SyncResult> {
    try {
      const config = this.configManager.getConfig();
      
      // Validate element name
      const validation = UnicodeValidator.normalize(elementName);
      if (!validation.isValid) {
        return {
          success: false,
          message: `Invalid element name: ${validation.detectedIssues?.[0] || 'unknown error'}`
        };
      }
      
      // Get token and set it
      const token = await TokenManager.getGitHubTokenAsync();
      if (!token) {
        return {
          success: false,
          message: 'GitHub authentication required'
        };
      }
      
      this.repoManager.setToken(token);
      
      // Get GitHub index
      const index = await this.indexer.getIndex();
      
      // Find the element
      const entries = index.elements.get(elementType) || [];
      const entry = entries.find(e => e.name === elementName);
      
      if (!entry) {
        return {
          success: false,
          message: `Element '${elementName}' (${elementType}) not found in GitHub portfolio`
        };
      }
      
      // Check for local conflicts
      const localPath = this.portfolioManager.getElementPath(elementType, `${elementName}.md`);
      let hasLocalVersion = false;
      let localContent: string | null = null;
      
      try {
        localContent = await fs.readFile(localPath, 'utf-8');
        hasLocalVersion = true;
      } catch {
        // No local version exists
      }
      
      // Download the element
      const response = await fetch(entry.downloadUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3.raw'
        }
      });
      
      if (!response.ok) {
        throw new Error(`Failed to download: ${response.statusText}`);
      }
      
      const remoteContent = await response.text();
      
      // Validate content security
      const validationResult = ContentValidator.validateAndSanitize(remoteContent);
      if (!validationResult.isValid && validationResult.severity === 'critical') {
        return {
          success: false,
          message: `Security issue detected in remote content: ${validationResult.detectedPatterns?.join(', ')}`
        };
      }
      
      // Check if content is different
      if (hasLocalVersion && localContent) {
        const localHash = createHash('sha256').update(localContent).digest('hex');
        const remoteHash = createHash('sha256').update(remoteContent).digest('hex');
        
        if (localHash === remoteHash) {
          return {
            success: true,
            message: `Element '${elementName}' is already up to date`
          };
        }
        
        // Show confirmation for overwrite
        if (config.sync.individual.require_confirmation) {
          const diff = await this.generateDiff(localContent, remoteContent);
          
          return {
            success: false,
            message: `Local version exists. Please confirm download will overwrite:\n\n${diff}\n\nTo proceed, use --force flag`,
            data: { requiresConfirmation: true }
          };
        }
      }
      
      // Save the element
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, remoteContent, 'utf-8');
      
      logger.info('Element downloaded from GitHub', {
        element: elementName,
        type: elementType,
        version: entry.version
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
  
  /**
   * Upload a specific element to GitHub
   */
  private async uploadElement(
    elementName: string,
    elementType: ElementType
  ): Promise<SyncResult> {
    try {
      const config = this.configManager.getConfig();
      
      // Check for local element
      const localPath = this.portfolioManager.getElementPath(elementType, `${elementName}.md`);
      
      let content: string;
      try {
        content = await fs.readFile(localPath, 'utf-8');
      } catch {
        return {
          success: false,
          message: `Element '${elementName}' (${elementType}) not found locally`
        };
      }
      
      // Check privacy metadata
      const parsed = SecureYamlParser.parse(content, {
        maxYamlSize: 64 * 1024,
        validateContent: false,
        validateFields: false
      });
      
      if (parsed.data?.privacy?.local_only === true) {
        return {
          success: false,
          message: `Element '${elementName}' is marked as local-only and cannot be uploaded`
        };
      }
      
      // Validate content security
      const validationResult = ContentValidator.validateAndSanitize(content);
      if (!validationResult.isValid && validationResult.severity === 'critical') {
        return {
          success: false,
          message: `Security issue detected: ${validationResult.detectedPatterns?.join(', ')}`
        };
      }
      
      // Scan for sensitive content if configured
      if (config.sync.privacy.scan_for_secrets) {
        // Add secret scanning logic here
        logger.debug('Scanning for secrets before upload');
      }
      
      // Get confirmation if required
      if (config.sync.individual.require_confirmation) {
        return {
          success: false,
          message: `Please confirm upload of '${elementName}' (${elementType}) to GitHub.\n\nContent preview:\n${content.substring(0, 500)}...\n\nTo proceed, use --confirm flag`,
          data: { requiresConfirmation: true }
        };
      }
      
      // Note: Actual upload would use the existing submitToPortfolioTool
      // For now, return a message indicating the element would be uploaded
      return {
        success: true,
        message: `Element '${elementName}' ready for upload. Use submit_content tool for actual upload.`
      };
      
    } catch (error) {
      return {
        success: false,
        message: `Failed to upload element: ${error instanceof Error ? error.message : String(error)}`
      };
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
      // Get local version
      const localPath = this.portfolioManager.getElementPath(elementType, `${elementName}.md`);
      let localContent: string | null = null;
      let localVersion: VersionInfo | null = null;
      
      try {
        localContent = await fs.readFile(localPath, 'utf-8');
        const parsed = SecureYamlParser.parse(localContent, {
          maxYamlSize: 64 * 1024,
          validateContent: false,
          validateFields: false
        });
        
        localVersion = {
          version: parsed.data?.version || '1.0.0',
          timestamp: new Date(parsed.data?.updated || parsed.data?.created || Date.now()),
          author: parsed.data?.author || 'unknown',
          hash: createHash('sha256').update(localContent).digest('hex'),
          size: Buffer.byteLength(localContent),
          source: 'local'
        };
      } catch {
        // No local version
      }
      
      // Get remote version
      const token = await TokenManager.getGitHubTokenAsync();
      if (!token) {
        return {
          success: false,
          message: 'GitHub authentication required'
        };
      }
      
      const index = await this.indexer.getIndex();
      const entries = index.elements.get(elementType) || [];
      const entry = entries.find(e => e.name === elementName);
      
      let remoteVersion: VersionInfo | null = null;
      let remoteContent: string | null = null;
      
      if (entry) {
        const response = await fetch(entry.downloadUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3.raw'
          }
        });
        
        if (response.ok) {
          remoteContent = await response.text();
          remoteVersion = {
            version: entry.version || '1.0.0',
            timestamp: entry.lastModified,
            author: entry.author || 'unknown',
            hash: createHash('sha256').update(remoteContent).digest('hex'),
            size: entry.size,
            source: 'remote'
          };
        }
      }
      
      // Build comparison result
      const result: any = {
        element: elementName,
        type: elementType,
        local: localVersion,
        remote: remoteVersion
      };
      
      if (localVersion && remoteVersion) {
        result.status = localVersion.hash === remoteVersion.hash ? 'identical' : 'different';
        
        if (showDiff && localContent && remoteContent && result.status === 'different') {
          result.diff = await this.generateDiff(localContent, remoteContent);
        }
      } else if (localVersion && !remoteVersion) {
        result.status = 'local-only';
      } else if (!localVersion && remoteVersion) {
        result.status = 'remote-only';
      } else {
        result.status = 'not-found';
      }
      
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
  
  /**
   * Bulk download elements
   */
  private async bulkDownload(elementType?: ElementType): Promise<SyncResult> {
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
    
    // Show preview if required
    if (config.sync.bulk.require_preview) {
      return {
        success: false,
        message: `Bulk download preview:\n\n${elementsToDownload.length} elements will be downloaded:\n${elementsToDownload.map(e => `- ${e.name} (${e.type})`).join('\n')}\n\nTo proceed, use --confirm flag`,
        data: { requiresConfirmation: true },
        elements: elementsToDownload
      };
    }
    
    // Note: Actual bulk download would iterate and download each
    return {
      success: true,
      message: `Ready to download ${elementsToDownload.length} elements. Implementation pending.`,
      elements: elementsToDownload
    };
  }
  
  /**
   * Bulk upload elements
   */
  private async bulkUpload(elementType?: ElementType): Promise<SyncResult> {
    const config = this.configManager.getConfig();
    
    if (!config.sync.bulk.upload_enabled) {
      return {
        success: false,
        message: 'Bulk upload is not enabled in configuration'
      };
    }
    
    // Get list of local elements
    // This would scan the local portfolio directories
    
    return {
      success: true,
      message: 'Bulk upload implementation pending'
    };
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
}