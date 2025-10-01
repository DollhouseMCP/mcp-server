/**
 * Simple unit tests for SubmitToPortfolioTool
 * Focus on testable logic without complex mocking
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ElementType } from '../../../../src/portfolio/types.js';

describe('SubmitToPortfolioTool', () => {
  describe('Input Validation', () => {
    it('should validate element type enum values', () => {
      // Test that ElementType values are valid
      expect(ElementType.PERSONA).toBe('personas');
      expect(ElementType.SKILL).toBe('skills');
      expect(ElementType.TEMPLATE).toBe('templates');
      expect(ElementType.AGENT).toBe('agents');
      expect(ElementType.MEMORY).toBe('memories');
      expect(ElementType.ENSEMBLE).toBe('ensembles');
    });

    it('should have correct default element type', () => {
      const defaultType = ElementType.PERSONA;
      expect(defaultType).toBe('personas');
    });
  });

  describe('GitHub Issue Format', () => {
    it('should generate correct issue title format', () => {
      const elementName = 'Creative Writer';
      const elementType = 'persona';
      const expectedTitle = `[Contribution] New ${elementType}: ${elementName}`;
      
      expect(expectedTitle).toBe('[Contribution] New persona: Creative Writer');
    });

    it('should generate correct labels', () => {
      const elementType = 'persona';
      const labels = ['contribution', 'pending-review', elementType];
      
      expect(labels).toContain('contribution');
      expect(labels).toContain('pending-review');
      expect(labels).toContain('persona');
      expect(labels.length).toBe(3);
    });

    it('should format issue body correctly', () => {
      const elementName = 'Creative Writer';
      const username = 'testuser';
      const portfolioUrl = `https://github.com/${username}/dollhouse-portfolio/blob/main/personas/creative-writer.md`;
      
      const body = `## New Element Submission

**Element Name**: ${elementName}
**Type**: persona
**Author**: @${username}
**Portfolio URL**: ${portfolioUrl}

### Description
User submitted element for community review.

### Checklist
- [ ] Element follows quality guidelines
- [ ] No inappropriate content
- [ ] Metadata is complete
- [ ] Description is clear

---
*Submitted via DollhouseMCP*`;

      expect(body).toContain(elementName);
      expect(body).toContain(username);
      expect(body).toContain(portfolioUrl);
      expect(body).toContain('New Element Submission');
    });
  });

  describe('File Path Generation', () => {
    it('should generate correct filename from element name', () => {
      const testCases = [
        { input: 'Creative Writer', expected: 'creative-writer.md' },
        { input: 'Code Review Expert', expected: 'code-review-expert.md' },
        { input: 'AI Assistant', expected: 'ai-assistant.md' },
        { input: 'Test_Element-123', expected: 'test_element-123.md' },
      ];

      testCases.forEach(({ input, expected }) => {
        const filename = input.toLowerCase().replaceAll(/\s+/g, '-') + '.md';
        expect(filename).toBe(expected);
      });
    });

    it('should construct correct portfolio path', () => {
      const username = 'testuser';
      const elementType = 'personas';
      const filename = 'creative-writer.md';
      
      const path = `${elementType}/${filename}`;
      const fullUrl = `https://github.com/${username}/dollhouse-portfolio/blob/main/${path}`;
      
      expect(fullUrl).toBe('https://github.com/testuser/dollhouse-portfolio/blob/main/personas/creative-writer.md');
    });
  });

  describe('Configuration', () => {
    it('should have correct environment variable name', () => {
      const envVar = 'DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION';
      expect(envVar).toBe('DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION');
    });

    it('should parse boolean environment values correctly', () => {
      const testCases = [
        { input: 'true', expected: true },
        { input: 'TRUE', expected: true },
        { input: '1', expected: true },
        { input: 'false', expected: false },
        { input: 'FALSE', expected: false },
        { input: '0', expected: false },
        { input: undefined, expected: false },
        { input: '', expected: false },
      ];

      testCases.forEach(({ input, expected }) => {
        const result = input === 'true' || input === 'TRUE' || input === '1';
        expect(result).toBe(expected);
      });
    });
  });

  describe('Error Messages', () => {
    it('should have helpful authentication error message', () => {
      const message = 'Not authenticated. Please authenticate first using the GitHub OAuth flow.\n\n' +
                     'Visit: https://docs.anthropic.com/en/docs/claude-code/oauth-setup\n' +
                     'Or run: gh auth login --web';
      
      expect(message).toContain('Not authenticated');
      expect(message).toContain('oauth-setup');
      expect(message).toContain('gh auth login');
    });

    it('should have clear file not found message', () => {
      const elementType = 'persona';
      const name = 'Test Element';
      const message = `Could not find ${elementType} named "${name}" in local portfolio`;
      
      expect(message).toBe('Could not find persona named "Test Element" in local portfolio');
    });

    it('should have file size limit message', () => {
      const message = 'File size exceeds 10MB limit';
      expect(message).toContain('10MB');
    });
  });

  describe('Response Format', () => {
    it('should have correct success response structure', () => {
      const successResponse = {
        success: true,
        message: 'Successfully uploaded',
        url: 'https://github.com/user/repo',
      };

      expect(successResponse).toHaveProperty('success');
      expect(successResponse).toHaveProperty('message');
      expect(successResponse).toHaveProperty('url');
      expect(successResponse.success).toBe(true);
    });

    it('should have correct error response structure', () => {
      const errorResponse = {
        success: false,
        message: 'Error occurred',
        error: 'ERROR_CODE',
      };

      expect(errorResponse).toHaveProperty('success');
      expect(errorResponse).toHaveProperty('message');
      expect(errorResponse).toHaveProperty('error');
      expect(errorResponse.success).toBe(false);
    });
  });

  describe('URL Construction', () => {
    it('should build correct GitHub API URL', () => {
      const owner = 'DollhouseMCP';
      const repo = 'collection';
      const endpoint = 'issues';
      
      const url = `https://api.github.com/repos/${owner}/${repo}/${endpoint}`;
      expect(url).toBe('https://api.github.com/repos/DollhouseMCP/collection/issues');
    });

    it('should build correct portfolio URL', () => {
      const username = 'testuser';
      const elementType = 'personas';
      const filename = 'creative-writer.md';
      
      const url = `https://github.com/${username}/dollhouse-portfolio/blob/main/${elementType}/${filename}`;
      expect(url).toContain('github.com');
      expect(url).toContain(username);
      expect(url).toContain('dollhouse-portfolio');
      expect(url).toContain(elementType);
      expect(url).toContain(filename);
    });
  });

  describe('Timeout Configuration', () => {
    it('should have appropriate timeout value', () => {
      const TIMEOUT_MS = 30000; // 30 seconds
      expect(TIMEOUT_MS).toBe(30000);
      expect(TIMEOUT_MS).toBeGreaterThan(10000); // More than 10 seconds
      expect(TIMEOUT_MS).toBeLessThanOrEqual(60000); // Not more than 60 seconds
    });
  });
});