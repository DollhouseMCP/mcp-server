# Config Persistence Test Implementation Plan

## Overview
This document contains the complete test implementation for the config persistence fix and related features. The critical bug was that ConfigManager was using SecureYamlParser (designed for markdown with frontmatter) instead of js-yaml for pure YAML config files, causing all values to reset on every load.

## Test Files to Create/Update

### 1. Fix ConfigManager.test.ts - Update for YAML Format

**Current Issues:**
- Tests expect JSON format but ConfigManager uses YAML (config.yml)
- No regression test for the SecureYamlParser bug
- Missing persistence validation between instances

**Key Changes Needed:**

```typescript
// Update line 40 - config path should be config.yml not config.json
const configPath = path.join(configDir, 'config.yml');

// Update line 118 - should write YAML not JSON
expect(mockWriteFile).toHaveBeenCalledWith(
  expect.stringContaining('.tmp'),
  expect.stringMatching(/^version: ['"]?1\.0\.0/), // YAML format
  { mode: 384 }
);

// Update line 132 - mock should return YAML not JSON
mockReadFile.mockResolvedValue(`
version: '1.0.0'
github:
  auth:
    client_id: 'Ov23liTestClientId123'
`);

// Update line 147 - handle corrupted YAML not JSON
mockReadFile.mockResolvedValue('invalid: yaml: content: :::');

// Update line 159 - expect YAML format in write
expect(mockWriteFile).toHaveBeenCalledWith(
  expect.stringContaining('.tmp'),
  expect.stringMatching(/^version:/), // YAML format
  { mode: 384 }
);
```

### 2. Add Critical Regression Test

```typescript
describe('YAML Parser Selection (Regression Test for Bug)', () => {
  it('should use js-yaml for config files, NOT SecureYamlParser', async () => {
    // This test ensures we don't regress to using SecureYamlParser
    // which expects markdown with frontmatter and returns empty {} for pure YAML
    
    const yamlConfig = `
version: '1.0.0'
user:
  username: mickdarling
  email: mick@mickdarling.com
sync:
  enabled: true
  bulk:
    download_enabled: true
`;
    
    const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
    mockReadFile.mockResolvedValue(yamlConfig);
    
    const configManager = ConfigManager.getInstance();
    await configManager.initialize();
    
    // These should NOT be null - the bug was they were returning null
    const config = configManager.getConfig();
    expect(config.user.username).toBe('mickdarling');
    expect(config.user.email).toBe('mick@mickdarling.com');
    expect(config.sync.enabled).toBe(true);
    expect(config.sync.bulk.download_enabled).toBe(true);
  });

  it('should persist config values between ConfigManager instances', async () => {
    const yamlConfig = `
version: '1.0.0'
user:
  username: testuser
  email: test@example.com
sync:
  enabled: true
`;
    
    const mockReadFile = fs.readFile as jest.MockedFunction<typeof fs.readFile>;
    const mockWriteFile = fs.writeFile as jest.MockedFunction<typeof fs.writeFile>;
    
    // First instance saves config
    mockReadFile.mockRejectedValueOnce({ code: 'ENOENT' }); // First load - no file
    mockWriteFile.mockResolvedValue(undefined);
    
    const configManager1 = ConfigManager.getInstance();
    await configManager1.initialize();
    await configManager1.setUserIdentity('testuser', 'test@example.com');
    
    // Simulate what was written
    const writtenYaml = mockWriteFile.mock.calls[0][1];
    
    // Reset singleton for test
    (ConfigManager as any).instance = null;
    
    // Second instance loads saved config
    mockReadFile.mockResolvedValue(writtenYaml);
    
    const configManager2 = ConfigManager.getInstance();
    await configManager2.initialize();
    
    const config = configManager2.getConfig();
    expect(config.user.username).toBe('testuser');
    expect(config.user.email).toBe('test@example.com');
  });
});
```

### 3. Create Integration Test - yaml-parser-selection.test.ts

