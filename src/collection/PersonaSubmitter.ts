/**
 * Submit personas to the collection
 * Handles both authenticated and anonymous submission workflows
 */

import { Persona } from '../types/persona.js';

// Configuration constants
const GITHUB_URL_LIMIT = 8192; // GitHub's URL length limit (~8KB)
const COLLECTION_REPO_OWNER = 'DollhouseMCP';
const COLLECTION_REPO_NAME = 'collection';
const COMMUNITY_EMAIL = process.env.COMMUNITY_EMAIL || 'community@dollhousemcp.com';

// Common response components
const RESPONSE_COMPONENTS = {
  SUBMISSION_ICON: '📤',
  PERSONA_ICON: '🎭',
  TIP_ICON: '⭐',
  PRO_TIP_ICON: '💡'
} as const;

export class PersonaSubmitter {
  /**
   * Generate GitHub issue for persona submission
   * Includes URL length validation to comply with GitHub's ~8KB limit
   */
  generateSubmissionIssue(persona: Persona): { 
    issueTitle: string; 
    issueBody: string; 
    githubIssueUrl: string 
  } {
    const issueTitle = `New Persona Submission: ${persona.metadata.name}`;
    let issueBody = this.buildIssueBody(persona);
    
    // Check URL length and truncate if necessary
    let githubIssueUrl = this.buildGitHubIssueUrl(issueTitle, issueBody);
    
    // If URL exceeds GitHub's limit, truncate the content
    if (githubIssueUrl.length >= GITHUB_URL_LIMIT) {
      issueBody = this.buildTruncatedIssueBody(persona);
      githubIssueUrl = this.buildGitHubIssueUrl(issueTitle, issueBody);
    }
    
    return {
      issueTitle,
      issueBody,
      githubIssueUrl
    };
  }
  
  /**
   * Format submission response for authenticated users
   */
  formatSubmissionResponse(persona: Persona, githubIssueUrl: string, personaIndicator: string = ''): string {
    const header = this.buildResponseHeader(
      'Persona Submission Prepared',
      persona.metadata.name,
      'is ready for collection submission!',
      personaIndicator
    );
    
    const steps = this.buildStandardSubmissionSteps(githubIssueUrl);
    const tip = `${RESPONSE_COMPONENTS.TIP_ICON} **Tip:** You can also submit via pull request if you're familiar with Git!`;
    
    return `${header}\n\n${steps}\n\n${tip}`;
  }
  
  /**
   * Format anonymous submission response for unauthenticated users
   */
  formatAnonymousSubmissionResponse(persona: Persona, githubIssueUrl: string, personaIndicator: string = ''): string {
    const header = this.buildResponseHeader(
      'Anonymous Submission Path Available',
      persona.metadata.name,
      'can be submitted without GitHub authentication!',
      personaIndicator
    );
    
    const process = this.buildAnonymousSubmissionProcess(githubIssueUrl);
    const nextSteps = this.buildAnonymousNextSteps();
    const proTip = `${RESPONSE_COMPONENTS.PRO_TIP_ICON} **Pro tip:** Creating a free GitHub account unlocks additional features, but it's completely optional for submissions!`;
    
    return `${header}\n\n${process}\n\n${nextSteps}\n\n${proTip}`;
  }

  // Private helper methods for building response components

  /**
   * Build the full issue body with all persona details
   */
  private buildIssueBody(persona: Persona): string {
    return `## Persona Submission\n\n` +
      `**Name:** ${persona.metadata.name}\n` +
      `**Author:** ${persona.metadata.author || 'Unknown'}\n` +
      `**Category:** ${persona.metadata.category || 'General'}\n` +
      `**Description:** ${persona.metadata.description}\n\n` +
      `### Persona Content:\n` +
      `\`\`\`markdown\n` +
      `---\n` +
      `${this.serializeMetadata(persona.metadata)}\n` +
      `---\n\n` +
      `${persona.content}\n` +
      `\`\`\`\n\n` +
      `### Submission Details:\n` +
      `- Submitted via DollhouseMCP client\n` +
      `- Filename: ${persona.filename}\n` +
      `- Unique ID: ${persona.unique_id}\n\n` +
      `---\n` +
      `*Please review this persona for inclusion in the collection.*`;
  }

