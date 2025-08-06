/**
 * Submit personas to the collection
 */

import { Persona } from '../types/persona.js';

export class PersonaSubmitter {
  /**
   * Generate GitHub issue for persona submission
   */
  generateSubmissionIssue(persona: Persona): { 
    issueTitle: string; 
    issueBody: string; 
    githubIssueUrl: string 
  } {
    const issueTitle = `New Persona Submission: ${persona.metadata.name}`;
    const issueBody = `## Persona Submission

**Name:** ${persona.metadata.name}
**Author:** ${persona.metadata.author || 'Unknown'}
**Category:** ${persona.metadata.category || 'General'}
**Description:** ${persona.metadata.description}

### Persona Content:
\`\`\`markdown
---
${Object.entries(persona.metadata)
  .map(([key, value]) => `${key}: ${Array.isArray(value) ? JSON.stringify(value) : JSON.stringify(value)}`)
  .join('\n')}
---

${persona.content}
\`\`\`

### Submission Details:
- Submitted via DollhouseMCP client
- Filename: ${persona.filename}
- Unique ID: ${persona.unique_id}

---
*Please review this persona for inclusion in the collection.*`;
    
    const githubIssueUrl = `https://github.com/DollhouseMCP/collection/issues/new?title=${encodeURIComponent(issueTitle)}&body=${encodeURIComponent(issueBody)}`;
    
    return {
      issueTitle,
      issueBody,
      githubIssueUrl
    };
  }
  
  /**
   * Format submission response
   */
  formatSubmissionResponse(persona: Persona, githubIssueUrl: string, personaIndicator: string = ''): string {
    return `${personaIndicator}📤 **Persona Submission Prepared**\n\n` +
      `🎭 **${persona.metadata.name}** is ready for collection submission!\n\n` +
      `**Next Steps:**\n` +
      `1. Click this link to create a GitHub issue: \n` +
      `   ${githubIssueUrl}\n\n` +
      `2. Review the pre-filled content\n` +
      `3. Click "Submit new issue"\n` +
      `4. The maintainers will review your submission\n\n` +
      `⭐ **Tip:** You can also submit via pull request if you're familiar with Git!`;
  }
  
  /**
   * Format anonymous submission response
   */
  formatAnonymousSubmissionResponse(persona: Persona, githubIssueUrl: string, personaIndicator: string = ''): string {
    return `${personaIndicator}📤 **Anonymous Submission Path Available**\n\n` +
      `🎭 **${persona.metadata.name}** can be submitted without GitHub authentication!\n\n` +
      `**Anonymous Submission Process:**\n` +
      `1. Click this link to create a GitHub issue (no account needed for viewing):\n` +
      `   ${githubIssueUrl}\n\n` +
      `2. **If you have a GitHub account:**\n` +
      `   • Click "Submit new issue" to submit directly\n\n` +
      `3. **If you don't have a GitHub account:**\n` +
      `   • Copy the pre-filled content from the form\n` +
      `   • Email it to: community@dollhousemcp.com\n` +
      `   • Include "Anonymous Submission" in the subject line\n\n` +
      `**What happens next:**\n` +
      `• Community maintainers review all submissions\n` +
      `• Anonymous submissions get the same consideration as authenticated ones\n` +
      `• If accepted, your persona joins the collection with attribution to "Community Contributor"\n` +
      `• The review typically takes 2-3 business days\n\n` +
      `💡 **Pro tip:** Creating a free GitHub account unlocks additional features, but it's completely optional for submissions!`;
  }
}