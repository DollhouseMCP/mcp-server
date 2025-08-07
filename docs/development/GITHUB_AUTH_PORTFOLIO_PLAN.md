# GitHub OAuth + Portfolio-Based Submission System

**Date**: August 6, 2025  
**Status**: Planning Complete, Ready for Implementation  
**Priority**: High - Blocking user submissions  

## Executive Summary

We're implementing a portfolio-based submission system that solves multiple problems:
- GitHub URL size limits (8KB max)
- User content ownership and backup
- Smooth authentication experience
- Clean review workflow

Users will have their own GitHub portfolio repositories for their DollhouseMCP content, enabling both personal backup and community submissions.

## Problem Analysis

### Current Issues
1. **Missing OAuth App**: System requires `DOLLHOUSE_GITHUB_CLIENT_ID` environment variable but no app registered
2. **URL Size Limits**: Current submission via URL can only handle ~5KB personas before truncation
3. **Poor UX**: Users get authentication errors with broken documentation links
4. **No Backup**: Users have no cloud backup of their local content

### Size Constraints
- GitHub URL limit: 8,192 bytes
- URL encoding overhead: ~40% increase
- Largest current persona: 5,365 bytes (99% of limit!)
- Future elements could be much larger

## Solution Architecture

### Core Components

#### 1. GitHub OAuth App
- **Type**: OAuth App (not GitHub App)
- **Flow**: Device Flow (perfect for CLI/desktop)
- **Client ID**: Public, safe to hardcode
- **No Secret Required**: Device flow doesn't need client secret

#### 2. Personal Portfolio Repositories
- **Name Format**: `{username}/dollhouse-portfolio`
- **Structure**: Mirrors local portfolio folders
- **Creation**: Only when user chooses to submit/backup
- **Privacy**: User's choice (public/private)

#### 3. Submission Workflow
```
Local Content → Portfolio Repo → Collection Issue → Review → Merge
```

## Implementation Plan

### Phase 1: OAuth Setup (Day 1 Morning)

#### 1.1 Register OAuth App
```
1. Navigate to: https://github.com/settings/developers
2. Click "New OAuth App"
3. Fill in:
   - Application name: DollhouseMCP
   - Homepage URL: https://github.com/DollhouseMCP/mcp-server
   - Authorization callback URL: http://localhost:3000/callback (unused)
4. After creation:
   - Enable Device Flow (checkbox in settings)
   - Copy Client ID
```

#### 1.2 Update GitHubAuthManager
```typescript
// src/auth/GitHubAuthManager.ts
export class GitHubAuthManager {
  // Hardcode the public Client ID (safe for device flow)
  private static readonly CLIENT_ID = process.env.DOLLHOUSE_GITHUB_CLIENT_ID || 
    'Ov23liXXXXXXXXXXXXXX'; // Actual ID from registration
```

#### 1.3 Fix Error Messages
```typescript
if (!GitHubAuthManager.CLIENT_ID) {
  throw new Error(
    'GitHub OAuth is not configured. This should not happen. ' +
    'Please report this issue at: https://github.com/DollhouseMCP/mcp-server/issues'
  );
}
```

### Phase 2: Portfolio Repository Manager (Day 1 Afternoon)

#### 2.1 Create PortfolioRepoManager Class
```typescript
// src/portfolio/PortfolioRepoManager.ts
export class PortfolioRepoManager {
  private octokit: Octokit;
  
  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
  }
  
  async ensurePortfolioExists(username: string): Promise<string> {
    // Check if repo exists
    // Create if not
    // Return repo URL
  }
  
  async saveElement(element: Element, path: string): Promise<string> {
    // Commit element to portfolio
    // Return GitHub URL
  }
}
```

#### 2.2 Portfolio Structure
```
dollhouse-portfolio/
├── README.md           # Auto-generated with instructions
├── personas/          # Persona elements
│   └── creative-writer.md
├── skills/           # Skill elements
├── templates/        # Template elements
├── agents/          # Agent elements
├── memories/        # Memory elements
└── ensembles/       # Ensemble elements
```

#### 2.3 README Template
```markdown
# My DollhouseMCP Portfolio

This repository contains my personal collection of DollhouseMCP elements.

## What is this?
This is your personal backup and portfolio of AI customization elements created with DollhouseMCP.

## How to use
1. **Local sync**: Clone this repo to use elements locally
2. **Share**: Share your portfolio URL with others
3. **Submit**: Elements here can be submitted to the community collection

## Structure
- `personas/` - AI personality profiles
- `skills/` - Specialized capabilities
- `templates/` - Reusable content structures
- `agents/` - Autonomous assistants
- `memories/` - Persistent context
- `ensembles/` - Combined element groups

---
*Created by [DollhouseMCP](https://github.com/DollhouseMCP/mcp-server)*
```

### Phase 3: Submission Flow Update (Day 2 Morning)

