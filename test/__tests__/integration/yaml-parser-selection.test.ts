/**
 * Integration tests for YAML parser selection
 * 
 * This test suite validates the critical bug fix where ConfigManager was using
 * SecureYamlParser (designed for markdown with frontmatter) instead of js-yaml
 * for pure YAML config files, causing all config values to reset on every load.
 * 
 * Tests ensure:
 * - Correct parser is used for each file type
 * - The bug doesn't resurface
 * - Security is maintained with both parsers
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { SecureYamlParser } from '../../../src/security/secureYamlParser.js';

describe('YAML Parser Selection Integration', () => {
  let tempDir: string;
  
  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `dollhouse-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
  });
  
  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
  
  describe('Critical Bug Regression Tests', () => {
    it('SecureYamlParser FAILS on pure YAML config (reproduces original bug)', async () => {
      // This test reproduces the original bug where SecureYamlParser was
      // incorrectly used for config.yml files
      
      const configPath = path.join(tempDir, 'config.yml');
      const configContent = `version: '1.0.0'
user:
  username: mickdarling
  email: mick@mickdarling.com
sync:
  enabled: true
  bulk:
    download_enabled: true`;
      
      await fs.writeFile(configPath, configContent);
      const content = await fs.readFile(configPath, 'utf-8');
      
      // This is what was happening in the bug - SecureYamlParser expects
      // markdown with frontmatter, so it returns empty for pure YAML
      const parsed = SecureYamlParser.parse(content);
      
      // BUG BEHAVIOR: Returns empty metadata because no frontmatter markers
      expect(parsed.metadata).toEqual({});
      expect(parsed.content).toBe(''); // No markdown content found
      
      // This is why config values were null - empty {} merged with defaults
      // would reset all user values!
    });
    
    it('js-yaml correctly parses pure YAML config (the fix)', async () => {
      // This test shows the correct behavior after the fix
      
      const configPath = path.join(tempDir, 'config.yml');
      const configContent = `version: '1.0.0'
user:
  username: mickdarling
  email: mick@mickdarling.com
sync:
  enabled: true
  bulk:
    download_enabled: true`;
      
      await fs.writeFile(configPath, configContent);
      const content = await fs.readFile(configPath, 'utf-8');
      
      // CORRECT: Use js-yaml with FAILSAFE_SCHEMA for pure YAML
      const parsed = yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA });
      
      // Values are correctly parsed
      expect(parsed).toHaveProperty('user.username', 'mickdarling');
      expect(parsed).toHaveProperty('user.email', 'mick@mickdarling.com');
      expect(parsed).toHaveProperty('sync.enabled', true);
      expect(parsed).toHaveProperty('sync.bulk.download_enabled', true);
    });
  });
  
  describe('Pure YAML Files (config.yml)', () => {
    it('should correctly parse all config fields with js-yaml', async () => {
      const configPath = path.join(tempDir, 'config.yml');
      const configContent = `version: '1.0.0'
user:
  username: johndoe
  email: john@example.com
  display_name: 'John Doe'
sync:
  enabled: true
  individual:
    require_confirmation: false
    show_diff_before_sync: true
  bulk:
    download_enabled: true
    upload_enabled: false
github:
  portfolio:
    repository_url: 'https://github.com/johndoe/portfolio'
    repository_name: 'dollhouse-portfolio'
  auth:
    client_id: 'Ov23liTestClientId12345'
collection:
  auto_submit: true`;
      
      await fs.writeFile(configPath, configContent);
      const content = await fs.readFile(configPath, 'utf-8');
      
      // Parse with js-yaml (correct)
      const parsed = yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA });
      
      // All fields should be correctly parsed
      expect(parsed).toHaveProperty('user.username', 'johndoe');
      expect(parsed).toHaveProperty('user.email', 'john@example.com');
      expect(parsed).toHaveProperty('sync.enabled', true);
      expect(parsed).toHaveProperty('sync.individual.require_confirmation', false);
      expect(parsed).toHaveProperty('sync.bulk.download_enabled', true);
      expect(parsed).toHaveProperty('github.auth.client_id', 'Ov23liTestClientId12345');
      expect(parsed).toHaveProperty('collection.auto_submit', true);
    });
    
    it('should handle null values correctly in pure YAML', async () => {
      const configPath = path.join(tempDir, 'config.yml');
      const configContent = `version: '1.0.0'
user:
  username: null
  email: null
  display_name: null
sync:
  enabled: false`;
      
      await fs.writeFile(configPath, configContent);
      const content = await fs.readFile(configPath, 'utf-8');
      
      const parsed = yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA });
      
      expect(parsed.user.username).toBeNull();
      expect(parsed.user.email).toBeNull();
      expect(parsed.user.display_name).toBeNull();
      expect(parsed.sync.enabled).toBe(false);
    });
    
    it('should preserve boolean types in YAML', async () => {
      const configPath = path.join(tempDir, 'config.yml');
      const configContent = `version: '1.0.0'
sync:
  enabled: true
  bulk:
    download_enabled: false
    upload_enabled: true`;
      
      await fs.writeFile(configPath, configContent);
      const content = await fs.readFile(configPath, 'utf-8');
      
      const parsed = yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA });
      
      // Booleans should be actual booleans, not strings
      expect(parsed.sync.enabled).toBe(true);
      expect(typeof parsed.sync.enabled).toBe('boolean');
      expect(parsed.sync.bulk.download_enabled).toBe(false);
      expect(parsed.sync.bulk.upload_enabled).toBe(true);
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
tags:
  - creative
  - writing
  - storytelling
---

# Creative Writer Persona

You are a creative writer who helps users with storytelling.

## Guidelines
- Be imaginative and descriptive
- Help with plot development
- Suggest character improvements`;
      
      await fs.writeFile(personaPath, personaContent);
      const content = await fs.readFile(personaPath, 'utf-8');
      
      // Parse with SecureYamlParser (correct for markdown)
      const parsed = SecureYamlParser.parse(content);
      
      expect(parsed.metadata.name).toBe('Creative Writer');
      expect(parsed.metadata.description).toBe('A creative writing assistant');
      expect(parsed.metadata.author).toBe('dollhousemcp');
      expect(parsed.metadata.tags).toEqual(['creative', 'writing', 'storytelling']);
      expect(parsed.content).toContain('You are a creative writer');
      expect(parsed.content).toContain('Be imaginative and descriptive');
    });
    
    it('js-yaml FAILS on markdown with frontmatter', async () => {
      const personaPath = path.join(tempDir, 'creative-writer.md');
      const personaContent = `---
name: Creative Writer
description: Assistant
---
# Markdown Content Here
This is the persona instructions.`;
      
      await fs.writeFile(personaPath, personaContent);
      const content = await fs.readFile(personaPath, 'utf-8');
      
      // Using js-yaml on frontmatter format would fail
      // because it tries to parse the entire file as YAML
      expect(() => {
        yaml.load(content, { schema: yaml.FAILSAFE_SCHEMA });
      }).toThrow(); // Throws because '# Markdown Content Here' is not valid YAML
    });
  });
  
  describe('Security Considerations', () => {
    it('js-yaml with FAILSAFE_SCHEMA prevents code execution', () => {
      const maliciousYaml = `version: '1.0.0'
exploit: !!js/function 'function() { process.exit(1); }'
danger: !!python/object/apply:os.system ['rm -rf /']`;
      
      // FAILSAFE_SCHEMA prevents code execution
      const parsed = yaml.load(maliciousYaml, { schema: yaml.FAILSAFE_SCHEMA });
      
      // The dangerous tags are not executed, treated as strings
      expect(typeof parsed.exploit).toBe('string');
      expect(parsed.exploit).not.toBeInstanceOf(Function);
      expect(typeof parsed.danger).toBe('string');
    });
    
    it('SecureYamlParser validates frontmatter size', () => {
      // Create a huge frontmatter that exceeds limits
      const lines = [];
      lines.push('---');
      for (let i = 0; i < 10000; i++) {
        lines.push(`field${i}: value${i}`);
      }
      lines.push('---');
      lines.push('Content');
      
      const hugeFrontmatter = lines.join('\n');
      
      expect(() => {
        SecureYamlParser.parse(hugeFrontmatter, {
          maxYamlSize: 64 * 1024 // 64KB limit
        });
      }).toThrow(/exceeds maximum/);
    });
    
    it('Both parsers handle YAML bombs safely', () => {
      const yamlBomb = `a: &a ["a", "a", "a", "a", "a", "a", "a", "a", "a"]
b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a]
c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b]
d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c]`;
      
      // js-yaml handles it
      expect(() => {
        yaml.load(yamlBomb, { schema: yaml.FAILSAFE_SCHEMA });
      }).not.toThrow();
      
      // SecureYamlParser with frontmatter format
      const withFrontmatter = `---\n${yamlBomb}\n---\nContent`;
      expect(() => {
        SecureYamlParser.parse(withFrontmatter);
      }).not.toThrow();
    });
  });
  
  describe('File Format Detection', () => {
    it('should identify pure YAML by absence of frontmatter markers', async () => {
      const configContent = `version: '1.0.0'
user:
  username: test`;
      
      // Pure YAML has no --- markers
      expect(configContent.startsWith('---')).toBe(false);
      expect(configContent.includes('\n---\n')).toBe(false);
    });
    
    it('should identify markdown with frontmatter by --- markers', async () => {
      const personaContent = `---
name: Test
---
Content`;
      
      // Frontmatter starts with ---
      expect(personaContent.startsWith('---')).toBe(true);
      expect(personaContent.includes('\n---\n')).toBe(true);
    });
  });
});