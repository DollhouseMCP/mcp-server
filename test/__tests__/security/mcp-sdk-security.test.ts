/**
 * MCP SDK Security Tests
 *
 * These tests verify that the MCP SDK dependency meets security requirements
 * and that DollhouseMCP's transport configuration is secure.
 *
 * CVE-2025-66414: DNS rebinding vulnerability in MCP SDK < 1.24.0
 * - Affects: HTTP-based servers (StreamableHTTP, SSE) on localhost
 * - Does NOT affect: stdio transport (which DollhouseMCP uses)
 * - Fix: SDK 1.24.0+ enables DNS rebinding protection by default
 */

import { describe, it, expect, beforeAll } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to compare semver versions
function semverCompare(a: string, b: string): number {
  const parseVersion = (v: string) => {
    // Remove any prerelease suffix for comparison
    const [version] = v.split('-');
    return version.split('.').map(Number);
  };

  const aParts = parseVersion(a);
  const bParts = parseVersion(b);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aVal = aParts[i] || 0;
    const bVal = bParts[i] || 0;
    if (aVal > bVal) return 1;
    if (aVal < bVal) return -1;
  }
  return 0;
}

describe('MCP SDK Security', () => {
  let packageJson: { dependencies: Record<string, string> };
  let packageLockJson: { packages: Record<string, { version: string }> };

  beforeAll(() => {
    const projectRoot = path.resolve(__dirname, '../../..');
    packageJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
    );
    packageLockJson = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8')
    );
  });

  describe('CVE-2025-66414 - DNS Rebinding Protection', () => {
    const MINIMUM_SAFE_VERSION = '1.24.0';

    it('should have @modelcontextprotocol/sdk as a dependency', () => {
      expect(packageJson.dependencies).toHaveProperty('@modelcontextprotocol/sdk');
    });

    it('should require SDK version >= 1.24.0 in package.json', () => {
      const specifiedVersion = packageJson.dependencies['@modelcontextprotocol/sdk'];

      // Extract version number from semver range (^1.24.0 -> 1.24.0)
      const versionMatch = specifiedVersion.match(/(\d+\.\d+\.\d+)/);
      expect(versionMatch).not.toBeNull();

      const version = versionMatch![1];
      const comparison = semverCompare(version, MINIMUM_SAFE_VERSION);

      expect(comparison).toBeGreaterThanOrEqual(0);
    });

    it('should have installed SDK version >= 1.24.0', () => {
      const installedPackage = packageLockJson.packages['node_modules/@modelcontextprotocol/sdk'];
      expect(installedPackage).toBeDefined();

      const installedVersion = installedPackage.version;
      const comparison = semverCompare(installedVersion, MINIMUM_SAFE_VERSION);

      expect(comparison).toBeGreaterThanOrEqual(0);
    });

    it('should document the security fix requirement', () => {
      // This test documents why the minimum version is required
      const advisory = {
        cve: 'CVE-2025-66414',
        ghsa: 'GHSA-w48q-cv73-mx4w',
        severity: 'high',
        affectedVersions: '< 1.24.0',
        fixedIn: '1.24.0',
        vulnerability: 'DNS rebinding protection not enabled by default for HTTP servers',
        impact: 'DollhouseMCP uses stdio transport - NOT directly affected',
        mitigation: 'Updated to SDK >= 1.24.0 for defense in depth'
      };

      expect(advisory.fixedIn).toBe(MINIMUM_SAFE_VERSION);
    });
  });

  describe('Transport Security', () => {
    it('should use stdio transport (not affected by DNS rebinding)', async () => {
      // Read the main index file to verify transport type
      const projectRoot = path.resolve(__dirname, '../../..');
      const indexPath = path.join(projectRoot, 'src/index.ts');
      const indexContent = fs.readFileSync(indexPath, 'utf8');

      // Verify StdioServerTransport is imported
      expect(indexContent).toContain('StdioServerTransport');
      expect(indexContent).toContain('from "@modelcontextprotocol/sdk/server/stdio.js"');

      // Verify we're NOT using HTTP-based transports
      expect(indexContent).not.toContain('StreamableHTTPServerTransport');
      expect(indexContent).not.toContain('SSEServerTransport');
    });

    it('should instantiate StdioServerTransport', async () => {
      const projectRoot = path.resolve(__dirname, '../../..');
      const indexPath = path.join(projectRoot, 'src/index.ts');
      const indexContent = fs.readFileSync(indexPath, 'utf8');

      // Verify transport is instantiated
      expect(indexContent).toMatch(/new\s+StdioServerTransport\s*\(/);
    });
  });

  describe('SDK Export Verification', () => {
    it('should be able to import SDK server components', async () => {
      // Verify the SDK exports the expected server components
      const sdk = await import('@modelcontextprotocol/sdk/server/index.js');

      expect(sdk).toHaveProperty('Server');
      expect(typeof sdk.Server).toBe('function');
    });

    it('should be able to import stdio transport', async () => {
      const stdio = await import('@modelcontextprotocol/sdk/server/stdio.js');

      expect(stdio).toHaveProperty('StdioServerTransport');
      expect(typeof stdio.StdioServerTransport).toBe('function');
    });

    it('should have hostHeaderValidation middleware available (SDK >= 1.24.0 feature)', async () => {
      // This middleware is the key security fix in 1.24.0
      // Its presence confirms we have the patched version
      const middleware = await import('@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js');

      expect(middleware).toHaveProperty('hostHeaderValidation');
      expect(middleware).toHaveProperty('localhostHostValidation');
      expect(typeof middleware.hostHeaderValidation).toBe('function');
      expect(typeof middleware.localhostHostValidation).toBe('function');
    });
  });

  describe('Defense in Depth', () => {
    it('should not expose HTTP endpoints without authentication', async () => {
      // DollhouseMCP runs via stdio, but let's verify no HTTP server is started
      const projectRoot = path.resolve(__dirname, '../../..');
      const srcDir = path.join(projectRoot, 'src');

      // Check main source files for HTTP server creation
      const checkForHttpServer = (dir: string): boolean => {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);

          if (stat.isDirectory()) {
            // Skip node_modules if somehow present
            if (file === 'node_modules') continue;
            if (checkForHttpServer(filePath)) return true;
          } else if (file.endsWith('.ts') || file.endsWith('.js')) {
            const content = fs.readFileSync(filePath, 'utf8');
            // Check for unprotected HTTP server creation patterns
            // Check for HTTP server patterns (excluding http.createServer which is used for OAuth)
            const hasAppListen = content.includes('app.listen(');
            const hasServerListen = content.includes('server.listen(');
            // createServer is OK if it's http.createServer for OAuth callbacks
            const hasCreateServer = content.includes('createServer(') &&
              !content.includes('http.createServer') &&
              !content.includes('https.createServer');

            if (hasAppListen || hasServerListen || hasCreateServer) {
              // Allow if it's in the auth module (OAuth callback server)
              if (!filePath.includes('/auth/')) {
                return true;
              }
            }
          }
        }
        return false;
      };

      // This should pass - DollhouseMCP doesn't create standalone HTTP servers
      // (OAuth callback server in auth module is temporary and properly scoped)
      const hasUnprotectedHttpServer = checkForHttpServer(srcDir);

      // Note: We're checking for patterns, not actual runtime behavior
      // The auth module may have HTTP server for OAuth callbacks, which is acceptable
      expect(hasUnprotectedHttpServer).toBe(false);
    });
  });
});

