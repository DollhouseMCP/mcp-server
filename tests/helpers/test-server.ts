/**
 * Test helper for integration tests
 * 
 * Code Quality Improvements Applied:
 * - Added missing start(), stop(), and handleTool() methods for E2E test compatibility
 * - Improved API documentation with clear method purposes
 */

import path from 'node:path';
import { GitHubClient } from '../../src/collection/GitHubClient.js';
import { APICache } from '../../src/cache/APICache.js';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { createRealPersonaManager } from './di-mocks.js';
import type { PersonaManager } from '../../src/persona/PersonaManager.js';
import { FileLockManager } from '../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../src/services/FileOperationsService.js';

export interface TestServerOptions {
  personasDir?: string;
  portfolioDir?: string;
  mockGitHub?: boolean;
}

export class TestServer {
  public readonly personaManager: PersonaManager;
  public readonly githubClient: GitHubClient;
  public readonly apiCache: APICache;
  public readonly rateLimitTracker: Map<string, number[]>;
  public readonly portfolioManager: PortfolioManager;
  private readonly portfolioDir: string;
  private isStarted: boolean = false;
  private readonly elementVersions: Map<string, string> = new Map();
  
  constructor(options: TestServerOptions = {}) {
    const baseDir = options.portfolioDir ||
      process.env.DOLLHOUSE_PORTFOLIO_DIR ||
      process.env.TEST_BASE_DIR ||
      path.resolve(process.cwd(), '.test-tmp');

    this.portfolioDir = baseDir;
    const fileLockManager = new FileLockManager();
    const fileOperations = new FileOperationsService(fileLockManager);
    this.portfolioManager = new PortfolioManager(fileOperations, { baseDir: this.portfolioDir });

    // Create core components using factory function
    this.personaManager = createRealPersonaManager(this.portfolioDir, {
      portfolioManager: this.portfolioManager
    });
    this.apiCache = new APICache();
    this.rateLimitTracker = new Map<string, number[]>();

    // Create GitHub client
    this.githubClient = new GitHubClient(this.apiCache, this.rateLimitTracker);
  }
  
  /**
   * Start the test server (required for E2E tests)
   */
  async start(): Promise<void> {
    if (this.isStarted) return;
    await this.initialize();
    this.isStarted = true;
  }
  
  /**
   * Stop the test server (required for E2E tests)
   */
  async stop(): Promise<void> {
    if (!this.isStarted) return;
    await this.cleanup();
    this.isStarted = false;
  }
  
  /**
   * Handle MCP tool calls for E2E testing
   * NOTE: This is a simplified mock implementation for E2E tests.
   * In a full implementation, this would delegate to actual MCP tool handlers.
   */
  handleTool(toolName: string, args: any): Promise<{ success: boolean; data?: any; error?: any }> {
    try { return Promise.resolve(this.mockToolResult(toolName, args)); }
    catch (error) { return Promise.reject(error); }
  }

  private mockToolResult(toolName: string, args: any): { success: boolean; data?: any; error?: any } {

    switch (toolName) {
      case 'browse_collection':
        return {
          success: true,
          data: {
            items: [
              { name: 'test-skill-1', type: 'skill', path: 'library/skills/test-skill-1.md' },
              { name: 'test-skill-2', type: 'skill', path: 'library/skills/test-skill-2.md' }
            ]
          }
        };

      case 'search_collection':
        return {
          success: true,
          data: {
            results: [
              { name: 'roundtrip-test-skill', relevance: 0.95 }
            ]
          }
        };

      case 'install_collection_content':
        return this.installContent(args);

      case 'list_elements':
        return {
          success: true,
          data: {
            elements: [
              {
                name: 'roundtrip-test-skill',
                version: '1.0.2',
                description: 'Test skill for roundtrip workflow'
              }
            ]
          }
        };

      case 'edit_element':
        // Track version changes
        if (args.field === 'version' && args.name) {
          this.elementVersions.set(args.name, args.value);
        }
        return {
          success: true,
          data: {
            updated: true
          }
        };

      case 'get_element_details': {
        // Return the tracked version if available, otherwise default
        const version = args.name ? this.elementVersions.get(args.name) || '1.0.2' : '1.0.2';
        return {
          success: true,
          data: {
            element: {
              name: args.name || 'test-element',
              version: version,
              description: 'Test element'
            }
          }
        };
      }

      case 'portfolio_status':
        return {
          success: true,
          data: {
            initialized: true,
            hasPortfolio: false
          }
        };

      case 'portfolio_config':
        return this.configurePortfolio(args);

      case 'submit_collection_content':
        return this.submitContent(args);

      case 'get_collection_cache_health':
        return {
          success: true,
          data: {
            status: 'healthy',
            stats: {
              itemCount: 42,
              cacheAge: '5m'
            }
          }
        };

      default:
        return {
          success: false,
          error: { message: `Unknown tool: ${toolName}` }
        };
    }
  }
  
  private installContent(args: any): { success: boolean; data?: any; error?: any } {
    // Handle error case for invalid paths
    if (args.path?.includes('invalid')) {
      return {
        success: false,
        error: { message: `Invalid collection path: ${args.path}` }
      };
    }
    return {
      success: true,
      data: {
        installed: true,
        elementName: args.path ? args.path.split('/').pop()?.replace('.md', '') : 'test-element'
      }
    };
  }

  private configurePortfolio(args: any): { success: boolean; data?: any; error?: any } {
    // Actually set the environment variable like the real handler does
    if (args.auto_submit !== undefined) {
      if (args.auto_submit) {
        process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION = 'true';
      } else {
        delete process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION;
      }
    }
    return {
      success: true,
      data: {
        config: {
          autoSubmit: args.auto_submit !== undefined ? args.auto_submit : false,
          autoSync: args.auto_sync !== undefined ? args.auto_sync : true
        }
      }
    };
  }

  private submitContent(args: any): { success: boolean; data?: any; error?: any } {
    // Handle error case for non-existent content
    if (args.content === 'non-existent-skill') {
      return {
        success: false,
        error: { message: 'Content "non-existent-skill" not found in portfolio' }
      };
    }
    // Check if auto-submit is enabled via environment variable
    const autoSubmitEnabled = process.env.DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION === 'true';
    return {
      success: true,
      data: {
        portfolioSubmitted: true,
        collectionIssueCreated: autoSubmitEnabled,
        ...(autoSubmitEnabled && { issueUrl: 'https://github.com/DollhouseMCP/collection/issues/123' }),
        ...(!autoSubmitEnabled && { manualSubmissionUrl: 'https://github.com/test/repo/issues/new' })
      }
    };
  }

  /**
   * Initialize the server and load personas
   */
  async initialize(): Promise<void> {
    await this.portfolioManager.initialize();
    await this.personaManager.initialize();
  }
  
  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    // Dispose PersonaManager to stop file watchers and prevent open handles
    await this.personaManager.dispose();

    // Clear caches and trackers
    this.apiCache.clear();
    this.rateLimitTracker.clear();
  }
}
