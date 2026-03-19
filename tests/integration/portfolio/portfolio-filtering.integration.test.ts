/**
 * Integration tests for isTestElement() filtering across all element managers
 *
 * NOTE: As of Issue #287, test-pattern filtering was removed to allow users
 * to create elements with "test" in their names. Only dangerous patterns
 * (security concerns like shell injection, command execution) are filtered.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PortfolioManager, ElementType } from '../../../src/portfolio/PortfolioManager.js';
import { createPortfolioTestEnvironment, type PortfolioTestEnvironment } from '../../helpers/portfolioTestHelper.js';

describe('Portfolio Filtering Integration', () => {
  let env: PortfolioTestEnvironment;
  let portfolioManager: PortfolioManager;

  beforeEach(async () => {
    env = await createPortfolioTestEnvironment('portfolio-filter-test');
    portfolioManager = env.portfolioManager;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  describe('dangerous pattern filtering across element types', () => {
    const dangerousFiles = [
      'eval-malicious-code.md',
      'exec-dangerous-command.md',
      'bash-c-rm-rf.md',
      'sh-c-malware.md',
      'powershell-bypass.md',
      'cmd-c-exploit.md',
      'shell-injection-attack.md',
      'bin-sh-reverse.md',
      'rm-rf-everything.md',
      'nc-e-bin-backdoor.md',
      'python-c-import-os.md',
      'curl-evil-payload.md',
      'wget-malicious-script.md'
    ];

    it('should filter dangerous files from PortfolioManager.listElements() across all element types', async () => {
      // Test all element types
      const elementTypes = [ElementType.AGENT, ElementType.SKILL, ElementType.TEMPLATE, ElementType.PERSONA];

      for (const elementType of elementTypes) {
        const elementDir = portfolioManager.getElementDir(elementType);

        // Create dangerous files
        for (const filename of dangerousFiles) {
          await fs.writeFile(path.join(elementDir, filename), `# Dangerous ${filename}\nContent goes here.`);
        }

        // Create legitimate files
        await fs.writeFile(path.join(elementDir, 'legitimate-file.md'), '# Legitimate File\nSafe content.');
        await fs.writeFile(path.join(elementDir, 'another-safe-file.md'), '# Another Safe File\nMore safe content.');

        // List elements - should only return legitimate files
        const elements = await portfolioManager.listElements(elementType);

        // Verify no dangerous files are returned
        for (const filename of dangerousFiles) {
          expect(elements).not.toContain(filename);
        }

        // Verify legitimate files are returned
        expect(elements).toContain('legitimate-file.md');
        expect(elements).toContain('another-safe-file.md');
        expect(elements).toHaveLength(2);
      }
    });

    it('should verify centralized filtering through PortfolioManager', async () => {
      // Test that all dangerous patterns are consistently filtered
      for (const filename of dangerousFiles) {
        expect(portfolioManager.isTestElement(filename)).toBe(true);
      }

      // Test that legitimate files are not filtered
      const legitimateFiles = [
        'legitimate-file.md',
        'production-agent.md',
        'code-assistant.md',
        'data-analysis.md',
        'meeting-notes.md'
      ];

      for (const filename of legitimateFiles) {
        expect(portfolioManager.isTestElement(filename)).toBe(false);
      }
    });
  });

  describe('test pattern names are allowed (Issue #287)', () => {
    // These files should NOT be filtered - users can legitimately use "test" in names
    const testNamedFiles = [
      'test-persona.md',
      'memory-test-agent.md',
      'yaml-test-skill.md',
      'perf-test-template.md',
      'stability-test-1.md',
      'roundtrip-test-data.md',
      'test-agent.md',
      'test-skill.md',
      'test-template.md',
      'file.test.md',
      '__test__file.md',
      'test-data-sample.md',
      'penetration-test-case.md',
      'metadata-test-file.md',
      'testpersona123.md'
    ];

    it('should allow files with test in the name (not filtered)', async () => {
      const elementTypes = [ElementType.AGENT, ElementType.SKILL, ElementType.TEMPLATE, ElementType.PERSONA];

      for (const elementType of elementTypes) {
        const elementDir = portfolioManager.getElementDir(elementType);

        // Create files with "test" in the name
        for (const filename of testNamedFiles) {
          await fs.writeFile(path.join(elementDir, filename), `# Test File: ${filename}\nThis is test content.`);
        }

        // List elements via PortfolioManager
        const elements = await portfolioManager.listElements(elementType);

        // All test-named files should be present (not filtered)
        expect(elements).toHaveLength(testNamedFiles.length);
        for (const filename of testNamedFiles) {
          expect(elements).toContain(filename);
        }
      }
    });

    it('should not filter test pattern names via isTestElement', () => {
      // Test patterns should NOT be filtered anymore (Issue #287)
      for (const filename of testNamedFiles) {
        expect(portfolioManager.isTestElement(filename)).toBe(false);
      }
    });
  });

  describe('centralized filtering verification', () => {
    it('should provide centralized isTestElement method', () => {
      // Verify the method exists and is callable
      expect(typeof portfolioManager.isTestElement).toBe('function');

      // Verify it works for dangerous patterns only
      expect(portfolioManager.isTestElement('eval-dangerous.md')).toBe(true);
      expect(portfolioManager.isTestElement('shell-injection.md')).toBe(true);

      // Test patterns are NOT filtered (Issue #287)
      expect(portfolioManager.isTestElement('test-file.md')).toBe(false);
      expect(portfolioManager.isTestElement('test-persona.md')).toBe(false);

      // Regular files are not filtered
      expect(portfolioManager.isTestElement('legitimate-file.md')).toBe(false);
    });

    it('should maintain consistent filtering behavior', () => {
      // Test a mix of patterns to ensure consistency
      const testCases = [
        // Dangerous patterns - should be filtered
        { filename: 'eval-code.md', shouldFilter: true },
        { filename: 'exec-command.md', shouldFilter: true },
        { filename: 'shell-injection.md', shouldFilter: true },
        { filename: 'bash-c-exploit.md', shouldFilter: true },
        { filename: 'powershell-attack.md', shouldFilter: true },

        // Test patterns - NOT filtered (Issue #287 removed test-pattern filtering
        // to allow users to legitimately name elements with "test" in the name)
        { filename: 'test-persona.md', shouldFilter: false },
        { filename: 'stability-test-1.md', shouldFilter: false },
        { filename: 'my-test-skill.md', shouldFilter: false },

        // Legitimate files with dangerous-looking substrings - should NOT be filtered
        // (ensures filtering isn't overly broad - patterns use ^ anchor so mid-word is OK)
        { filename: 'evaluation-criteria.md', shouldFilter: false },
        { filename: 'executive-summary.md', shouldFilter: false },
        { filename: 'bash-tutorial.md', shouldFilter: false },
        { filename: 'learn-powershell.md', shouldFilter: false },

        // Regular files - not filtered
        { filename: 'legitimate-agent.md', shouldFilter: false },
        { filename: 'production-skill.md', shouldFilter: false },
        { filename: 'user-template.md', shouldFilter: false }
      ];

      for (const testCase of testCases) {
        expect(portfolioManager.isTestElement(testCase.filename)).toBe(testCase.shouldFilter);
      }
    });
  });

  describe('integration edge cases', () => {
    it('should handle mixed legitimate and dangerous files correctly', async () => {
      const testDir = portfolioManager.getElementDir(ElementType.AGENT);

      // Create a mix of files - only dangerous patterns should be filtered
      const files = [
        { name: 'eval-attack.md', shouldFilter: true },
        { name: 'legitimate-agent.md', shouldFilter: false },
        { name: 'test-persona.md', shouldFilter: false },  // NOT filtered (Issue #287)
        { name: 'code-assistant.md', shouldFilter: false },
        { name: 'shell-injection.md', shouldFilter: true },
        { name: 'data-processor.md', shouldFilter: false }
      ];

      for (const file of files) {
        await fs.writeFile(path.join(testDir, file.name), `# ${file.name}\nContent for ${file.name}`);
      }

      // List elements through PortfolioManager
      const elements = await portfolioManager.listElements(ElementType.AGENT);

      // Verify filtering - only dangerous files should be filtered
      const expectedFiles = files.filter(f => !f.shouldFilter).map(f => f.name);
      expect(elements).toHaveLength(expectedFiles.length);

      for (const expectedFile of expectedFiles) {
        expect(elements).toContain(expectedFile);
      }

      // Verify dangerous files are filtered out
      const filteredFiles = files.filter(f => f.shouldFilter).map(f => f.name);
      for (const filteredFile of filteredFiles) {
        expect(elements).not.toContain(filteredFile);
      }
    });

    it('should work consistently across different element directories', async () => {
      const dangerousFileName = 'eval-dangerous.md';
      const safeFileName = 'safe-element.md';
      const testNamedFile = 'test-helper.md';  // Should NOT be filtered
      const elementTypes = [ElementType.AGENT, ElementType.SKILL, ElementType.TEMPLATE, ElementType.PERSONA];

      // Create files in each directory
      for (const elementType of elementTypes) {
        const elementDir = portfolioManager.getElementDir(elementType);
        await fs.writeFile(path.join(elementDir, dangerousFileName), '# Dangerous\nDangerous content');
        await fs.writeFile(path.join(elementDir, safeFileName), '# Safe\nSafe content');
        await fs.writeFile(path.join(elementDir, testNamedFile), '# Test Helper\nTest content');
      }

      // Verify consistent filtering across all directories
      for (const elementType of elementTypes) {
        const elements = await portfolioManager.listElements(elementType);
        expect(elements).toHaveLength(2);  // safe + test-named (both allowed)
        expect(elements).toContain(safeFileName);
        expect(elements).toContain(testNamedFile);  // Test names allowed (Issue #287)
        expect(elements).not.toContain(dangerousFileName);
      }
    });
  });
});