#### 3.1 Update PersonaSubmitter
```typescript
export class PersonaSubmitter {
  private portfolioManager: PortfolioRepoManager;
  
  async submitToCollection(element: Element): Promise<SubmissionResult> {
    // 1. Ensure portfolio exists
    const portfolioUrl = await this.portfolioManager.ensurePortfolioExists();
    
    // 2. Save to portfolio
    const elementUrl = await this.portfolioManager.saveElement(element);
    
    // 3. Create collection issue
    const issue = await this.createCollectionIssue(element, elementUrl);
    
    return { portfolioUrl, elementUrl, issueUrl: issue.html_url };
  }
}
```

#### 3.2 Issue Format
```markdown
## Submission: Creative Writer

**Submitted by**: @username
**Portfolio Link**: https://github.com/username/dollhouse-portfolio/blob/main/personas/creative-writer.md
**Type**: Persona
**Version**: 1.0.0

### Content Preview
```markdown
[First 500 chars of content]
```

### Metadata
- Author: username
- Category: Creative
- Created: 2025-08-06

### Review Checklist
- [ ] Content appropriate
- [ ] No security issues
- [ ] Metadata complete
- [ ] Tests pass

---
View full content in [user's portfolio](portfolio-link)
```

### Phase 4: User Experience (Day 2 Afternoon)

#### 4.1 Authentication Flow
```
User: "submit my Creative Writer persona"
System: "To submit content, you'll need to connect to GitHub."

[If not authenticated]
System: "Let's set up GitHub authentication:
1. Visit: https://github.com/login/device
2. Enter code: XXXX-XXXX
3. Authorize DollhouseMCP"

[After auth]
System: "✅ Connected as @username"
```

#### 4.2 Portfolio Creation Flow
```
[First submission]
System: "I'll create a portfolio repository for your content.
This will:
- Backup your elements to GitHub
- Enable sharing with others
- Allow submissions to the community

Create portfolio? (y/n)"

[User confirms]
System: "✅ Created: github.com/username/dollhouse-portfolio"
```

#### 4.3 Submission Success
```
System: "✅ Success!
- Saved to portfolio: [github-url]
- Submitted for review: [issue-url]
- Review time: 2-3 business days"
```

### Phase 5: Documentation Updates (Day 2 End)

#### 5.1 README.md Updates
- Add `## GitHub Authentication` section
- Document OAuth setup process
- Explain portfolio system
- Include troubleshooting

#### 5.2 User Guides
- `docs/GITHUB_AUTH_GUIDE.md`
- `docs/PORTFOLIO_GUIDE.md`
- `docs/SUBMISSION_GUIDE.md`

## Technical Decisions

### Why OAuth Device Flow?
- No client secret needed
- Works in CLI/desktop apps
- Simple magic code UX
- Secure token storage

### Why Personal Portfolios?
- User owns their content
- Natural backup solution
- Enables sharing/discovery
- No size limits
- Git versioning

### Why Issues for Review?
- Lower barrier than PRs
- Discussion before merge
- Simpler API calls
- Better for non-developers

## Security Considerations

1. **Token Storage**: OS keychain via TokenManager
2. **Scopes**: Minimal - `public_repo`, `read:user`
3. **Rate Limiting**: Existing 5/hour submission limit
4. **Content Validation**: Before portfolio save
5. **No Secrets**: Client ID is public for device flow

## Migration Path

### For Existing Users
- No breaking changes
- OAuth optional until they submit
- Local content untouched
- Anonymous browsing still works

### Future Enhancement Path
1. **Now**: OAuth + Portfolio + Issues
2. **Phase 2**: Automated PR creation from approved issues
3. **Phase 3**: dollhousemcp.com with database backend

## Success Metrics

- [ ] OAuth authentication works smoothly
- [ ] Portfolio repos created successfully
- [ ] Submissions include portfolio links
- [ ] No more URL size limits
- [ ] Users report positive experience

## Testing Plan

1. **OAuth Flow**: Test with real GitHub account
2. **Portfolio Creation**: Verify structure and permissions
3. **Submission**: End-to-end test with various sizes
4. **Error Handling**: Network failures, auth issues
5. **Documentation**: User can follow without help

## Rollback Plan

If issues arise:
1. Revert to anonymous submission with URL
2. Document known size limitations
3. Provide manual submission instructions
4. Fix issues and retry

## Next Session Starting Points

```bash
# Day 1 Morning
- Register OAuth app on GitHub
- Update GitHubAuthManager with Client ID
- Test OAuth device flow

# Day 1 Afternoon  
- Create PortfolioRepoManager class
- Implement portfolio creation
- Add element saving

# Day 2 Morning
- Update PersonaSubmitter
- Integrate portfolio with submissions
- Test end-to-end flow

# Day 2 Afternoon
- Update documentation
- Create user guides
- Final testing
```

## Questions for Tomorrow

1. Should portfolios be public or private by default?
2. Should we auto-create portfolio on first submission?
3. How to handle users who delete their portfolio?
4. Should we support multiple portfolios?

---

*This plan provides a complete path from current broken state to a robust, user-friendly submission system that scales beyond current limitations.*