  /**
   * Build a truncated issue body to fit within URL limits
   */
  private buildTruncatedIssueBody(persona: Persona): string {
    const truncatedContent = persona.content.length > 500 
      ? `${persona.content.substring(0, 500)}...\n\n[Content truncated due to length]`
      : persona.content;
    
    return `## Persona Submission\n\n` +
      `**Name:** ${persona.metadata.name}\n` +
      `**Author:** ${persona.metadata.author || 'Unknown'}\n` +
      `**Category:** ${persona.metadata.category || 'General'}\n` +
      `**Description:** ${persona.metadata.description}\n\n` +
      `### Persona Content (Truncated):\n` +
      `\`\`\`markdown\n` +
      `---\n` +
      `${this.serializeMetadata(persona.metadata)}\n` +
      `---\n\n` +
      `${truncatedContent}\n` +
      `\`\`\`\n\n` +
      `### Submission Details:\n` +
      `- Submitted via DollhouseMCP client\n` +
      `- Filename: ${persona.filename}\n` +
      `- Unique ID: ${persona.unique_id}\n\n` +
      `---\n` +
      `*Please review this persona for inclusion in the collection.*`;
  }

  /**
   * Serialize persona metadata to YAML format
   */
  private serializeMetadata(metadata: any): string {
    return Object.entries(metadata)
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? JSON.stringify(value) : JSON.stringify(value)}`)
      .join('\n');
  }

  /**
   * Build the GitHub issue URL
   */
  private buildGitHubIssueUrl(title: string, body: string): string {
    return `https://github.com/${COLLECTION_REPO_OWNER}/${COLLECTION_REPO_NAME}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  }

  /**
   * Build common response header used by both authenticated and anonymous responses
   */
  private buildResponseHeader(title: string, personaName: string, subtitle: string, personaIndicator: string): string {
    return `${personaIndicator}${RESPONSE_COMPONENTS.SUBMISSION_ICON} **${title}**\n\n` +
      `${RESPONSE_COMPONENTS.PERSONA_ICON} **${personaName}** ${subtitle}`;
  }

  /**
   * Build standard submission steps for authenticated users
   */
  private buildStandardSubmissionSteps(githubIssueUrl: string): string {
    return `**Next Steps:**\n` +
      `1. Click this link to create a GitHub issue: \n` +
      `   ${githubIssueUrl}\n\n` +
      `2. Review the pre-filled content\n` +
      `3. Click "Submit new issue"\n` +
      `4. The maintainers will review your submission`;
  }

  /**
   * Build anonymous submission process instructions
   */
  private buildAnonymousSubmissionProcess(githubIssueUrl: string): string {
    return `**Anonymous Submission Process:**\n` +
      `1. Click this link to create a GitHub issue (no account needed for viewing):\n` +
      `   ${githubIssueUrl}\n\n` +
      `2. **If you have a GitHub account:**\n` +
      `   • Click "Submit new issue" to submit directly\n\n` +
      `3. **If you don't have a GitHub account:**\n` +
      `   • Copy the pre-filled content from the form\n` +
      `   • Email it to: ${COMMUNITY_EMAIL}\n` +
      `   • Include "Anonymous Submission" in the subject line`;
  }

  /**
   * Build anonymous submission next steps and expectations
   */
  private buildAnonymousNextSteps(): string {
    return `**What happens next:**\n` +
      `• Community maintainers review all submissions\n` +
      `• Anonymous submissions get the same consideration as authenticated ones\n` +
      `• If accepted, your persona joins the collection with attribution to "Community Contributor"\n` +
      `• The review typically takes 2-3 business days`;
  }
}