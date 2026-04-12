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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    const projectRoot = path.resolve(__dirname, '../..');
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
      // Using bounded quantifiers {1,10} to prevent ReDoS (SonarCloud typescript:S5852)
      const versionMatch = specifiedVersion.match(/(\d{1,10}\.\d{1,10}\.\d{1,10})/);
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
    it('should use stdio transport as the default', async () => {
      const projectRoot = path.resolve(__dirname, '../..');
      const indexPath = path.join(projectRoot, 'src/index.ts');
      const indexContent = fs.readFileSync(indexPath, 'utf8');

      // Verify StdioServerTransport is imported for the default transport
      expect(indexContent).toContain('StdioServerTransport');
      expect(indexContent).toContain('from "@modelcontextprotocol/sdk/server/stdio.js"');
    });

    it('should instantiate StdioServerTransport for stdio mode', async () => {
      const projectRoot = path.resolve(__dirname, '../..');
      const indexPath = path.join(projectRoot, 'src/index.ts');
      const indexContent = fs.readFileSync(indexPath, 'utf8');

      expect(indexContent).toMatch(/new\s+StdioServerTransport\s*\(/);
    });

    it('should use createMcpExpressApp for HTTP transport DNS rebinding protection', async () => {
      const projectRoot = path.resolve(__dirname, '../..');
      const httpServerPath = path.join(projectRoot, 'src/server/StreamableHttpServer.ts');
      const httpServerContent = fs.readFileSync(httpServerPath, 'utf8');

      // StreamableHttpServer.ts must use createMcpExpressApp() from the SDK,
      // which enables DNS rebinding protection by default (CVE-2025-66414)
      expect(httpServerContent).toContain('createMcpExpressApp');
      expect(httpServerContent).toContain("from '@modelcontextprotocol/sdk/server/express.js'");
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
    it('should default to stdio transport in main entry point', async () => {
      const projectRoot = path.resolve(__dirname, '../..');
      const indexPath = path.join(projectRoot, 'src/index.ts');
      const indexContent = fs.readFileSync(indexPath, 'utf8');

      // Default transport is stdio (not HTTP)
      expect(indexContent).toContain('StdioServerTransport');
      // SSE transport is not used (deprecated in favor of StreamableHTTP)
      expect(indexContent).not.toContain('SSEServerTransport');
    });

    it('should not directly import raw SDK HTTP transports in main server', async () => {
      const projectRoot = path.resolve(__dirname, '../..');
      const indexPath = path.join(projectRoot, 'src/index.ts');
      const indexContent = fs.readFileSync(indexPath, 'utf8');

      // index.ts imports from StreamableHttpServer.ts (our wrapper),
      // NOT directly from the SDK. The wrapper uses createMcpExpressApp()
      // which enforces DNS rebinding protection.
      expect(indexContent).not.toContain('from "@modelcontextprotocol/sdk/server/sse.js"');
      expect(indexContent).not.toContain('from "@modelcontextprotocol/sdk/server/streamableHttp.js"');
    });
  });
});

describe('HTTP Transport Security (Phase 2)', () => {
  /**
   * DollhouseMCP supports Streamable HTTP transport (--streamable-http).
   * These tests verify the HTTP transport implementation meets security requirements.
   *
   * Security measures:
   * 1. createMcpExpressApp() enforces DNS rebinding protection by default
   * 2. Host allowlist via DOLLHOUSE_HTTP_ALLOWED_HOSTS
   * 3. Per-client rate limiting
   * 4. Default binding to 127.0.0.1 (localhost only)
   */

  it('should use createMcpExpressApp for DNS rebinding protection', async () => {
    const projectRoot = path.resolve(__dirname, '../..');
    const httpServerPath = path.join(projectRoot, 'src/server/StreamableHttpServer.ts');
    const httpServerContent = fs.readFileSync(httpServerPath, 'utf8');

    // createMcpExpressApp() enables DNS rebinding protection by default
    expect(httpServerContent).toContain('createMcpExpressApp');
  });

  it('should have hostHeaderValidation middleware available', async () => {
    const middleware = await import('@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js');

    expect(middleware.hostHeaderValidation).toBeDefined();
    expect(middleware.localhostHostValidation).toBeDefined();
  });

  it('should implement per-client rate limiting', async () => {
    const projectRoot = path.resolve(__dirname, '../..');
    const httpServerPath = path.join(projectRoot, 'src/server/StreamableHttpServer.ts');
    const httpServerContent = fs.readFileSync(httpServerPath, 'utf8');

    expect(httpServerContent).toContain('consumeRateLimit');
    expect(httpServerContent).toContain('rateLimitMaxRequests');
  });

  it('should default to localhost binding', () => {
    // DOLLHOUSE_HTTP_HOST defaults to 127.0.0.1 in env.ts
    // This prevents accidental exposure to the network
    const { env: testEnv } = require('../../src/config/env.js');
    expect(testEnv.DOLLHOUSE_HTTP_HOST).toBe('127.0.0.1');
  });

  it('should have SDK transports available', async () => {
    const streamable = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    expect(streamable).toHaveProperty('StreamableHTTPServerTransport');
  });
});

describe('Security Version Constraints', () => {
  it('should have security-related dependencies at safe versions', () => {
    const projectRoot = path.resolve(__dirname, '../..');
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
