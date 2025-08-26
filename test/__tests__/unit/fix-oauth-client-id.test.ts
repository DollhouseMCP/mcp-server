/**
 * Test to verify GitHub OAuth Client ID configuration shows correctly
 * This test ensures that the default OAuth client ID is properly recognized
 * and reported by the configure_oauth tool
 */

import { jest } from '@jest/globals';

describe('OAuth Client ID Configuration Fix', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should recognize and display the default OAuth client ID', async () => {
    // Mock the modules we need
    const mockConfigManager = {
      getInstance: jest.fn().mockReturnValue({
        loadConfig: jest.fn().mockResolvedValue(undefined),
        getGitHubClientId: jest.fn().mockReturnValue(null) // No custom config
      })
    };

    const mockGitHubAuthManager = {
      getClientId: jest.fn().mockResolvedValue('Ov23li9gyNZP6m9aJ2EP') // Returns default
    };

    // Mock the modules
    jest.unstable_mockModule('../../../src/config/ConfigManager.js', () => ({
      ConfigManager: mockConfigManager
    }));

    jest.unstable_mockModule('../../../src/auth/GitHubAuthManager.js', () => ({
      GitHubAuthManager: mockGitHubAuthManager
    }));

    // Import the server class
    const { DollhouseMCPServer } = await import('../../../src/index.js');

    // Create a minimal server instance
    const server = new DollhouseMCPServer();

    // Call configureOAuth without parameters to check status
    const result = await server.configureOAuth();

    // Verify it shows the OAuth is configured (using default)
    expect(result.content[0].text).toContain('✅ **GitHub OAuth Configuration**');
    expect(result.content[0].text).toContain('Using Default');
    expect(result.content[0].text).toContain('Built-in DollhouseMCP OAuth App');
    expect(result.content[0].text).toContain('Ov23li9gyN...'); // Masked client ID
    expect(result.content[0].text).not.toContain('⚠️ **GitHub OAuth Not Configured**');
  });

  it('should show custom configuration when a client ID is configured', async () => {
    // Mock with a custom client ID configured
    const mockConfigManager = {
      getInstance: jest.fn().mockReturnValue({
        loadConfig: jest.fn().mockResolvedValue(undefined),
        getGitHubClientId: jest.fn().mockReturnValue('Ov23liCUSTOMCLIENTID123') // Custom config exists
      })
    };

    const mockGitHubAuthManager = {
      getClientId: jest.fn().mockResolvedValue('Ov23liCUSTOMCLIENTID123') // Returns custom
    };

    // Mock the modules
    jest.unstable_mockModule('../../../src/config/ConfigManager.js', () => ({
      ConfigManager: mockConfigManager
    }));

    jest.unstable_mockModule('../../../src/auth/GitHubAuthManager.js', () => ({
      GitHubAuthManager: mockGitHubAuthManager
    }));

    // Import the server class
    const { DollhouseMCPServer } = await import('../../../src/index.js');

    // Create a minimal server instance
    const server = new DollhouseMCPServer();

    // Call configureOAuth without parameters to check status
    const result = await server.configureOAuth();

    // Verify it shows custom configuration
    expect(result.content[0].text).toContain('✅ **GitHub OAuth Configuration**');
    expect(result.content[0].text).toContain('Configured');
    expect(result.content[0].text).toContain('Custom Configuration');
    expect(result.content[0].text).not.toContain('Using Default');
    expect(result.content[0].text).not.toContain('Built-in DollhouseMCP OAuth App');
  });
});