```typescript
/**
 * Integration tests for YAML parser selection
 * Ensures the correct parser is used for each file type
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { SecureYamlParser } from '../../../src/security/secureYamlParser.js';

describe('YAML Parser Selection Integration', () => {
  let tempDir: string;
  
  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `dollhouse-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });
  
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });
  
  describe('Pure YAML Files (config.yml)', () => {
    it('should correctly parse pure YAML config files with js-yaml', async () => {
      const configPath = path.join(tempDir, 'config.yml');
      const configContent = `
version: '1.0.0'
user:
  username: johndoe
  email: john@example.com
sync:
  enabled: true
  individual:
    require_confirmation: false
`;
      
      await fs.writeFile(configPath, configContent);
      
      // Parse with js-yaml (correct)
      const content = await fs.readFile(configPath, 'utf-8');
      const parsed = yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA });
      
      expect(parsed).toHaveProperty('user.username', 'johndoe');
      expect(parsed).toHaveProperty('sync.enabled', true);
    });
    
    it('should FAIL if SecureYamlParser is used on pure YAML', async () => {
      const configPath = path.join(tempDir, 'config.yml');
      const configContent = `
version: '1.0.0'
user:
  username: johndoe
  email: john@example.com
`;
      
      await fs.writeFile(configPath, configContent);
      
      // This reproduces the original bug
      const content = await fs.readFile(configPath, 'utf-8');
      const parsed = SecureYamlParser.parse(content);
      
      // SecureYamlParser returns empty object for pure YAML (no frontmatter)
      expect(parsed.metadata).toEqual({});
      expect(parsed.content).toBe(''); // No markdown content
    });
  });
  
  describe('Markdown with Frontmatter (personas/*.md)', () => {
    it('should correctly parse markdown files with SecureYamlParser', async () => {
      const personaPath = path.join(tempDir, 'creative-writer.md');
      const personaContent = `---
name: Creative Writer
description: A creative writing assistant
version: '1.0.0'
author: dollhousemcp
---

# Creative Writer Persona

You are a creative writer who helps users with storytelling...
`;
      
      await fs.writeFile(personaPath, personaContent);
      
      // Parse with SecureYamlParser (correct)
      const content = await fs.readFile(personaPath, 'utf-8');
      const parsed = SecureYamlParser.parse(content);
      
      expect(parsed.metadata.name).toBe('Creative Writer');
      expect(parsed.content).toContain('You are a creative writer');
    });
    
    it('should FAIL if js-yaml is used on markdown with frontmatter', async () => {
      const personaPath = path.join(tempDir, 'creative-writer.md');
      const personaContent = `---
name: Creative Writer
---
# Content here`;
      
      await fs.writeFile(personaPath, personaContent);
      
      // Using js-yaml on frontmatter format would fail
      const content = await fs.readFile(personaPath, 'utf-8');
      
      // js-yaml would try to parse the entire file as YAML and fail
      expect(() => {
        yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA });
      }).toThrow(); // Would throw because '# Content here' is not valid YAML
    });
  });
});
```

### 4. Create End-to-End Test - config-persistence.test.ts

```typescript
/**
 * End-to-end test for config persistence
 * Validates the complete flow of saving and loading configuration
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ConfigManager } from '../../../src/config/ConfigManager.js';

describe('Config Persistence E2E', () => {
  let originalHome: string;
  let testHome: string;
  
  beforeEach(async () => {
    // Create isolated test environment
    originalHome = os.homedir();
    testHome = path.join(os.tmpdir(), `dollhouse-e2e-${Date.now()}`);
    await fs.mkdir(testHome, { recursive: true });
    
    // Mock homedir
    jest.spyOn(os, 'homedir').mockReturnValue(testHome);
    
    // Reset singleton
    (ConfigManager as any).instance = null;
  });
  
  afterEach(async () => {
    // Cleanup
    jest.restoreAllMocks();
    await fs.rm(testHome, { recursive: true, force: true });
  });
  
  it('should persist user configuration across sessions', async () => {
    // Session 1: Set configuration
    const config1 = ConfigManager.getInstance();
    await config1.initialize();
    
    await config1.setUserIdentity('mickdarling', 'mick@mickdarling.com');
    await config1.setSyncEnabled(true);
    await config1.setBulkDownloadEnabled(true);
    
    // Verify config file was created
    const configPath = path.join(testHome, '.dollhouse', 'config.yml');
    const exists = await fs.access(configPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
    
    // Read raw file to verify YAML format
    const rawContent = await fs.readFile(configPath, 'utf-8');
    expect(rawContent).toContain('username: mickdarling');
    expect(rawContent).toContain('email: mick@mickdarling.com');
    expect(rawContent).toContain('enabled: true');
    
    // Session 2: Load configuration (simulate restart)
    (ConfigManager as any).instance = null;
    
    const config2 = ConfigManager.getInstance();
    await config2.initialize();
    
    const loadedConfig = config2.getConfig();
    expect(loadedConfig.user.username).toBe('mickdarling');
    expect(loadedConfig.user.email).toBe('mick@mickdarling.com');
    expect(loadedConfig.sync.enabled).toBe(true);
    expect(loadedConfig.sync.bulk.download_enabled).toBe(true);
  });
  
  it('should handle portfolio sync configuration', async () => {
    const config = ConfigManager.getInstance();
    await config.initialize();
    
    // Configure portfolio sync
    await config.setGitHubPortfolioUrl('https://github.com/mickdarling/dollhouse-portfolio');
    await config.setSyncEnabled(true);
    await config.setAutoSubmit(true);
    
    // Restart and verify
    (ConfigManager as any).instance = null;
    
    const config2 = ConfigManager.getInstance();
    await config2.initialize();
    
    const loadedConfig = config2.getConfig();
    expect(loadedConfig.github.portfolio.repository_url).toBe('https://github.com/mickdarling/dollhouse-portfolio');
    expect(loadedConfig.sync.enabled).toBe(true);
    expect(loadedConfig.collection.auto_submit).toBe(true);
  });
});
```

### 5. Create PortfolioSyncManager Tests

```typescript
/**
 * Tests for PortfolioSyncManager
 * Validates sync and download functionality with config persistence
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { PortfolioSyncManager } from '../../../src/portfolio/PortfolioSyncManager.js';
import { ConfigManager } from '../../../src/config/ConfigManager.js';
import { ElementType } from '../../../src/portfolio/types.js';

describe('PortfolioSyncManager', () => {
  let syncManager: PortfolioSyncManager;
  let mockConfigManager: jest.Mocked<ConfigManager>;
  
  beforeEach(() => {
    // Mock dependencies
    mockConfigManager = {
      getConfig: jest.fn().mockReturnValue({
        user: { username: 'testuser', email: 'test@example.com' },
        sync: {
          enabled: true,
          bulk: { download_enabled: true, upload_enabled: false }
        },
        github: {
          portfolio: { repository_url: 'https://github.com/testuser/portfolio' }
        }
      }),
      setSyncEnabled: jest.fn(),
      setBulkDownloadEnabled: jest.fn()
    } as any;
    
    jest.spyOn(ConfigManager, 'getInstance').mockReturnValue(mockConfigManager);
    
    syncManager = new PortfolioSyncManager();
  });
  
  describe('Download with Fuzzy Matching', () => {
    it('should find element with fuzzy name matching', async () => {
      // Mock GitHub indexer response
      const mockElements = [
        { name: 'Creative Writer Pro', type: 'personas', path: 'personas/creative-writer-pro.md' },
        { name: 'Debug Assistant', type: 'personas', path: 'personas/debug-assistant.md' }
      ];
      
      jest.spyOn(syncManager as any, 'indexer', 'get').mockReturnValue({
        searchPortfolio: jest.fn().mockResolvedValue(mockElements)
      });
      
      // Search with partial/fuzzy name
      const result = await syncManager.downloadElement('creative', ElementType.PERSONA);
      
      expect(result.success).toBe(true);
      expect(result.message).toContain('Creative Writer Pro');
    });
    
    it('should handle multiple fuzzy matches', async () => {
      const mockElements = [
        { name: 'Creative Writer', type: 'personas' },
        { name: 'Creative Designer', type: 'personas' }
      ];
      
      jest.spyOn(syncManager as any, 'indexer', 'get').mockReturnValue({
        searchPortfolio: jest.fn().mockResolvedValue(mockElements)
      });
      
      const result = await syncManager.downloadElement('creative', ElementType.PERSONA);
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Multiple matches found');
      expect(result.data.matches).toHaveLength(2);
    });
  });
  
  describe('Config Integration', () => {
    it('should respect sync enabled configuration', async () => {
      mockConfigManager.getConfig.mockReturnValue({
        sync: { enabled: false }
      } as any);
      
      const result = await syncManager.downloadElement('test', ElementType.PERSONA);
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Sync is disabled');
    });
    
    it('should check bulk download configuration', async () => {
      mockConfigManager.getConfig.mockReturnValue({
        sync: {
          enabled: true,
          bulk: { download_enabled: false }
        }
      } as any);
      
      const result = await syncManager.downloadBulk(ElementType.PERSONA);
      
      expect(result.success).toBe(false);
      expect(result.message).toContain('Bulk download is disabled');
    });
  });
});
```

### 6. Create Security Test for YAML Parsers

```typescript
/**
 * Security tests for YAML parser usage
 * Ensures security is maintained with correct parser selection
 */

