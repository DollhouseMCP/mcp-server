# Generic GitHub Manager - Future Enhancement

## Summary
Create a generic, reusable GitHub manager that can work with any GitHub repository, not just specific ones like collection or portfolio. This would support users who want to manage multiple portfolios (work, personal, project-specific).

## Background
Currently, we have two separate GitHub clients:
1. `GitHubClient` - Designed for the public collection repository
2. `PortfolioRepoManager` - Designed for personal portfolio repositories

This separation caused confusion and bugs (see QA report 09-08-25-001 and 002) where the wrong client was used for portfolio operations.

## Proposed Solution

### Option 1: Generic GitHubManager Class
Create a single, configurable GitHub manager that can work with any repository:

```typescript
class GitHubManager {
  constructor(
    private repoContext: 'collection' | 'portfolio' | 'custom',
    private repoOwner?: string,
    private repoName?: string
  ) {}
  
  async fetchFromGitHub(path: string): Promise<any> {
    // Handle authentication based on context
    // Use appropriate error messages based on context
    // Support different repository structures
  }
}
```

### Option 2: Repository Factory Pattern
Create a factory that returns the appropriate client based on context:

```typescript
class GitHubRepositoryFactory {
  static create(type: 'collection' | 'portfolio', config?: RepoConfig): IGitHubRepository {
    switch(type) {
      case 'collection':
        return new CollectionRepository();
      case 'portfolio':
        return new PortfolioRepository(config);
    }
  }
}
```

## Benefits

1. **Multiple Portfolio Support**: Users could manage separate portfolios for:
   - Personal projects
   - Work/professional elements
   - Client-specific configurations
   - Testing/experimental elements

2. **Cleaner Architecture**: Single source of truth for GitHub API interactions

3. **Reduced Confusion**: No more mixing up which client to use

4. **Better Error Messages**: Context-aware error messages

5. **Easier Testing**: Mock a single interface instead of multiple clients

## Use Cases

### Use Case 1: Professional Developer
- Has a work portfolio at `company/team-dollhouse-portfolio`
- Has a personal portfolio at `username/personal-dollhouse-portfolio`
- Wants to switch between them easily

### Use Case 2: Consultant
- Maintains separate portfolios for each client
- Needs to isolate elements between projects
- Wants to sync specific elements between portfolios

### Use Case 3: Team Collaboration
- Team shares a common portfolio repository
- Individual members have personal portfolios
- Need to sync/copy elements between them

## Implementation Considerations

1. **Authentication**: Different repos may need different tokens/permissions
2. **Configuration**: How to store and switch between multiple portfolio configs
3. **Migration**: Ensure backward compatibility with existing setup
4. **UI/UX**: How users specify which portfolio to use

## Related Issues
- QA Report 09-08-25-001: GitHub portfolio only showing personas
- QA Report 09-08-25-002: Continued listing issues
- PR (current): Fixed by switching from GitHubClient to PortfolioRepoManager

## Priority
**Medium** - Current fix works, but this would improve architecture and enable new use cases

## Acceptance Criteria
- [ ] Single GitHub manager supports multiple repository types
- [ ] Error messages are context-appropriate
- [ ] Support for multiple portfolio configurations
- [ ] Backward compatible with existing setup
- [ ] Well-documented API for extensions
- [ ] Comprehensive test coverage

---
*Created: September 8, 2025*
*Author: Claude Code with Mick Darling*