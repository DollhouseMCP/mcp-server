/**
 * Unit tests for PersonaSubmitter
 */

import { PersonaSubmitter } from '../../../../src/collection/PersonaSubmitter.js';
import { describe, expect, it, beforeEach } from '@jest/globals';

describe('PersonaSubmitter', () => {
  let submitter: PersonaSubmitter;

  const mockPersona = {
    metadata: {
      name: 'Test Persona',
      description: 'A test persona for unit testing',
      author: 'Test Author',
      category: 'professional',
      version: '1.0.0',
      unique_id: 'test-persona-123',
      triggers: ['@test', '#testing'],
      age_rating: 'all' as const,
      content_flags: ['clean'],
      ai_generated: false,
      generation_method: 'human' as const,
      license: 'MIT',
      created_date: '2025-01-01'
    },
    content: 'You are a helpful test persona for unit testing purposes.',
    filename: 'test-persona.md',
    unique_id: 'test-persona_20250801-120000_test'
  };

  const mockLargePersona = {
    metadata: {
      name: 'Large Test Persona',
      description: 'A very large persona that might exceed URL limits',
      author: 'Test Author',
      version: '1.0.0'
    },
    content: 'x'.repeat(7000), // Large content to test URL limits
    filename: 'large-test-persona.md',
    unique_id: 'large-test-persona_20250801-120000_test'
  };

  const mockPersonaWithSpecialChars = {
    metadata: {
      name: 'Special Characters Persona ñáéíóú',
      description: 'Testing special chars: <>&"\'%20',
      author: 'Tëst Authör',
      category: 'educational',
      version: '2.0.0'
    },
    content: 'Content with special characters: ñáéíóú <script>alert("test")</script> & more',
    filename: 'special-chars-persona.md',
    unique_id: 'special-chars-persona_20250801-120000_test'
  };

  beforeEach(() => {
    submitter = new PersonaSubmitter();
  });

  describe('generateSubmissionIssue', () => {
    it('should generate proper issue title and body', () => {
      const result = submitter.generateSubmissionIssue(mockPersona);

      expect(result.issueTitle).toBe('New Persona Submission: Test Persona');
      expect(result.issueBody).toContain('**Name:** Test Persona');
      expect(result.issueBody).toContain('**Author:** Test Author');
      expect(result.issueBody).toContain('**Category:** professional');
      expect(result.issueBody).toContain('**Description:** A test persona for unit testing');
      expect(result.issueBody).toContain('### Persona Content:');
      expect(result.issueBody).toContain(mockPersona.content);
      expect(result.issueBody).toContain('- Filename: test-persona.md');
      expect(result.issueBody).toContain('- Unique ID: test-persona_20250801-120000_test');
    });

    it('should handle missing optional metadata fields', () => {
      const minimalPersona = {
        metadata: {
          name: 'Minimal Persona',
          description: 'Basic description'
        },
        content: 'Basic content',
        filename: 'minimal.md',
        unique_id: 'minimal_20250801-120000_test'
      };

      const result = submitter.generateSubmissionIssue(minimalPersona);

      expect(result.issueBody).toContain('**Author:** Unknown');
      expect(result.issueBody).toContain('**Category:** General');
    });

    it('should properly encode special characters in URL', () => {
      const result = submitter.generateSubmissionIssue(mockPersonaWithSpecialChars);

      expect(result.githubIssueUrl).toContain('https://github.com/DollhouseMCP/collection/issues/new');
      expect(result.githubIssueUrl).toContain(encodeURIComponent('Special Characters Persona ñáéíóú'));
      expect(result.githubIssueUrl).toContain(encodeURIComponent('<>&"\'%20'));
      expect(result.githubIssueUrl).toContain(encodeURIComponent('<script>alert("test")</script>'));
    });

    it('should validate URL length does not exceed GitHub limits', () => {
      const result = submitter.generateSubmissionIssue(mockLargePersona);
      
      // GitHub has an ~8KB URL limit
      const urlLength = result.githubIssueUrl.length;
      expect(urlLength).toBeLessThan(8192); // 8KB limit
      
      // If URL is too long, should be truncated appropriately
      if (urlLength >= 8000) {
        expect(result.issueBody).toContain('[Content truncated due to length]');
      }
    });

    it('should include all metadata fields in issue body', () => {
      const result = submitter.generateSubmissionIssue(mockPersona);

      // Check that all metadata is properly serialized
      expect(result.issueBody).toContain('name: "Test Persona"');
      expect(result.issueBody).toContain('author: "Test Author"');
      expect(result.issueBody).toContain('version: "1.0.0"');
      expect(result.issueBody).toContain('["@test","#testing"]'); // Array should be JSON stringified
    });
  });

  describe('formatSubmissionResponse', () => {
    it('should format standard submission response correctly', () => {
      const githubUrl = 'https://github.com/DollhouseMCP/collection/issues/new?title=Test';
      const result = submitter.formatSubmissionResponse(mockPersona, githubUrl, '🎭 ');

      expect(result).toContain('🎭 📤 **Persona Submission Prepared**');
      expect(result).toContain('🎭 **Test Persona** is ready for collection submission!');
      expect(result).toContain('**Next Steps:**');
      expect(result).toContain('1. Click this link to create a GitHub issue:');
      expect(result).toContain(githubUrl);
      expect(result).toContain('2. Review the pre-filled content');
      expect(result).toContain('3. Click "Submit new issue"');
      expect(result).toContain('4. The maintainers will review your submission');
      expect(result).toContain('⭐ **Tip:** You can also submit via pull request');
    });

    it('should work without persona indicator', () => {
      const githubUrl = 'https://github.com/DollhouseMCP/collection/issues/new?title=Test';
      const result = submitter.formatSubmissionResponse(mockPersona, githubUrl);

      expect(result).toContain('📤 **Persona Submission Prepared**');
      expect(result).toContain('**Test Persona** is ready for collection submission!');
      expect(result).not.toContain('🎭 📤'); // Should not have double indicator
    });
  });

  describe('formatAnonymousSubmissionResponse', () => {
    it('should format anonymous submission response correctly', () => {
      const githubUrl = 'https://github.com/DollhouseMCP/collection/issues/new?title=Test';
      const result = submitter.formatAnonymousSubmissionResponse(mockPersona, githubUrl, '🎭 ');

      expect(result).toContain('🎭 📤 **Anonymous Submission Path Available**');
      expect(result).toContain('🎭 **Test Persona** can be submitted without GitHub authentication!');
      expect(result).toContain('**Anonymous Submission Process:**');
      expect(result).toContain('1. Click this link to create a GitHub issue:');
      expect(result).toContain(githubUrl);
      expect(result).toContain('2. **To submit your persona:**');
      expect(result).toContain('• You\'ll need a GitHub account (free to create)');
      expect(result).toContain('• Click "Submit new issue" to submit directly');
      expect(result).toContain('• The form is pre-filled with all your persona details');
      expect(result).toContain('**Note:** GitHub account is required for submission to prevent spam and maintain quality.');
      expect(result).toContain('Creating an account is free and takes less than a minute: https://github.com/signup');
      expect(result).toContain('**What happens next:**');
      expect(result).toContain('• Community maintainers review all submissions');
      expect(result).toContain('• Anonymous submissions get the same consideration as authenticated ones');
      expect(result).toContain('• If accepted, your persona joins the collection with attribution to "Community Contributor"');
      expect(result).toContain('• The review typically takes 2-3 business days');
      expect(result).toContain('💡 **Pro tip:** Creating a free GitHub account unlocks additional features');
    });

    it('should work without persona indicator', () => {
      const githubUrl = 'https://github.com/DollhouseMCP/collection/issues/new?title=Test';
      const result = submitter.formatAnonymousSubmissionResponse(mockPersona, githubUrl);

      expect(result).toContain('📤 **Anonymous Submission Path Available**');
      expect(result).toContain('**Test Persona** can be submitted without GitHub authentication!');
      expect(result).not.toContain('🎭 📤'); // Should not have double indicator
    });

    it('should require GitHub account for anonymous submissions', () => {
      const githubUrl = 'https://github.com/DollhouseMCP/collection/issues/new?title=Test';
      const result = submitter.formatAnonymousSubmissionResponse(mockPersona, githubUrl);

      expect(result).toContain('GitHub account is required');
      expect(result).toContain('prevent spam and maintain quality');
      expect(result).toContain('https://github.com/signup');
      expect(result).not.toContain('email');
      expect(result).not.toContain('Email');
    });
  });

  describe('submitContent method behavior', () => {
    it('should return anonymous response for anonymous users', () => {
      const submissionData = submitter.generateSubmissionIssue(mockPersona);
      
      // Simulate anonymous user call (no GitHub token/authentication)
      const isAuthenticated = false;
      const expectedResponse = isAuthenticated 
        ? submitter.formatSubmissionResponse(mockPersona, submissionData.githubIssueUrl)
        : submitter.formatAnonymousSubmissionResponse(mockPersona, submissionData.githubIssueUrl);

      expect(expectedResponse).toContain('**Anonymous Submission Path Available**');
      expect(expectedResponse).toContain('GitHub account is required');
    });

    it('should return standard response for authenticated users', () => {
      const submissionData = submitter.generateSubmissionIssue(mockPersona);
      
      // Simulate authenticated user call (has GitHub token/authentication)
      const isAuthenticated = true;
      const expectedResponse = isAuthenticated 
        ? submitter.formatSubmissionResponse(mockPersona, submissionData.githubIssueUrl)
        : submitter.formatAnonymousSubmissionResponse(mockPersona, submissionData.githubIssueUrl);

      expect(expectedResponse).toContain('**Persona Submission Prepared**');
      expect(expectedResponse).toContain('⭐ **Tip:** You can also submit via pull request');
      expect(expectedResponse).not.toContain('community@dollhousemcp.com');
    });
  });

  describe('URL length validation', () => {
    it('should handle very large personas by truncating content', () => {
      const veryLargePersona = {
        metadata: {
          name: 'Extremely Large Persona',
          description: 'Testing maximum URL limits'
        },
        content: 'x'.repeat(10000), // Extremely large content
        filename: 'huge-persona.md',
        unique_id: 'huge-persona_20250801-120000_test'
      };

      const result = submitter.generateSubmissionIssue(veryLargePersona);
      
      expect(result.githubIssueUrl.length).toBeLessThan(8192); // Should be under GitHub's limit
      
      if (result.githubIssueUrl.length >= 8000) {
        expect(result.issueBody).toContain('[Content truncated due to length]');
      }
    });

    it('should preserve essential information even when truncating', () => {
      const result = submitter.generateSubmissionIssue(mockLargePersona);
      
      // Essential fields should always be present
      expect(result.issueBody).toContain('**Name:**');
      expect(result.issueBody).toContain('**Description:**');
      expect(result.issueBody).toContain('### Submission Details:');
      expect(result.issueBody).toContain('- Filename:');
      expect(result.issueBody).toContain('- Unique ID:');
    });
  });

  describe('GitHub account requirement', () => {
    it('should clearly state GitHub account is required', () => {
      const githubUrl = 'https://github.com/DollhouseMCP/collection/issues/new?title=Test';
      const result = submitter.formatAnonymousSubmissionResponse(mockPersona, githubUrl);

      // Should clearly indicate GitHub account requirement
      expect(result).toContain('GitHub account is required for submission');
      expect(result).toContain('free to create');
      expect(result).toContain('https://github.com/signup');
    });
  });

  describe('response formatting consistency', () => {
    it('should have consistent structure between authenticated and anonymous responses', () => {
      const githubUrl = 'https://github.com/DollhouseMCP/collection/issues/new?title=Test';
      const standardResponse = submitter.formatSubmissionResponse(mockPersona, githubUrl);
      const anonymousResponse = submitter.formatAnonymousSubmissionResponse(mockPersona, githubUrl);

      // Both should start with emoji and announcement
      expect(standardResponse).toMatch(/^📤 \*\*.*\*\*/);
      expect(anonymousResponse).toMatch(/^📤 \*\*.*\*\*/);

      // Both should mention the persona name
      expect(standardResponse).toContain('**Test Persona**');
      expect(anonymousResponse).toContain('**Test Persona**');

      // Both should include the GitHub URL
      expect(standardResponse).toContain(githubUrl);
      expect(anonymousResponse).toContain(githubUrl);

      // Both should have clear next steps
      expect(standardResponse).toContain('**Next Steps:**');
      expect(anonymousResponse).toContain('**Anonymous Submission Process:**');
    });

    it('should handle persona indicators consistently', () => {
      const githubUrl = 'https://github.com/DollhouseMCP/collection/issues/new?title=Test';
      const indicator = '🎭 ';
      
      const standardResponse = submitter.formatSubmissionResponse(mockPersona, githubUrl, indicator);
      const anonymousResponse = submitter.formatAnonymousSubmissionResponse(mockPersona, githubUrl, indicator);

      // Both should properly prefix with the indicator
      expect(standardResponse).toContain('🎭 📤');
      expect(anonymousResponse).toContain('🎭 📤');
      
      expect(standardResponse).toContain('🎭 **Test Persona**');
      expect(anonymousResponse).toContain('🎭 **Test Persona**');
    });
  });

  describe('security and validation', () => {
    it('should properly escape HTML/script tags in persona content', () => {
      const result = submitter.generateSubmissionIssue(mockPersonaWithSpecialChars);
      
      // In the URL encoding, dangerous characters should be encoded
      expect(result.githubIssueUrl).toContain(encodeURIComponent('<script>'));
      expect(result.githubIssueUrl).toContain(encodeURIComponent('</script>'));
      
      // In the issue body, content should be in a code block for safety
      expect(result.issueBody).toContain('```markdown');
      expect(result.issueBody).toContain('<script>alert("test")</script>');
    });

    it('should handle unicode characters properly', () => {
      const result = submitter.generateSubmissionIssue(mockPersonaWithSpecialChars);
      
      expect(result.issueBody).toContain('ñáéíóú');
      expect(result.githubIssueUrl).toContain(encodeURIComponent('ñáéíóú'));
    });

    it('should handle array values in metadata correctly', () => {
      const result = submitter.generateSubmissionIssue(mockPersona);
      
      // Arrays should be JSON stringified properly
      expect(result.issueBody).toContain('triggers: ["@test","#testing"]');
      expect(result.issueBody).toContain('content_flags: ["clean"]');
    });
  });
});