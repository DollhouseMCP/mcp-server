import { describe, test, expect, beforeAll } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';

/**
 * MCP Registry Workflow Tests
 *
 * These tests validate the MCP registry publishing workflow configuration
 * without actually publishing to the registry. They ensure:
 * - Workflow file exists and is valid YAML
 * - server.json exists and is valid JSON
 * - Versions are consistent across files
 * - Required fields are present
 * - Security settings are correct (OIDC, pinned versions)
 * - Dry-run capability exists
 *
 * Related: PR #1367 - Automated testing for MCP registry workflow
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROJECT_ROOT = join(__dirname, '../../..');
const WORKFLOW_FILE = join(PROJECT_ROOT, '.github/workflows/publish-mcp-registry.yml');
const SERVER_JSON_FILE = join(PROJECT_ROOT, 'server.json');
const PACKAGE_JSON_FILE = join(PROJECT_ROOT, 'package.json');

interface ServerJson {
  name: string;
  title?: string;
  description: string;
  version: string;
  homepage?: string;
  repository?: {
    type: string;
    url: string;
  };
  license?: string;
  keywords?: string[];
  packages: Array<{
    registryType: string;
    identifier: string;
    version: string;
    transport?: {
      type: string;
    };
  }>;
}

interface PackageJson {
  name: string;
  version: string;
  description?: string;
  files?: string[];
  [key: string]: unknown;
}

interface WorkflowYaml {
  name: string;
  on: unknown;
  permissions?: {
    'id-token'?: string;
    contents?: string;
    [key: string]: string | undefined;
  };
  jobs: {
    [key: string]: unknown;
  };
}

describe('MCP Registry Workflow Configuration', () => {
  describe('File Existence', () => {
    test('workflow file should exist', () => {
      expect(existsSync(WORKFLOW_FILE)).toBe(true);
    });

    test('server.json should exist', () => {
      expect(existsSync(SERVER_JSON_FILE)).toBe(true);
    });

    test('package.json should exist', () => {
      expect(existsSync(PACKAGE_JSON_FILE)).toBe(true);
    });
  });

  describe('Workflow YAML Validation', () => {
    let workflowContent: string;
    let workflow: WorkflowYaml;

    beforeAll(() => {
      workflowContent = readFileSync(WORKFLOW_FILE, 'utf-8');
      workflow = yaml.load(workflowContent) as WorkflowYaml;
    });

    test('should be valid YAML', () => {
      expect(() => yaml.load(workflowContent)).not.toThrow();
      expect(workflow).toBeDefined();
      expect(typeof workflow).toBe('object');
    });

    test('should have a name', () => {
      expect(workflow.name).toBeDefined();
      expect(typeof workflow.name).toBe('string');
      expect(workflow.name.length).toBeGreaterThan(0);
    });

    test('should have jobs defined', () => {
      expect(workflow.jobs).toBeDefined();
      expect(typeof workflow.jobs).toBe('object');
      expect(Object.keys(workflow.jobs).length).toBeGreaterThan(0);
    });

    test('should have correct OIDC permissions', () => {
      expect(workflow.permissions).toBeDefined();
      expect(workflow.permissions?.['id-token']).toBe('write');
      expect(workflow.permissions?.contents).toBe('read');
    });

    test('should use pinned mcp-publisher version (not latest)', () => {
      /**
       * Security requirement: mcp-publisher version must be pinned
       *
       * We validate the VERSION variable is set to a specific semver tag (vX.Y.Z)
       * and used via ${VERSION} interpolation. This prevents using "latest" which
       * could introduce breaking changes or security vulnerabilities.
       *
       * We check the source YAML (not runtime values) because:
       * - The workflow uses shell variable interpolation: ${VERSION}
       * - We need to validate the VARIABLE DEFINITION, not the expanded URL
       * - This catches mistakes like VERSION="latest" or hardcoded URLs
       *
       * Related: Issue #1375 - Fixed test pattern to validate VERSION variable declaration
       */

      // Check 1: VERSION variable is defined with semver format (vX.Y.Z or vX.Y.Z-prerelease)
      // Support both single and double quotes, optional whitespace
      const versionVarRegex = /\bVERSION\s*=\s*["']v\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?["']/;
      expect(workflowContent).toMatch(versionVarRegex);

      // Check 2: VERSION variable is used in download URL (prevents hardcoded bypass)
      const downloadUrlRegex = /releases\/download\/\$\{VERSION\}/;
      expect(workflowContent).toMatch(downloadUrlRegex);

      // Check 3: No use of "latest" in release URLs (security anti-pattern)
      const latestUrlRegex = /releases\/latest\/download/;
      expect(workflowContent).not.toMatch(latestUrlRegex);

      // Check 4: VERSION is not set to "latest" (prevent variable-level bypass)
      const versionLatestRegex = /\bVERSION\s*=\s*["']latest["']/;
      expect(workflowContent).not.toMatch(versionLatestRegex);
    });

    test('should not use YAML environment variable VERSION with latest', () => {
      /**
       * Additional security check: Prevent using YAML env var syntax
       *
       * While the workflow currently uses shell variables, someone could
       * theoretically bypass our checks by using YAML environment variables:
       *
       * env:
       *   VERSION: latest
       *
       * This test ensures we catch that pattern too.
       */
      const envVarLatestRegex = /env:[\s\S]*?VERSION:\s*latest/;
      expect(workflowContent).not.toMatch(envVarLatestRegex);
    });

    test('should have dry-run capability', () => {
      // Check for dry_run or dry-run in workflow
      const hasDryRun = workflowContent.includes('dry_run') || workflowContent.includes('dry-run');
      expect(hasDryRun).toBe(true);
    });

    test('should use workflow_dispatch for manual triggers', () => {
      expect(workflowContent).toMatch(/workflow_dispatch/);
    });

    test('should trigger on release published', () => {
      expect(workflowContent).toMatch(/release:/);
      expect(workflowContent).toMatch(/types:.*\[published\]/);
    });
  });

  describe('server.json Validation', () => {
    let serverJson: ServerJson;

    beforeAll(() => {
      const content = readFileSync(SERVER_JSON_FILE, 'utf-8');
      serverJson = JSON.parse(content);
    });

    test('should be valid JSON', () => {
      expect(() => {
        JSON.parse(readFileSync(SERVER_JSON_FILE, 'utf-8'));
      }).not.toThrow();
    });

    test('should have required name field', () => {
      expect(serverJson.name).toBeDefined();
      expect(typeof serverJson.name).toBe('string');
      expect(serverJson.name.length).toBeGreaterThan(0);
    });

    test('should have required version field', () => {
      expect(serverJson.version).toBeDefined();
      expect(typeof serverJson.version).toBe('string');
      expect(serverJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    test('should have required description field', () => {
      expect(serverJson.description).toBeDefined();
      expect(typeof serverJson.description).toBe('string');
      expect(serverJson.description.length).toBeGreaterThan(0);
    });

    test('should have required packages array', () => {
      expect(serverJson.packages).toBeDefined();
      expect(Array.isArray(serverJson.packages)).toBe(true);
      expect(serverJson.packages.length).toBeGreaterThan(0);
    });

    test('should use correct namespace casing (DollhouseMCP)', () => {
      expect(serverJson.name).toMatch(/DollhouseMCP/);
    });

    test('packages should have required fields', () => {
      const pkg = serverJson.packages[0];
      expect(pkg.registryType).toBeDefined();
      expect(pkg.identifier).toBeDefined();
      expect(pkg.version).toBeDefined();
    });

    test('should include NPM package in packages array', () => {
      const npmPackage = serverJson.packages.find(
        (pkg) => pkg.registryType === 'npm'
      );
      expect(npmPackage).toBeDefined();
      expect(npmPackage?.identifier).toMatch(/@dollhousemcp\/mcp-server/);
    });
  });

  describe('Version Consistency', () => {
    let serverJson: ServerJson;
    let packageJson: PackageJson;

    beforeAll(() => {
      serverJson = JSON.parse(readFileSync(SERVER_JSON_FILE, 'utf-8'));
      packageJson = JSON.parse(readFileSync(PACKAGE_JSON_FILE, 'utf-8'));
    });

    test('server.json version should match package.json version', () => {
      expect(serverJson.version).toBe(packageJson.version);
    });

    test('server.json packages version should match package.json version', () => {
      const npmPackage = serverJson.packages.find(
        (pkg) => pkg.registryType === 'npm'
      );
      expect(npmPackage?.version).toBe(packageJson.version);
    });
  });

  describe('package.json Integration', () => {
    let packageJson: PackageJson;

    beforeAll(() => {
      packageJson = JSON.parse(readFileSync(PACKAGE_JSON_FILE, 'utf-8'));
    });

    test('server.json should be in files array', () => {
      expect(packageJson.files).toBeDefined();
      expect(Array.isArray(packageJson.files)).toBe(true);
      expect(packageJson.files).toContain('server.json');
    });

    test('package name should match server.json NPM package identifier', () => {
      const serverJson = JSON.parse(readFileSync(SERVER_JSON_FILE, 'utf-8'));
      const npmPackage = serverJson.packages.find(
        (pkg: { registryType: string }) => pkg.registryType === 'npm'
      );
      expect(npmPackage?.identifier).toBe(packageJson.name);
    });
  });

  describe('Security Configuration', () => {
    let workflowContent: string;

    beforeAll(() => {
      workflowContent = readFileSync(WORKFLOW_FILE, 'utf-8');
    });

    test('should use OIDC authentication (not personal tokens)', () => {
      expect(workflowContent).toMatch(/login github-oidc/);
      expect(workflowContent).not.toMatch(/NPM_TOKEN/);
      expect(workflowContent).not.toMatch(/GITHUB_TOKEN.*publish/);
    });

    test('should use npm ci instead of npm install', () => {
      // npm ci ensures reproducible builds
      if (workflowContent.includes('npm install') || workflowContent.includes('npm i ')) {
        // Check if there's also npm ci
        expect(workflowContent).toMatch(/npm ci/);
      }
    });

    test('should build before publishing', () => {
      expect(workflowContent).toMatch(/npm run build/);
    });

    test('should verify mcp-publisher installation', () => {
      expect(workflowContent).toMatch(/mcp-publisher --version/);
    });
  });

  describe('Workflow Best Practices', () => {
    let workflowContent: string;

    beforeAll(() => {
      workflowContent = readFileSync(WORKFLOW_FILE, 'utf-8');
    });

    test('should use pinned action versions', () => {
      // Check for @v4 style pinning (not @main or @latest)
      const actionRegex = /uses:.*@v\d+/g;
      const matches = workflowContent.match(actionRegex);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBeGreaterThan(0);

      // Ensure no @main or @latest
      expect(workflowContent).not.toMatch(/uses:.*@main/);
      expect(workflowContent).not.toMatch(/uses:.*@latest/);
    });

    test('should specify Node.js version', () => {
      expect(workflowContent).toMatch(/node-version:/);
    });

    test('should use ubuntu-latest runner', () => {
      expect(workflowContent).toMatch(/runs-on:.*ubuntu-latest/);
    });

    test('should checkout code before publishing', () => {
      expect(workflowContent).toMatch(/actions\/checkout/);
    });
  });

  describe('Integration Tests', () => {
    test('all critical files should be present and valid', () => {
      // This test ensures the entire workflow can be validated
      expect(existsSync(WORKFLOW_FILE)).toBe(true);
      expect(existsSync(SERVER_JSON_FILE)).toBe(true);
      expect(existsSync(PACKAGE_JSON_FILE)).toBe(true);

      // Parse all files successfully
      const workflowContent = readFileSync(WORKFLOW_FILE, 'utf-8');
      const workflow = yaml.load(workflowContent);
      const serverJson = JSON.parse(readFileSync(SERVER_JSON_FILE, 'utf-8'));
      const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_FILE, 'utf-8'));

      expect(workflow).toBeDefined();
      expect(serverJson).toBeDefined();
      expect(packageJson).toBeDefined();
    });

    test('workflow should be ready for production use', () => {
      const workflowContent = readFileSync(WORKFLOW_FILE, 'utf-8');
      const serverJson: ServerJson = JSON.parse(readFileSync(SERVER_JSON_FILE, 'utf-8'));
      const packageJson: PackageJson = JSON.parse(readFileSync(PACKAGE_JSON_FILE, 'utf-8'));

      // Version consistency
      expect(serverJson.version).toBe(packageJson.version);

      // Security: OIDC
      expect(workflowContent).toMatch(/id-token: write/);
      expect(workflowContent).toMatch(/login github-oidc/);

      // Pinned versions - check VERSION variable declaration (see line 121 for detailed explanation)
      // This validates the VERSION variable uses semver format, not "latest"
      expect(workflowContent).toMatch(/VERSION\s*=\s*["']v\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?["']/);

      // Dry-run capability
      expect(workflowContent).toMatch(/dry[-_]run/);

      // Required fields
      expect(serverJson.name).toBeTruthy();
      expect(serverJson.version).toBeTruthy();
      expect(serverJson.description).toBeTruthy();
      expect(serverJson.packages.length).toBeGreaterThan(0);
    });
  });
});
