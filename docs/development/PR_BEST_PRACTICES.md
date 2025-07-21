# Pull Request Best Practices for DollhouseMCP

This document outlines the best practices for creating high-quality pull requests that have been established through successful PRs (#106, #108, #110) in this project.

## Table of Contents
1. [Branch Strategy](#branch-strategy)
2. [Commit Messages](#commit-messages)
3. [PR Creation](#pr-creation)
4. [Review Process](#review-process)
5. [Post-Review Actions](#post-review-actions)
6. [Examples](#examples)

## Branch Strategy

### Always Create Feature Branches
```bash
# Create descriptive branch names that indicate the fix
git checkout -b fix-ci-powershell-syntax
git checkout -b fix-additional-shell-compatibility
git checkout -b fix-env-validation-and-paths
```

### Branch Naming Conventions
- `fix-` prefix for bug fixes
- `feature-` prefix for new features
- `refactor-` prefix for code improvements
- Use kebab-case with clear, specific descriptions

## Commit Messages

### Comprehensive Commit Format
Always create commits with full context and documentation:

```bash
git commit -m "$(cat <<'EOF'
Fix PowerShell syntax errors in CI workflows

This PR fixes critical PowerShell syntax errors that were causing Windows CI failures across multiple workflows.

## Problem
The Core Build & Test and Build Artifacts workflows were failing on Windows runners due to bash-specific syntax being executed in PowerShell (the default shell on Windows).

## Root Cause
When no shell is specified in a GitHub Actions workflow step, the runner defaults to:
- PowerShell on Windows
- Bash on Linux/macOS

## Solution
Added `shell: bash` directive to the affected steps to ensure they use Git Bash on Windows runners instead of PowerShell.

## Changes Made
1. **core-build-test.yml**: Added `shell: bash` to "Debug failed tests environment" step (line 106)
2. **build-artifacts.yml**: Added `shell: bash` to "Verify build artifacts" step (line 53)

## Testing
- Verified the syntax is now compatible across all platforms
- Git Bash is available on all GitHub-hosted Windows runners

## Related Issues
- Addresses remaining CI issues documented in Issue #88
- Part of the effort to achieve 100% CI reliability for branch protection

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

### Key Elements
1. **Clear Title**: One-line summary of the change
2. **Problem Statement**: What issue is being fixed
3. **Root Cause Analysis**: Why the problem exists
4. **Solution Description**: How the fix works
5. **Specific Changes**: List files and line numbers
6. **Testing Notes**: How to verify the fix
7. **Related Issues**: Link to GitHub issues
8. **Attribution**: Credit Claude Code assistance

## PR Creation

### Use GitHub CLI with Comprehensive Body
```bash
gh pr create --title "Fix PowerShell syntax errors in CI workflows" --body "$(cat <<'EOF'
## Summary
This PR fixes critical PowerShell syntax errors that were causing Windows CI failures in the Core Build & Test and Build Artifacts workflows.

## Problem
The workflows were failing on Windows runners with parser errors because bash-specific syntax was being executed in PowerShell (the default shell on Windows).

## Root Cause Analysis
When no shell is specified in a GitHub Actions workflow step, the runner defaults to:
- **PowerShell** on Windows
- **Bash** on Linux/macOS

The affected steps contained bash-specific constructs that PowerShell doesn't understand:
- `$(pwd)` - Command substitution syntax
- `if [ -f "file" ]; then` - Bash conditional syntax  
- `ls -la` - Unix-specific command options
- `head -5` - Unix-specific command

## Solution
Added `shell: bash` directive to the affected steps to ensure they use Git Bash on Windows runners instead of PowerShell.

## Changes Made
1. **`.github/workflows/core-build-test.yml`** (line 106)
   - Added `shell: bash` to "Debug failed tests environment" step
   - This step runs diagnostic commands when tests fail

2. **`.github/workflows/build-artifacts.yml`** (line 53)
   - Added `shell: bash` to "Verify build artifacts" step
   - This step validates build outputs using bash conditionals

## Testing Considerations
- ✅ Git Bash is pre-installed on all GitHub-hosted Windows runners
- ✅ This is a minimal, targeted fix that preserves existing functionality
- ✅ The syntax is now compatible across Ubuntu, macOS, and Windows
- ✅ No changes to actual logic, only shell specification

## Impact
- Fixes Windows-specific CI failures
- Enables progress toward 100% CI reliability
- Unblocks branch protection requirements
- Addresses part of Issue #88 (Windows shell syntax issues)

## Related Issues
- Partially resolves #88: Windows shell syntax and integration test environment
- Contributes to CI reliability milestone v1.1.0

## Next Steps
After this PR is merged, remaining CI issues include:
- ES Module import resolution (Issue #101)
- Docker build dependencies (Issue #102)
- Environment validation (Issue #93)
- Cross-platform path handling (Issue #104)

## Review Request
Please verify:
1. The `shell: bash` additions are in the correct locations
2. No other workflow steps need similar fixes
3. The approach aligns with project standards

🤖 Generated with [Claude Code](https://claude.ai/code)
EOF
)"
```

### PR Description Structure
1. **Summary**: Brief overview of changes
2. **Problem**: What issue is being addressed
3. **Root Cause Analysis**: Technical explanation
4. **Solution**: How the fix works
5. **Changes Made**: Specific file modifications
6. **Testing Considerations**: Verification approach
7. **Impact**: Benefits and outcomes
8. **Related Issues**: Links to tracking issues
9. **Next Steps**: What comes after this PR
10. **Review Request**: Specific areas for reviewer attention

## Review Process

### Monitor PR Reviews
```bash
# Check PR status and reviews
gh pr view 106 --comments
```

### Responding to Reviews
1. **Read the entire review carefully**
2. **Implement minor suggestions immediately**:
   ```bash
   # Example: Adding explanatory comments per review
   git add -A && git commit -m "Add explanatory comments for shell: bash directives

   Per review feedback, added comments explaining why we use 'shell: bash' for cross-platform compatibility."
   git push
   ```

3. **Create issues for future considerations**
4. **Thank the reviewer and summarize actions taken**

### Critical: Synchronizing Code Fixes with PR Comments

**Problem**: When you push fixes and then add comments separately, reviewers often miss that the fixes are already implemented.

**Solution**: Always push code and explanation together!

#### Method 1: Push + Immediate Comment with Commit Reference
```bash
# After pushing fixes
git push

# IMMEDIATELY add comment with commit SHA
gh pr comment [PR-NUMBER] --body "$(cat <<'EOF'
## ✅ All Issues Fixed in commit b226dbe

I've addressed all security issues from the review in the latest commit.

[Click here to view the changes](https://github.com/DollhouseMCP/mcp-server/pull/331/commits/b226dbe)

### What was fixed:
1. **yaml.load false positive** - Removed from comment (TemplateManager.ts:277)
2. **Object nesting DoS** - Returns safe default (Template.ts:410-418)
3. **Array size limits** - Added MAX_ARRAY_SIZE (Template.ts:375-384)

All fixes include inline documentation explaining the security improvements.
EOF
)"
```

#### Method 2: Update PR Description After Fixes
```bash
# After pushing all fixes
gh pr edit [PR-NUMBER] --body "$(cat <<'EOF'
[Original PR description...]

## UPDATE: Review Fixes Complete ✅

All issues from the security review have been addressed in commit b226dbe:

| Issue | Status | Location | Commit |
|-------|--------|----------|--------|
| yaml.load false positive | ✅ Fixed | TemplateManager.ts:277 | b226dbe |
| Object nesting DoS | ✅ Fixed | Template.ts:410-418 | b226dbe |
| Array size limits | ✅ Fixed | Template.ts:375-384 | b226dbe |

Ready for re-review!
EOF
)"
```

#### Common Mistake to Avoid
```bash
# ❌ DON'T DO THIS:
git push
# ... wait 30 minutes ...
gh pr comment --body "Fixed all issues!"  # Reviewer won't know WHEN you fixed them!

# ✅ DO THIS INSTEAD:
git push && gh pr comment --body "Fixed in $(git rev-parse --short HEAD): [view changes](link)"
```

## Post-Review Actions

### Create Follow-up Issues
For each suggestion or future consideration in the review:

```bash
# Create detailed issue documentation
cat > .github/issues/111-secure-env-logging.md << 'EOF'
# Implement secure environment variable logging in CI workflows

## Summary
The review of PR #110 identified that our environment validation logs all environment variables in plain text, which could expose sensitive information. We need to implement secure logging that redacts sensitive values.

## Problem
Current implementation logs environment variables directly:
```bash
echo "TEST_PERSONAS_DIR: $TEST_PERSONAS_DIR"
```

## Proposed Solution
[Detailed solution with code examples]

## Benefits
- Prevents accidental exposure of sensitive information
- Maintains debugging capabilities
- Follows security best practices

## Priority
**Medium** - Important for future-proofing

## Related Work
- Follows PR #110: Environment validation
- Part of security best practices

## Acceptance Criteria
- [ ] Sensitive variables are redacted
- [ ] Non-sensitive variables show values
- [ ] Documentation updated
EOF

# Create GitHub issue
gh issue create --title "Implement secure environment variable logging in CI workflows" \
  --body "$(cat .github/issues/111-secure-env-logging.md)" \
  --label "enhancement" --label "area: ci/cd" --label "area: security" --label "priority: medium"
```

### Issue Creation Best Practices
1. **Comprehensive Documentation**: Include problem, solution, benefits
2. **Code Examples**: Show current vs. proposed implementation
3. **Clear Acceptance Criteria**: Define success metrics
4. **Appropriate Labels**: Use consistent labeling system
5. **Priority Assignment**: Based on impact and urgency

## Examples

### Example 1: Simple Shell Fix (PR #106)
- **Problem**: PowerShell syntax errors on Windows
- **Solution**: Add `shell: bash` to affected steps
- **Review**: Identified similar issues in other files
- **Follow-up**: Created Issue #107 for additional fixes

### Example 2: Complex Multi-Issue Fix (PR #110)
- **Problem**: Environment validation + path handling
- **Solution**: Add validation steps + fix Unix commands
- **Review**: Security and error handling suggestions
- **Follow-up**: Created Issues #111-114 for improvements

## Key Principles

1. **Always Include Context**: Never assume reviewers know the background
2. **Be Specific**: Include file names, line numbers, error messages
3. **Show Impact**: Explain how this helps achieve project goals
4. **Document Everything**: Create issues for all suggestions
5. **Test Thoroughly**: Verify fixes work across all platforms
6. **Credit Appropriately**: Include Claude Code attribution

## Workflow Summary

1. Create feature branch with descriptive name
2. Make targeted changes (avoid scope creep)
3. Commit with comprehensive message including all context
4. Create PR with detailed description
5. Monitor for review feedback
6. Implement minor suggestions immediately
7. Create issues for major suggestions
8. Merge when approved
9. Document lessons learned

## Benefits of This Approach

- **Faster Reviews**: Reviewers have all context upfront
- **Better Suggestions**: Reviews can focus on improvements vs. understanding
- **Knowledge Transfer**: Documentation helps future contributors
- **Issue Tracking**: Nothing gets lost from reviews
- **Quality Improvement**: Each PR raises the bar

This approach has resulted in high-quality PRs with excellent review feedback and systematic improvement of the codebase.