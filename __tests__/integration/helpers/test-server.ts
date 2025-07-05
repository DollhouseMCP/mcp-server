/**
 * Test helper for integration tests
 */

import { PersonaManager } from '../../../src/persona/PersonaManager.js';
import { GitHubClient } from '../../../src/marketplace/GitHubClient.js';
import { APICache } from '../../../src/cache/APICache.js';
import { DEFAULT_INDICATOR_CONFIG } from '../../../src/config/indicator-config.js';

export interface TestServerOptions {
  personasDir?: string;
  mockGitHub?: boolean;
}

export class TestServer {
  public personaManager: PersonaManager;
  public githubClient: GitHubClient;
  public apiCache: APICache;
  public rateLimitTracker: Map<string, number[]>;
  
  constructor(options: TestServerOptions = {}) {
    const personasDir = options.personasDir || process.env.TEST_PERSONAS_DIR!;
    
    // Create core components
    this.personaManager = new PersonaManager(personasDir, DEFAULT_INDICATOR_CONFIG);
    this.apiCache = new APICache();
    this.rateLimitTracker = new Map<string, number[]>();
    
    // Create GitHub client
    this.githubClient = new GitHubClient(this.apiCache, this.rateLimitTracker);
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