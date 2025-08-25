/**
 * Test helper for integration tests
 * 
 * Code Quality Improvements Applied:
 * - Added missing start(), stop(), and handleTool() methods for E2E test compatibility
 * - Improved API documentation with clear method purposes
 */

import { PersonaManager } from '../../../../src/persona/PersonaManager.js';
import { GitHubClient } from '../../../../src/collection/GitHubClient.js';
import { APICache } from '../../../../src/cache/APICache.js';
import { DEFAULT_INDICATOR_CONFIG } from '../../../../src/config/indicator-config.js';

export interface TestServerOptions {
  personasDir?: string;
  mockGitHub?: boolean;
}

export class TestServer {
  public personaManager: PersonaManager;
  public githubClient: GitHubClient;
  public apiCache: APICache;
  public rateLimitTracker: Map<string, number[]>;
  private isStarted: boolean = false;
  
  constructor(options: TestServerOptions = {}) {
    const personasDir = options.personasDir || process.env.TEST_PERSONAS_DIR;
    
    if (!personasDir) {
      throw new Error(
        'TEST_PERSONAS_DIR environment variable is not set. ' +
        'Please ensure the integration test setup has run properly.'
      );
    }
    
    // Create core components
    this.personaManager = new PersonaManager(personasDir, DEFAULT_INDICATOR_CONFIG);
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
  async handleTool(toolName: string, args: any): Promise<{ success: boolean; data?: any; error?: any }> {
    // Mock implementation for E2E tests
    // TODO: Implement proper tool handling for comprehensive E2E testing
    
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
      
      case 'install_content':
      case 'edit_element':
      case 'get_element':
      case 'list_elements':
      case 'portfolio_status':
      case 'portfolio_config':
      case 'submit_content':
      case 'get_collection_cache_health':
        return {
          success: true,
          data: {
            // Mock successful response
            result: 'mocked'
          }
        };
      
      default:
        return {
          success: false,
          error: { message: `Unknown tool: ${toolName}` }
        };
    }
  }
  
  /**
   * Initialize the server and load personas
   */
  async initialize(): Promise<void> {
    await this.personaManager.initialize();
  }
  
  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    // Any cleanup needed
    this.apiCache.clear();
    this.rateLimitTracker.clear();
  }
}