import { describe, it, expect } from '@jest/globals';
import * as yaml from 'js-yaml';
import { SecureYamlParser } from '../../../src/security/secureYamlParser.js';

describe('YAML Parser Security', () => {
  describe('js-yaml with FAILSAFE_SCHEMA', () => {
    it('should prevent code execution in config files', () => {
      const maliciousYaml = `
version: '1.0.0'
exploit: !!js/function 'function() { return "pwned"; }'
`;
      
      // FAILSAFE_SCHEMA prevents code execution
      const parsed = yaml.load(maliciousYaml, { schema: yaml.FAILSAFE_SCHEMA });
      
      // The function tag is not executed, treated as string
      expect(typeof parsed.exploit).toBe('string');
      expect(parsed.exploit).not.toBe('pwned');
    });
    
    it('should handle YAML bombs safely', () => {
      const yamlBomb = `
a: &a ["a", "a", "a", "a", "a", "a", "a", "a", "a"]
b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]
c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]
`;
      
      // Should parse without expanding infinitely
      expect(() => {
        yaml.load(yamlBomb, { schema: yaml.FAILSAFE_SCHEMA });
      }).not.toThrow();
    });
  });
  
  describe('SecureYamlParser', () => {
    it('should validate frontmatter size limits', () => {
      const largeFrontmatter = '---\n' + 'x: '.repeat(100000) + 'y\n---\nContent';
      
      expect(() => {
        SecureYamlParser.parse(largeFrontmatter, {
          maxYamlSize: 64 * 1024 // 64KB limit
        });
      }).toThrow(/exceeds maximum/);
    });
    
    it('should detect and reject malicious patterns', () => {
      const maliciousPersona = `---
name: Evil Persona
instructions: !!js/function 'process.exit(1)'
---
Content`;
      
      expect(() => {
        SecureYamlParser.parse(maliciousPersona);
      }).toThrow(/security/i);
    });
  });
});
```

## Test Execution Plan

### Phase 1: Fix Existing Tests
1. Update ConfigManager.test.ts for YAML format
2. Run tests to verify basic functionality works
3. Fix any remaining test failures

### Phase 2: Add Regression Tests
1. Add YAML parser selection tests to ConfigManager.test.ts
2. Create integration test file for parser selection
3. Verify the bug doesn't resurface

### Phase 3: Add Feature Tests
1. Create PortfolioSyncManager tests
2. Add end-to-end config persistence tests
3. Add security validation tests

### Phase 4: Validate Coverage
1. Run coverage report
2. Ensure >90% coverage for:
   - ConfigManager
   - PortfolioSyncManager
   - YAML parsing logic
3. Add any missing edge cases

## Success Metrics
- ✅ All ConfigManager tests passing (0 failures)
- ✅ Regression test prevents SecureYamlParser usage on config
- ✅ Config values persist between sessions
- ✅ Portfolio sync respects saved configuration
- ✅ Security is maintained with both parsers
- ✅ >90% code coverage for affected modules

## Common Test Utilities

```typescript
// test/utils/config-test-helpers.ts

