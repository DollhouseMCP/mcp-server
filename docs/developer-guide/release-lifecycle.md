# Release Lifecycle and Versioning Guide

This guide explains how DollhouseMCP manages releases, from early development through stable production. It covers versioning conventions, branch strategies, npm publishing, and the complete flow from feature development to user availability.

## Overview

DollhouseMCP follows a structured release lifecycle that enables:

- **Parallel development**: Work on new features while stabilizing releases
- **Early access**: Let users test pre-release versions before they're stable
- **Traceability**: Every build maps to a specific commit
- **Safety**: Stable users are never accidentally upgraded to unstable code

```mermaid
flowchart LR
    subgraph Development
        F[Feature Branches]
        D[develop]
    end

    subgraph Stabilization
        RC[release/* branch]
    end

    subgraph Production
        M[main]
    end

    subgraph npm Registry
        A[alpha tag]
        B[beta tag]
        N[next tag]
        L[latest tag]
    end

    F -->|merge| D
    D -->|publish| B
    D -->|feature freeze| RC
    RC -->|publish| N
    RC -->|merge| M
    M -->|publish| L
    F -->|publish| A
```

## Semantic Versioning

DollhouseMCP uses [Semantic Versioning 2.0](https://semver.org/) (SemVer) for all releases.

### Version Format

```
MAJOR.MINOR.PATCH-PRERELEASE+BUILD
```

| Component | When to Increment | Example |
|-----------|-------------------|---------|
| **MAJOR** | Breaking changes that require user action | `2.0.0` |
| **MINOR** | New features, backwards compatible | `1.7.0` |
| **PATCH** | Bug fixes only | `1.6.5` |
| **PRERELEASE** | Pre-release identifier | `2.0.0-beta.3` |
| **BUILD** | Build metadata (commit hash) | `2.0.0-beta.3+b96ef61` |

### Pre-release Identifiers

Pre-release versions use a channel name and iteration number:

```
2.0.0-alpha.feature-oauth.1    # Feature-specific alpha
2.0.0-alpha.fix-42.1           # Fix-specific alpha
2.0.0-beta.3                   # Integration beta
2.0.0-rc.1                     # Release candidate
2.0.0                          # Stable release
```

### Version Sorting

SemVer defines a strict sort order. Pre-release versions always sort below their stable counterpart:

```
2.0.0-alpha.1 < 2.0.0-alpha.2 < 2.0.0-beta.1 < 2.0.0-beta.2 < 2.0.0-rc.1 < 2.0.0
```

This means users requesting `^2.0.0` will never accidentally receive a pre-release version.

## Release Channels

DollhouseMCP uses four release channels, each serving a different audience and purpose.

```mermaid
graph TB
    subgraph Channels["Release Channels (Stability →)"]
        direction LR
        A["alpha<br/>━━━━━<br/>Lowest stability<br/>Feature testing"]
        B["beta<br/>━━━━━<br/>Medium stability<br/>Integration testing"]
        N["next (RC)<br/>━━━━━<br/>High stability<br/>Final validation"]
        L["latest<br/>━━━━━<br/>Stable<br/>Production use"]
    end

    A --> B --> N --> L
```

### Channel Details

| Channel | npm Tag | Source Branch | Audience | Stability |
|---------|---------|---------------|----------|-----------|
| **Alpha** | `@alpha` | feature/*, fix/* | Core team, specific testers | Lowest - features incomplete |
| **Beta** | `@beta` | develop | Adventurous users, early adopters | Medium - features complete, bugs expected |
| **Release Candidate** | `@next` | release/* | Wider testing, production validation | High - bug fixes only |
| **Stable** | `@latest` | main | Everyone | Production-ready |

### How Users Install Each Channel

```bash
# Stable (default) - what most users should use
npm install @dollhousemcp/mcp-server

# Beta - for early adopters who want new features
npm install @dollhousemcp/mcp-server@beta

# Release candidate - for testing upcoming stable releases
npm install @dollhousemcp/mcp-server@next

# Alpha - for specific feature testing
npm install @dollhousemcp/mcp-server@alpha

# Specific version - when you need an exact version
npm install @dollhousemcp/mcp-server@2.0.0-beta.3
```

## Branch Strategy

The branch strategy supports parallel development while maintaining stability.

```mermaid
gitGraph
    commit id: "1.4.2" tag: "v1.4.2"
    branch develop
    checkout develop
    commit id: "feature A"
    commit id: "feature B"
    branch feature/oauth
    checkout feature/oauth
    commit id: "oauth work"
    commit id: "oauth complete"
    checkout develop
    merge feature/oauth
    commit id: "beta.1" tag: "v2.0.0-beta.1"
    commit id: "bug fix"
    commit id: "beta.2" tag: "v2.0.0-beta.2"
    branch release/2.0
    checkout release/2.0
    commit id: "rc.1" tag: "v2.0.0-rc.1"
    commit id: "rc fix"
    commit id: "rc.2" tag: "v2.0.0-rc.2"
    checkout main
    merge release/2.0
    commit id: "2.0.0" tag: "v2.0.0"
    checkout develop
    commit id: "2.1 feature"
```

### Branch Types

| Branch | Purpose | Merges To | npm Publishes |
|--------|---------|-----------|---------------|
| `main` | Stable releases only | - | `@latest` |
| `develop` | Integration branch | main (via release/*) | `@beta` |
| `feature/*` | New features | develop | `@alpha` (optional) |
| `fix/*` | Bug fixes | develop | `@alpha` (optional) |
| `release/*` | Release stabilization | main, then develop | `@next` |
| `hotfix/*` | Emergency production fixes | main, then develop | `@latest` |

### The Release Branch (Approach 2: More Controlled)

When preparing a release, we create a dedicated release branch. This allows:

1. **Continued development**: New features for the next version continue on `develop`
2. **Focused stabilization**: Only bug fixes go into the release branch
3. **Parallel work**: No one is blocked waiting for the release

```mermaid
gitGraph
    commit id: "stable"
    branch develop
    checkout develop
    commit id: "2.0 feature 1"
    commit id: "2.0 feature 2"
    commit id: "2.0 feature 3" tag: "v2.0.0-beta.4"
    branch release/2.0
    checkout release/2.0
    commit id: "freeze" type: HIGHLIGHT
    commit id: "bug fix 1" tag: "v2.0.0-rc.1"
    checkout develop
    commit id: "2.1 feature 1"
    commit id: "2.1 feature 2"
    checkout release/2.0
    commit id: "bug fix 2" tag: "v2.0.0-rc.2"
    checkout develop
    commit id: "2.1 feature 3"
    checkout main
    merge release/2.0 id: "2.0.0 release" tag: "v2.0.0"
    checkout develop
    merge main id: "sync"
    commit id: "2.1 continues..."
```

**Key point**: After the release branch is created ("freeze" point), `develop` continues with 2.1.0 features while `release/2.0` only receives bug fixes.

## Complete Release Lifecycle

### Phase 1: Feature Development

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant FB as feature/* branch
    participant D as develop
    participant npm as npm Registry

    Dev->>FB: Create feature branch
    Dev->>FB: Implement feature
    Dev->>FB: Commit changes

    opt Alpha Testing
        Dev->>npm: npm publish --tag alpha
        Note over npm: 2.0.0-alpha.feature-name.1
    end

    Dev->>D: Create PR
    Dev->>D: Merge to develop
```

Features are developed on feature branches. Alpha publishes are optional - use them when you need external testers for a specific feature.

### Phase 2: Integration (Beta)

```mermaid
sequenceDiagram
    participant D as develop
    participant npm as npm Registry
    participant Users as Beta Testers

    D->>D: Features accumulate
    D->>npm: npm publish --tag beta
    Note over npm: 2.0.0-beta.1

    Users->>npm: npm install pkg@beta
    Users->>D: Report bugs

    D->>D: Fix bugs
    D->>npm: npm publish --tag beta
    Note over npm: 2.0.0-beta.2

    Note over D: Continue until stable
```

Beta versions are published regularly from `develop`. Early adopters can install `@beta` to get the latest integrated features.

### Phase 3: Release Candidate

```mermaid
sequenceDiagram
    participant D as develop
    participant R as release/2.0
    participant npm as npm Registry
    participant Main as main

    Note over D: Feature freeze decision
    D->>R: Create release branch

    R->>npm: npm publish --tag next
    Note over npm: 2.0.0-rc.1

    Note over D: 2.1.0 development continues
    D->>D: New features for next version

    R->>R: Bug fixes only
    R->>npm: npm publish --tag next
    Note over npm: 2.0.0-rc.2

    Note over R: Ready for release
    R->>Main: Merge to main
```

The release branch is created when you decide to freeze features. From this point:
- `release/*` only receives bug fixes
- `develop` continues with next version features

### Phase 4: Stable Release

```mermaid
sequenceDiagram
    participant R as release/2.0
    participant Main as main
    participant npm as npm Registry
    participant D as develop

    R->>Main: Merge release branch
    Main->>Main: Create tag v2.0.0
    Main->>npm: npm publish
    Note over npm: 2.0.0 (latest)

    Main->>D: Merge back to develop
    Note over D: Develop now based on 2.0.0

    R->>R: Delete release branch
```

After merging to main and publishing, merge main back to develop so future work includes all release fixes.

## npm Publishing

### Understanding npm Tags vs Versions

| Concept | What It Is | Behavior |
|---------|------------|----------|
| **Version** | Permanent, immutable snapshot | `2.0.0-beta.1` exists forever |
| **Tag** | Mutable pointer to a version | `@beta` can point to different versions over time |

Tags work like git branches - they move. Versions work like git commits - they're permanent.

```mermaid
graph LR
    subgraph "npm Registry"
        L["latest"] --> V200["2.0.0"]
        B["beta"] --> V201B3["2.0.0-beta.3"]
        N["next"] --> V201RC2["2.0.0-rc.2"]

        V200
        V201B3
        V201B2["2.0.0-beta.2"]
        V201B1["2.0.0-beta.1"]
        V201RC2
        V201RC1["2.0.0-rc.1"]
        V142["1.4.2"]
    end

    style L fill:#4ade80
    style B fill:#facc15
    style N fill:#60a5fa
```

### Publishing Commands

```bash
# Beta release (from develop)
npm version 2.0.0-beta.3 --no-git-tag-version
npm run build
npm publish --tag beta

# Release candidate (from release/*)
npm version 2.0.0-rc.1 --no-git-tag-version
npm run build
npm publish --tag next

# Stable release (from main)
npm version 2.0.0
npm run build
npm publish
```

### Viewing Published Versions

```bash
# See all versions and tags
npm view @dollhousemcp/mcp-server

# See just the dist-tags (which versions tags point to)
npm view @dollhousemcp/mcp-server dist-tags

# See all published versions
npm view @dollhousemcp/mcp-server versions
```

### Safety Features

npm provides built-in safety for pre-releases:

1. **Default installs get stable only**: `npm install pkg` always gets `@latest`
2. **Explicit opt-in required**: Users must request `@beta` or `@next`
3. **Version resolution prefers stable**: Semver ranges like `^2.0.0` skip pre-releases

### If You Make a Mistake

```bash
# Unpublish within 72 hours (npm policy)
npm unpublish @dollhousemcp/mcp-server@2.0.0-beta.1

# Or deprecate (always available, preferred for older versions)
npm deprecate @dollhousemcp/mcp-server@2.0.0-beta.1 "Use beta.2 instead"

# Always do a dry run first
npm publish --tag beta --dry-run
```

## Version String Format

Every build includes the commit hash for traceability.

### Format by Branch Type

| Branch | Version Format | Example |
|--------|----------------|---------|
| main | `X.Y.Z` | `2.0.0` |
| develop | `X.Y.Z-beta.N+HASH` | `2.0.0-beta.3+b96ef61` |
| release/* | `X.Y.Z-rc.N+HASH` | `2.0.0-rc.1+819d41e` |
| feature/* | `X.Y.Z-alpha.BRANCH.N+HASH` | `2.0.0-alpha.feature-oauth.1+a1b1822` |
| fix/* | `X.Y.Z-alpha.BRANCH.N+HASH` | `2.0.0-alpha.fix-42.1+579aea9` |

### Commit Hash Traceability

The `+HASH` suffix (build metadata) provides:

- **Exact reproducibility**: Check out that commit to get the same code
- **Debugging**: Know exactly which code is running
- **Audit trail**: Trace any build back to its source

**Note**: npm ignores build metadata for version comparison but preserves it for display.

## Quick Reference

### Which Branch to Use

```mermaid
flowchart TD
    Q1{What are you doing?}
    Q1 -->|New feature| F[feature/* branch]
    Q1 -->|Bug fix| FX[fix/* branch]
    Q1 -->|Preparing release| R[release/* branch]
    Q1 -->|Emergency fix| H[hotfix/* branch]

    F -->|When complete| D[Merge to develop]
    FX -->|When complete| D
    R -->|When stable| M[Merge to main]
    H -->|Immediately| M

    D -->|Publish| B["@beta tag"]
    R -->|Publish| N["@next tag"]
    M -->|Publish| L["@latest tag"]
```

### Typical Release Flow Commands

```bash
# 1. Create release branch when ready to stabilize
git checkout develop
git checkout -b release/2.0

# 2. Update version and publish RC
npm version 2.0.0-rc.1 --no-git-tag-version
npm run build
npm publish --tag next

# 3. Fix any bugs found, publish more RCs as needed
# ... make fixes ...
npm version 2.0.0-rc.2 --no-git-tag-version
npm run build
npm publish --tag next

# 4. When stable, merge to main
git checkout main
git merge release/2.0

# 5. Tag and publish stable
npm version 2.0.0
npm run build
npm publish
git tag v2.0.0
git push origin v2.0.0

# 6. Merge back to develop
git checkout develop
git merge main
git push

# 7. Clean up
git branch -d release/2.0
git push origin --delete release/2.0
```

## Common Scenarios

### Scenario 1: Publishing a Feature for Testing

You've completed a feature and want specific users to test it before merging.

```bash
# On your feature branch
npm version 2.0.0-alpha.feature-dark-mode.1 --no-git-tag-version
npm run build
npm publish --tag alpha

# Tell your tester:
# "Install with: npm install @dollhousemcp/mcp-server@2.0.0-alpha.feature-dark-mode.1"
```

### Scenario 2: Regular Beta Release from Develop

You've merged several features and want early adopters to test.

```bash
git checkout develop
npm version 2.0.0-beta.5 --no-git-tag-version
npm run build
npm publish --tag beta
```

### Scenario 3: Starting Release Stabilization

Features are complete for 2.0.0, time to stabilize.

```bash
# Create release branch
git checkout develop
git checkout -b release/2.0

# Publish first RC
npm version 2.0.0-rc.1 --no-git-tag-version
npm run build
npm publish --tag next

# Develop can now continue with 2.1.0 features
```

### Scenario 4: Hotfix in Production

Critical bug found in production that can't wait for the normal release cycle.

```bash
git checkout main
git checkout -b hotfix/critical-auth-bug

# Make the fix
npm version 2.0.1 --no-git-tag-version
npm run build

# Merge and publish immediately
git checkout main
git merge hotfix/critical-auth-bug
npm publish
git tag v2.0.1
git push origin v2.0.1

# Merge to develop to include the fix
git checkout develop
git merge main
```

## Beta Tester Communication

Effective communication with beta testers helps identify issues early and builds community engagement.

### Feedback Channels

```mermaid
flowchart LR
    BT[Beta Tester]

    BT -->|Bug found| I[GitHub Issue]
    BT -->|Question/Idea| D[GitHub Discussion]

    I -->|Uses template| T[Beta Bug Report]
    T -->|Auto-labeled| L[beta-feedback]
    L -->|Triaged| M[Release Milestone]

    D -->|Category| C[Beta Feedback]
```

| Feedback Type | Where to Direct | Why |
|---------------|-----------------|-----|
| **Bug reports** | GitHub Issues | Trackable, assignable, linkable to PRs |
| **Questions** | GitHub Discussions | Conversational, no action required |
| **Ideas/Impressions** | GitHub Discussions | Open-ended, community can engage |
| **Security issues** | Private email | Responsible disclosure |

### Beta Bug Report Template

A dedicated issue template (`.github/ISSUE_TEMPLATE/beta_bug_report.md`) captures:

- **Version information**: Exact pre-release version and channel
- **Regression check**: Did this work in a previous version?
- **Environment details**: OS, Node version, AI client
- **Impact assessment**: How severely does this affect testing?

### Labels for Triage

| Label | Purpose |
|-------|---------|
| `beta-feedback` | All issues from pre-release testing |
| `type: bug` | Confirmed bugs |
| `priority: *` | Severity for release planning |

### Beta Release Notes Template

When publishing a beta, include clear guidance for testers:

```markdown
## What's New in 2.0.0-beta.3

### Features
- Feature A: Brief description
- Feature B: Brief description

### Bug Fixes
- Fixed issue with X (#123)

### Known Issues
- Issue Y is still being investigated (#456)

---

## Testing This Release

Install with:
\`\`\`bash
npm install @dollhousemcp/mcp-server@beta
\`\`\`

**Found a bug?** [Open an issue](https://github.com/DollhouseMCP/mcp-server/issues/new?template=beta_bug_report.md)

**Questions or feedback?** [Start a discussion](https://github.com/DollhouseMCP/mcp-server/discussions/categories/beta-feedback)

Please include your version (`2.0.0-beta.3+b96ef61`) in all reports.
```

### Communicating Breaking Changes

For pre-releases with breaking changes, clearly document:

1. **What changed**: Specific API or behavior changes
2. **Why it changed**: Rationale for the breaking change
3. **Migration path**: How to update existing code
4. **Timeline**: When this will reach stable

## Related Documentation

- [Development Workflow](./workflow.md) - Branch naming and PR process
- [Release Workflow](../agent/RELEASE_WORKFLOW.md) - Detailed release steps
- [CONTRIBUTING.md](../CONTRIBUTING.md) - Contributing guidelines
- [Version Script](../../scripts/update-version.mjs) - Automated version updates

---

*Last Updated: December 2025*
*Maintainer: @mickdarling*
