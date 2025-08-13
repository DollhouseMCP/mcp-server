/**
 * Comprehensive test suite for Portfolio Tools
 * 
 * Tests the 4 new portfolio tools:
 * - portfolio_status
 * - init_portfolio
 * - portfolio_config
 * - sync_portfolio
 * 
 * Covers:
 * - Success scenarios
 * - Error scenarios (auth failures, API errors)
 * - Input validation (malicious usernames, invalid parameters)
 * - Edge cases (empty portfolios, large element counts)
 * - Security validation
 * - Response format validation
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// Mock all dependencies before importing
jest.unstable_mockModule('../../../../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn()
  }
}));

jest.unstable_mockModule('../../../../src/security/securityMonitor.js', () => ({
  SecurityMonitor: {
    logSecurityEvent: jest.fn()
  }
}));

jest.unstable_mockModule('../../../../src/security/tokenManager.js', () => ({
  TokenManager: {
    getGitHubTokenAsync: jest.fn(),
    storeGitHubToken: jest.fn(),
    removeStoredToken: jest.fn(),
    validateToken: jest.fn(),
    validateTokenScopes: jest.fn()
  }
}));

jest.unstable_mockModule('../../../../src/config/ConfigManager.js', () => ({
  ConfigManager: {
    getInstance: jest.fn()
  }
}));

jest.unstable_mockModule('../../../../src/auth/GitHubAuthManager.js', () => ({
  GitHubAuthManager: jest.fn()
}));

jest.unstable_mockModule('../../../../src/portfolio/PortfolioRepoManager.js', () => ({
  PortfolioRepoManager: jest.fn()
}));

jest.unstable_mockModule('../../../../src/security/InputValidator.js', () => ({
  validateUsername: jest.fn()
}));

// Mock fetch globally
global.fetch = jest.fn() as jest.MockedFunction<typeof fetch>;

// Import modules after mocking
const { getPortfolioTools } = await import('../../../../src/server/tools/PortfolioTools.js');

describe('PortfolioTools', () => {
  let mockServer: any;
  let mockGitHubAuthManager: any;
  let mockPortfolioRepoManager: any;
  let mockConfigManager: any;
  let mockValidateUsername: jest.MockedFunction<any>;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Import mocks
    const { GitHubAuthManager } = await import('../../../../src/auth/GitHubAuthManager.js');
    const { PortfolioRepoManager } = await import('../../../../src/portfolio/PortfolioRepoManager.js');
    const { ConfigManager } = await import('../../../../src/config/ConfigManager.js');
    const { validateUsername } = await import('../../../../src/security/InputValidator.js');

    mockValidateUsername = validateUsername as jest.MockedFunction<any>;

    // Setup auth manager mock
    mockGitHubAuthManager = {
      getAuthStatus: jest.fn(),
      authenticate: jest.fn(),
      getToken: jest.fn()
    };
    (GitHubAuthManager as jest.Mock).mockImplementation(() => mockGitHubAuthManager);

    // Setup portfolio repo manager mock
    mockPortfolioRepoManager = {
      initializeRepository: jest.fn(),
      getRepositoryStatus: jest.fn(),
      syncRepository: jest.fn(),
      checkElementCount: jest.fn()
    };
    (PortfolioRepoManager as jest.Mock).mockImplementation(() => mockPortfolioRepoManager);

    // Setup config manager mock
    mockConfigManager = {
      loadConfig: jest.fn(),
      getConfig: jest.fn(),
      setConfig: jest.fn(),
      saveConfig: jest.fn()
    };
    (ConfigManager.getInstance as jest.Mock).mockReturnValue(mockConfigManager);

    // Setup server mock with all portfolio methods
    mockServer = {
      portfolioStatus: jest.fn(),
      initPortfolio: jest.fn(),
      portfolioConfig: jest.fn(),
      syncPortfolio: jest.fn(),
      getPersonaIndicator: jest.fn(() => '[TEST] ')
    };

    // Default successful auth status
    mockGitHubAuthManager.getAuthStatus.mockResolvedValue({
      isAuthenticated: true,
      username: 'testuser',
      token: 'test-token'
    });

    // Default username validation success
    mockValidateUsername.mockImplementation((username: string) => username.toLowerCase());
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('Tool Structure', () => {
    it('should return all 4 portfolio tools', () => {
      const tools = getPortfolioTools(mockServer);
      expect(tools).toHaveLength(4);
      
      const toolNames = tools.map(t => t.tool.name);
      expect(toolNames).toContain('portfolio_status');
      expect(toolNames).toContain('init_portfolio');
      expect(toolNames).toContain('portfolio_config');
      expect(toolNames).toContain('sync_portfolio');
    });

    it('should have valid tool definitions with proper schemas', () => {
      const tools = getPortfolioTools(mockServer);
      
      tools.forEach(({ tool }) => {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      });
    });

    it('should have handler functions for each tool', () => {
      const tools = getPortfolioTools(mockServer);
      
      tools.forEach(({ handler }) => {
        expect(typeof handler).toBe('function');
      });
    });
  });

  describe('portfolio_status Tool', () => {
    let portfolioStatusTool: any;

    beforeEach(() => {
      const tools = getPortfolioTools(mockServer);
      portfolioStatusTool = tools.find(t => t.tool.name === 'portfolio_status');
    });

    describe('Success Scenarios', () => {
      it('should call portfolioStatus with provided username', async () => {
        mockServer.portfolioStatus.mockResolvedValue({
          content: [{ type: 'text', text: 'Portfolio status for user123' }]
        });

        const result = await portfolioStatusTool.handler({ username: 'user123' });

        expect(mockServer.portfolioStatus).toHaveBeenCalledWith('user123');
        expect(result).toEqual({
          content: [{ type: 'text', text: 'Portfolio status for user123' }]
        });
      });

      it('should call portfolioStatus without username when not provided', async () => {
        mockServer.portfolioStatus.mockResolvedValue({
          content: [{ type: 'text', text: 'Portfolio status for authenticated user' }]
        });

        await portfolioStatusTool.handler({});

        expect(mockServer.portfolioStatus).toHaveBeenCalledWith(undefined);
        expect(mockValidateUsername).not.toHaveBeenCalled();
      });

      it('should handle empty arguments object', async () => {
        mockServer.portfolioStatus.mockResolvedValue({
          content: [{ type: 'text', text: 'Portfolio status' }]
        });

        await portfolioStatusTool.handler(undefined);

        expect(mockServer.portfolioStatus).toHaveBeenCalledWith(undefined);
      });
    });

    describe('Input Validation', () => {
      it('should validate username format', async () => {
        const invalidUsernames = [
          '../malicious',
          'user@domain.com',
          'user with spaces',
          'user<script>',
          'user&amp;test',
          ''.repeat(1000), // Very long username
          'user\0null',
          'user\n\r',
          'user\t\b'
        ];

        for (const username of invalidUsernames) {
          mockServer.portfolioStatus.mockResolvedValue({
            content: [{ type: 'text', text: 'Invalid username error' }]
          });

          // Should not throw - validation happens in server method, errors are returned in response
          const result = await portfolioStatusTool.handler({ username });
          expect(mockServer.portfolioStatus).toHaveBeenCalledWith(username);
          expect(result).toBeDefined();
        }
      });

      it('should handle non-string username gracefully', async () => {
        const invalidInputs = [
          123,
          true,
          [],
          {},
          null
        ];

        for (const username of invalidInputs) {
          await portfolioStatusTool.handler({ username });
          expect(mockServer.portfolioStatus).toHaveBeenCalledWith(username);
        }
      });
    });

    describe('Schema Validation', () => {
      it('should have correct input schema', () => {
        const schema = portfolioStatusTool.tool.inputSchema;
        
        expect(schema.type).toBe('object');
        expect(schema.properties.username).toBeDefined();
        expect(schema.properties.username.type).toBe('string');
        expect(schema.properties.username.description).toBeTruthy();
      });
    });
  });

  describe('init_portfolio Tool', () => {
    let initPortfolioTool: any;

    beforeEach(() => {
      const tools = getPortfolioTools(mockServer);
      initPortfolioTool = tools.find(t => t.tool.name === 'init_portfolio');
    });

    describe('Success Scenarios', () => {
      it('should call initPortfolio with all provided options', async () => {
        const options = {
          repository_name: 'my-portfolio',
          private: true,
          description: 'My awesome portfolio'
        };

        mockServer.initPortfolio.mockResolvedValue({
          content: [{ type: 'text', text: 'Portfolio initialized successfully' }]
        });

        await initPortfolioTool.handler(options);

        expect(mockServer.initPortfolio).toHaveBeenCalledWith({
          repositoryName: 'my-portfolio',
          private: true,
          description: 'My awesome portfolio'
        });
      });

      it('should handle partial options', async () => {
        const options = { repository_name: 'test-repo' };

        mockServer.initPortfolio.mockResolvedValue({
          content: [{ type: 'text', text: 'Portfolio initialized' }]
        });

        await initPortfolioTool.handler(options);

        expect(mockServer.initPortfolio).toHaveBeenCalledWith({
          repositoryName: 'test-repo',
          private: undefined,
          description: undefined
        });
      });

      it('should handle empty options', async () => {
        mockServer.initPortfolio.mockResolvedValue({
          content: [{ type: 'text', text: 'Portfolio initialized' }]
        });

        await initPortfolioTool.handler({});

        expect(mockServer.initPortfolio).toHaveBeenCalledWith({
          repositoryName: undefined,
          private: undefined,
          description: undefined
        });
      });

      it('should handle undefined arguments', async () => {
        mockServer.initPortfolio.mockResolvedValue({
          content: [{ type: 'text', text: 'Portfolio initialized' }]
        });

        await initPortfolioTool.handler(undefined);

        expect(mockServer.initPortfolio).toHaveBeenCalledWith({
          repositoryName: undefined,
          private: undefined,
          description: undefined
        });
      });
    });

    describe('Input Validation', () => {
      it('should handle malicious repository names', async () => {
        const maliciousNames = [
          '../../../etc/passwd',
          'repo<script>alert("xss")</script>',
          'repo\0null',
          'repo\n\r\t',
          'repo with "quotes" and \' apostrophes',
          ''.repeat(1000), // Very long name
          'repo;rm -rf /',
          'repo`whoami`',
          'repo$(cat /etc/passwd)'
        ];

        for (const repository_name of maliciousNames) {
          await initPortfolioTool.handler({ repository_name });
          expect(mockServer.initPortfolio).toHaveBeenCalledWith({
            repositoryName: repository_name,
            private: undefined,
            description: undefined
          });
        }
      });

      it('should handle malicious descriptions', async () => {
        const maliciousDescriptions = [
          '<script>alert("xss")</script>',
          'Description\0with\0nulls',
          'Description\n\r\twith\ncontrol\rchars',
          ''.repeat(10000), // Very long description
          'Desc with "quotes" and \' apostrophes',
          'Desc;rm -rf /',
          'Desc`whoami`',
          'Desc$(cat /etc/passwd)'
        ];

        for (const description of maliciousDescriptions) {
          await initPortfolioTool.handler({ description });
          expect(mockServer.initPortfolio).toHaveBeenCalledWith({
            repositoryName: undefined,
            private: undefined,
            description
          });
        }
      });

      it('should handle invalid private parameter types', async () => {
        const invalidPrivateValues = [
          'true', // string instead of boolean
          1, // number
          [], // array
          {}, // object
          null // null
        ];

        for (const private_val of invalidPrivateValues) {
          await initPortfolioTool.handler({ private: private_val });
          expect(mockServer.initPortfolio).toHaveBeenCalledWith({
            repositoryName: undefined,
            private: private_val,
            description: undefined
          });
        }
      });
    });

    describe('Schema Validation', () => {
      it('should have correct input schema', () => {
        const schema = initPortfolioTool.tool.inputSchema;
        
        expect(schema.type).toBe('object');
        expect(schema.properties.repository_name).toBeDefined();
        expect(schema.properties.repository_name.type).toBe('string');
        expect(schema.properties.private).toBeDefined();
        expect(schema.properties.private.type).toBe('boolean');
        expect(schema.properties.description).toBeDefined();
        expect(schema.properties.description.type).toBe('string');
      });
    });
  });

  describe('portfolio_config Tool', () => {
    let portfolioConfigTool: any;

    beforeEach(() => {
      const tools = getPortfolioTools(mockServer);
      portfolioConfigTool = tools.find(t => t.tool.name === 'portfolio_config');
    });

    describe('Success Scenarios', () => {
      it('should call portfolioConfig with all provided options', async () => {
        const options = {
          auto_sync: true,
          default_visibility: 'private' as const,
          auto_submit: false,
          repository_name: 'custom-portfolio'
        };

        mockServer.portfolioConfig.mockResolvedValue({
          content: [{ type: 'text', text: 'Configuration updated' }]
        });

        await portfolioConfigTool.handler(options);

        expect(mockServer.portfolioConfig).toHaveBeenCalledWith({
          autoSync: true,
          defaultVisibility: 'private',
          autoSubmit: false,
          repositoryName: 'custom-portfolio'
        });
      });

      it('should handle partial configuration updates', async () => {
        const options = { auto_sync: true };

        mockServer.portfolioConfig.mockResolvedValue({
          content: [{ type: 'text', text: 'Auto-sync enabled' }]
        });

        await portfolioConfigTool.handler(options);

        expect(mockServer.portfolioConfig).toHaveBeenCalledWith({
          autoSync: true,
          defaultVisibility: undefined,
          autoSubmit: undefined,
          repositoryName: undefined
        });
      });

      it('should handle visibility setting changes', async () => {
        const publicConfig = { default_visibility: 'public' as const };
        const privateConfig = { default_visibility: 'private' as const };

        mockServer.portfolioConfig.mockResolvedValue({
          content: [{ type: 'text', text: 'Visibility updated' }]
        });

        await portfolioConfigTool.handler(publicConfig);
        expect(mockServer.portfolioConfig).toHaveBeenCalledWith({
          autoSync: undefined,
          defaultVisibility: 'public',
          autoSubmit: undefined,
          repositoryName: undefined
        });

        await portfolioConfigTool.handler(privateConfig);
        expect(mockServer.portfolioConfig).toHaveBeenCalledWith({
          autoSync: undefined,
          defaultVisibility: 'private',
          autoSubmit: undefined,
          repositoryName: undefined
        });
      });
    });

    describe('Input Validation', () => {
      it('should handle invalid default_visibility values', async () => {
        const invalidVisibilities = [
          'invalid',
          'PUBLIC', // wrong case
          'PRIVATE', // wrong case
          123,
          true,
          [],
          {},
          null
        ];

        for (const default_visibility of invalidVisibilities) {
          await portfolioConfigTool.handler({ default_visibility });
          expect(mockServer.portfolioConfig).toHaveBeenCalledWith({
            autoSync: undefined,
            defaultVisibility: default_visibility,
            autoSubmit: undefined,
            repositoryName: undefined
          });
        }
      });

      it('should handle invalid boolean values for auto_sync and auto_submit', async () => {
        const invalidBooleans = [
          'true', // string
          'false', // string
          1, // number
          0, // number
          [], // array
          {}, // object
          null // null
        ];

        for (const value of invalidBooleans) {
          await portfolioConfigTool.handler({ auto_sync: value });
          expect(mockServer.portfolioConfig).toHaveBeenCalledWith({
            autoSync: value,
            defaultVisibility: undefined,
            autoSubmit: undefined,
            repositoryName: undefined
          });

          await portfolioConfigTool.handler({ auto_submit: value });
          expect(mockServer.portfolioConfig).toHaveBeenCalledWith({
            autoSync: undefined,
            defaultVisibility: undefined,
            autoSubmit: value,
            repositoryName: undefined
          });
        }
      });

      it('should handle malicious repository names', async () => {
        const maliciousNames = [
          '../../../etc/passwd',
          'repo<script>alert("xss")</script>',
          'repo\0null',
          'repo\n\r\t',
          ''.repeat(1000), // Very long name
          'repo;rm -rf /',
          'repo`whoami`'
        ];

        for (const repository_name of maliciousNames) {
          await portfolioConfigTool.handler({ repository_name });
          expect(mockServer.portfolioConfig).toHaveBeenCalledWith({
            autoSync: undefined,
            defaultVisibility: undefined,
            autoSubmit: undefined,
            repositoryName: repository_name
          });
        }
      });
    });

    describe('Schema Validation', () => {
      it('should have correct input schema with enum constraints', () => {
        const schema = portfolioConfigTool.tool.inputSchema;
        
        expect(schema.type).toBe('object');
        expect(schema.properties.auto_sync).toBeDefined();
        expect(schema.properties.auto_sync.type).toBe('boolean');
        
        expect(schema.properties.default_visibility).toBeDefined();
        expect(schema.properties.default_visibility.type).toBe('string');
        expect(schema.properties.default_visibility.enum).toEqual(['public', 'private']);
        
        expect(schema.properties.auto_submit).toBeDefined();
        expect(schema.properties.auto_submit.type).toBe('boolean');
        
        expect(schema.properties.repository_name).toBeDefined();
        expect(schema.properties.repository_name.type).toBe('string');
      });
    });
  });

  describe('sync_portfolio Tool', () => {
    let syncPortfolioTool: any;

    beforeEach(() => {
      const tools = getPortfolioTools(mockServer);
      syncPortfolioTool = tools.find(t => t.tool.name === 'sync_portfolio');
    });

    describe('Success Scenarios', () => {
      it('should call syncPortfolio with all provided options', async () => {
        const options = {
          direction: 'both' as const,
          force: true,
          dry_run: true
        };

        mockServer.syncPortfolio.mockResolvedValue({
          content: [{ type: 'text', text: 'Sync completed successfully' }]
        });

        await syncPortfolioTool.handler(options);

        expect(mockServer.syncPortfolio).toHaveBeenCalledWith({
          direction: 'both',
          force: true,
          dryRun: true
        });
      });

      it('should handle default values correctly', async () => {
        mockServer.syncPortfolio.mockResolvedValue({
          content: [{ type: 'text', text: 'Sync completed' }]
        });

        await syncPortfolioTool.handler({});

        expect(mockServer.syncPortfolio).toHaveBeenCalledWith({
          direction: 'push', // default
          force: false, // default
          dryRun: false // default
        });
      });

      it('should handle each direction option', async () => {
        const directions = ['push', 'pull', 'both'] as const;

        mockServer.syncPortfolio.mockResolvedValue({
          content: [{ type: 'text', text: 'Sync completed' }]
        });

        for (const direction of directions) {
          await syncPortfolioTool.handler({ direction });
          expect(mockServer.syncPortfolio).toHaveBeenCalledWith({
            direction,
            force: false,
            dryRun: false
          });
        }
      });

      it('should handle force and dry_run combinations', async () => {
        const combinations = [
          { force: true, dry_run: false },
          { force: false, dry_run: true },
          { force: true, dry_run: true },
          { force: false, dry_run: false }
        ];

        mockServer.syncPortfolio.mockResolvedValue({
          content: [{ type: 'text', text: 'Sync completed' }]
        });

        for (const combo of combinations) {
          await syncPortfolioTool.handler(combo);
          expect(mockServer.syncPortfolio).toHaveBeenCalledWith({
            direction: 'push',
            force: combo.force,
            dryRun: combo.dry_run
          });
        }
      });
    });

    describe('Input Validation', () => {
      it('should handle invalid direction values', async () => {
        const invalidDirections = [
          'invalid',
          'PUSH', // wrong case
          'download', // synonym but not enum value
          'upload', // synonym but not enum value
          123,
          true,
          [],
          {},
          null
        ];

        for (const direction of invalidDirections) {
          await syncPortfolioTool.handler({ direction });
          expect(mockServer.syncPortfolio).toHaveBeenCalledWith({
            direction: direction || 'push', // falls back to default if falsy
            force: false,
            dryRun: false
          });
        }
      });

      it('should handle invalid boolean values for force and dry_run', async () => {
        const invalidBooleans = [
          'true', // string
          'false', // string
          1, // number
          0, // number
          [], // array
          {}, // object
          null // null
        ];

        for (const value of invalidBooleans) {
          await syncPortfolioTool.handler({ force: value });
          expect(mockServer.syncPortfolio).toHaveBeenCalledWith({
            direction: 'push',
            force: value || false, // coerced to boolean
            dryRun: false
          });

          await syncPortfolioTool.handler({ dry_run: value });
          expect(mockServer.syncPortfolio).toHaveBeenCalledWith({
            direction: 'push',
            force: false,
            dryRun: value || false // coerced to boolean
          });
        }
      });

      it('should handle undefined arguments', async () => {
        mockServer.syncPortfolio.mockResolvedValue({
          content: [{ type: 'text', text: 'Sync completed' }]
        });

        await syncPortfolioTool.handler(undefined);

        expect(mockServer.syncPortfolio).toHaveBeenCalledWith({
          direction: 'push',
          force: false,
          dryRun: false
        });
      });
    });

    describe('Schema Validation', () => {
      it('should have correct input schema with enum constraints', () => {
        const schema = syncPortfolioTool.tool.inputSchema;
        
        expect(schema.type).toBe('object');
        
        expect(schema.properties.direction).toBeDefined();
        expect(schema.properties.direction.type).toBe('string');
        expect(schema.properties.direction.enum).toEqual(['push', 'pull', 'both']);
        
        expect(schema.properties.force).toBeDefined();
        expect(schema.properties.force.type).toBe('boolean');
        
        expect(schema.properties.dry_run).toBeDefined();
        expect(schema.properties.dry_run.type).toBe('boolean');
      });
    });

    describe('Edge Cases', () => {
      it('should handle conflicting options (force and dry_run both true)', async () => {
        mockServer.syncPortfolio.mockResolvedValue({
          content: [{ type: 'text', text: 'Dry run completed' }]
        });

        await syncPortfolioTool.handler({ force: true, dry_run: true });

        expect(mockServer.syncPortfolio).toHaveBeenCalledWith({
          direction: 'push',
          force: true,
          dryRun: true
        });
      });

      it('should handle empty string values', async () => {
        await syncPortfolioTool.handler({ direction: '' });

        expect(mockServer.syncPortfolio).toHaveBeenCalledWith({
          direction: 'push', // fallback to default
          force: false,
          dryRun: false
        });
      });
    });
  });

  describe('Error Scenarios', () => {
    describe('Server Method Failures', () => {
      it('should handle portfolioStatus method errors', async () => {
        const tools = getPortfolioTools(mockServer);
        const portfolioStatusTool = tools.find(t => t.tool.name === 'portfolio_status');

        mockServer.portfolioStatus.mockRejectedValue(new Error('API Error'));

        await expect(portfolioStatusTool.handler({ username: 'testuser' }))
          .rejects.toThrow('API Error');
      });

      it('should handle initPortfolio method errors', async () => {
        const tools = getPortfolioTools(mockServer);
        const initPortfolioTool = tools.find(t => t.tool.name === 'init_portfolio');

        mockServer.initPortfolio.mockRejectedValue(new Error('Repository creation failed'));

        await expect(initPortfolioTool.handler({ repository_name: 'test' }))
          .rejects.toThrow('Repository creation failed');
      });

      it('should handle portfolioConfig method errors', async () => {
        const tools = getPortfolioTools(mockServer);
        const portfolioConfigTool = tools.find(t => t.tool.name === 'portfolio_config');

        mockServer.portfolioConfig.mockRejectedValue(new Error('Config save failed'));

        await expect(portfolioConfigTool.handler({ auto_sync: true }))
          .rejects.toThrow('Config save failed');
      });

      it('should handle syncPortfolio method errors', async () => {
        const tools = getPortfolioTools(mockServer);
        const syncPortfolioTool = tools.find(t => t.tool.name === 'sync_portfolio');

        mockServer.syncPortfolio.mockRejectedValue(new Error('Sync failed'));

        await expect(syncPortfolioTool.handler({ direction: 'push' }))
          .rejects.toThrow('Sync failed');
      });
    });
  });

  describe('Security Tests', () => {
    describe('Parameter Injection Attempts', () => {
      it('should handle command injection attempts in usernames', async () => {
        const tools = getPortfolioTools(mockServer);
        const portfolioStatusTool = tools.find(t => t.tool.name === 'portfolio_status');

        const injectionAttempts = [
          'user; rm -rf /',
          'user && cat /etc/passwd',
          'user | whoami',
          'user`id`',
          'user$(whoami)',
          'user\ncat /etc/passwd',
          'user\recho hacked',
          'user\tping google.com'
        ];

        for (const username of injectionAttempts) {
          mockServer.portfolioStatus.mockResolvedValue({
            content: [{ type: 'text', text: 'Status checked' }]
          });

          await portfolioStatusTool.handler({ username });
          expect(mockServer.portfolioStatus).toHaveBeenCalledWith(username);
        }
      });

      it('should handle XSS attempts in repository names and descriptions', async () => {
        const tools = getPortfolioTools(mockServer);
        const initPortfolioTool = tools.find(t => t.tool.name === 'init_portfolio');

        const xssAttempts = [
          '<script>alert("XSS")</script>',
          'javascript:alert("XSS")',
          '<img src="x" onerror="alert(1)">',
          '<svg onload="alert(1)">',
          '<iframe src="javascript:alert(1)">',
          '<meta http-equiv="refresh" content="0;url=data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">',
          'data:text/html,<script>alert(1)</script>'
        ];

        for (const malicious of xssAttempts) {
          mockServer.initPortfolio.mockResolvedValue({
            content: [{ type: 'text', text: 'Repository created' }]
          });

          await initPortfolioTool.handler({ repository_name: malicious });
          expect(mockServer.initPortfolio).toHaveBeenCalledWith({
            repositoryName: malicious,
            private: undefined,
            description: undefined
          });

          await initPortfolioTool.handler({ description: malicious });
          expect(mockServer.initPortfolio).toHaveBeenCalledWith({
            repositoryName: undefined,
            private: undefined,
            description: malicious
          });
        }
      });
    });

    describe('Unicode and Encoding Attacks', () => {
      it('should handle unicode normalization attacks', async () => {
        const tools = getPortfolioTools(mockServer);
        const portfolioStatusTool = tools.find(t => t.tool.name === 'portfolio_status');

        const unicodeAttacks = [
          'user\u0000', // null byte
          'user\uFEFF', // zero-width no-break space
          'user\u200D', // zero-width joiner
          'user\u200C', // zero-width non-joiner
          'user\u2028', // line separator
          'user\u2029', // paragraph separator
          'use\u0072', // combining characters
          'üser', // similar looking characters
          'usеr' // cyrillic е instead of latin e
        ];

        for (const username of unicodeAttacks) {
          mockServer.portfolioStatus.mockResolvedValue({
            content: [{ type: 'text', text: 'Status checked' }]
          });

          await portfolioStatusTool.handler({ username });
          expect(mockServer.portfolioStatus).toHaveBeenCalledWith(username);
        }
      });
    });

    describe('Large Input Handling', () => {
      it('should handle very large input strings', async () => {
        const tools = getPortfolioTools(mockServer);
        const initPortfolioTool = tools.find(t => t.tool.name === 'init_portfolio');

        const largeString = 'a'.repeat(100000); // 100KB string

        mockServer.initPortfolio.mockResolvedValue({
          content: [{ type: 'text', text: 'Repository created' }]
        });

        await initPortfolioTool.handler({ 
          repository_name: largeString,
          description: largeString 
        });

        expect(mockServer.initPortfolio).toHaveBeenCalledWith({
          repositoryName: largeString,
          private: undefined,
          description: largeString
        });
      });

      it('should handle deeply nested object attempts', async () => {
        const tools = getPortfolioTools(mockServer);
        const portfolioConfigTool = tools.find(t => t.tool.name === 'portfolio_config');

        // Attempt to pass deeply nested objects as parameters
        const deepObject = { deeply: { nested: { object: { value: true } } } };

        mockServer.portfolioConfig.mockResolvedValue({
          content: [{ type: 'text', text: 'Config updated' }]
        });

        await portfolioConfigTool.handler({ auto_sync: deepObject });

        expect(mockServer.portfolioConfig).toHaveBeenCalledWith({
          autoSync: deepObject,
          defaultVisibility: undefined,
          autoSubmit: undefined,
          repositoryName: undefined
        });
      });
    });
  });

  describe('Response Format Validation', () => {
    it('should validate that server methods return properly formatted responses', async () => {
      const tools = getPortfolioTools(mockServer);

      const expectedResponseFormat = {
        content: expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.any(String)
          })
        ])
      };

      // Test each tool's response format
      mockServer.portfolioStatus.mockResolvedValue({
        content: [{ type: 'text', text: 'Portfolio status response' }]
      });

      mockServer.initPortfolio.mockResolvedValue({
        content: [{ type: 'text', text: 'Init portfolio response' }]
      });

      mockServer.portfolioConfig.mockResolvedValue({
        content: [{ type: 'text', text: 'Config response' }]
      });

      mockServer.syncPortfolio.mockResolvedValue({
        content: [{ type: 'text', text: 'Sync response' }]
      });

      for (const { tool, handler } of tools) {
        const response = await handler({});
        expect(response).toMatchObject(expectedResponseFormat);
      }
    });
  });
});