export function createTestYamlConfig(overrides = {}): string {
  const config = {
    version: '1.0.0',
    user: {
      username: null,
      email: null,
      display_name: null
    },
    sync: {
      enabled: false,
      bulk: {
        download_enabled: false,
        upload_enabled: false
      }
    },
    ...overrides
  };
  
  return yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true
  });
}

export async function createTempConfigFile(content: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dollhouse-test-'));
  const configPath = path.join(tempDir, '.dollhouse', 'config.yml');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, content);
  return configPath;
}

export async function cleanupTestConfig(configPath: string): Promise<void> {
  const tempDir = path.resolve(configPath, '..', '..');
  await fs.rm(tempDir, { recursive: true, force: true });
}
```

## Running the Tests

```bash
# Run updated ConfigManager tests
npm test -- test/__tests__/unit/config/ConfigManager.test.ts

# Run integration tests
npm test -- test/__tests__/integration/yaml-parser-selection.test.ts

# Run e2e tests
npm test -- test/__tests__/e2e/config-persistence.test.ts

# Run all config-related tests
npm test -- --testPathPattern="config|Config|yaml|Yaml"

# Run with coverage
npm test -- --coverage --coveragePathIgnorePatterns=/test/ \
  --collectCoverageFrom="src/config/**/*.ts" \
  --collectCoverageFrom="src/portfolio/PortfolioSyncManager.ts"
```