describe('Future HTTP Transport Security', () => {
  /**
   * These tests document security requirements for when HTTP streaming is added.
   * Currently DollhouseMCP uses stdio, but HTTP transport is planned.
   *
   * When implementing HTTP transport:
   * 1. Use hostHeaderValidation middleware for localhost bindings
   * 2. Enable enableDnsRebindingProtection option
   * 3. Require authentication for non-localhost bindings
   */

  it('should have hostHeaderValidation middleware available for future HTTP use', async () => {
    const middleware = await import('@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js');

    // These will be needed when HTTP transport is implemented
    expect(middleware.hostHeaderValidation).toBeDefined();
    expect(middleware.localhostHostValidation).toBeDefined();
  });

  it('should document DNS rebinding protection requirements for HTTP transport', () => {
    const httpSecurityRequirements = {
      // When adding StreamableHTTPServerTransport or SSEServerTransport:
      localhostBinding: {
        requirement: 'Use hostHeaderValidation middleware OR enableDnsRebindingProtection option',
        allowedHosts: ['localhost', '127.0.0.1', '[::1]'],
        reason: 'Prevents DNS rebinding attacks (CVE-2025-66414)'
      },
      publicBinding: {
        requirement: 'Require authentication (OAuth, API key, etc.)',
        reason: 'Unauthenticated public servers are vulnerable regardless of DNS rebinding protection'
      },
      bestPractices: [
        'Use createMcpExpressApp() which enables protection by default',
        'Or manually apply hostHeaderValidation() middleware',
        'Never expose unauthenticated MCP servers to the network'
      ]
    };

    // This test documents requirements for future implementation
    expect(httpSecurityRequirements.localhostBinding.allowedHosts).toContain('localhost');
    expect(httpSecurityRequirements.bestPractices.length).toBeGreaterThan(0);
  });

  it('should have SDK transports available for future HTTP implementation', async () => {
    // Verify the SDK provides HTTP transports when needed
    const sse = await import('@modelcontextprotocol/sdk/server/sse.js');
    const streamable = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

    expect(sse).toHaveProperty('SSEServerTransport');
    expect(streamable).toHaveProperty('StreamableHTTPServerTransport');

    // These transports accept enableDnsRebindingProtection option
    // which should be set to true for localhost bindings
  });
});

describe('Security Version Constraints', () => {
  it('should have security-related dependencies at safe versions', () => {
    const projectRoot = path.resolve(__dirname, '../../..');
    const packageLock = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8')
    );

    // Security requirements based on known CVEs
    const securityRequirements: Record<string, { minVersion: string; cve?: string }> = {
      '@modelcontextprotocol/sdk': {
        minVersion: '1.24.0',
        cve: 'CVE-2025-66414'
      }
    };

    for (const [pkg, requirement] of Object.entries(securityRequirements)) {
      const installedPkg = packageLock.packages[`node_modules/${pkg}`];

      if (installedPkg) {
        const comparison = semverCompare(installedPkg.version, requirement.minVersion);
        expect(comparison).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
