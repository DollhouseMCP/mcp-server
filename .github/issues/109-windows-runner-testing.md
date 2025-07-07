# Add Windows Runner Testing to Validate Shell Compatibility Fixes

## Summary
As suggested in PR #108's review, we should add explicit Windows runner testing to our CI workflows to validate that our shell compatibility fixes work correctly on Windows.

## Background
We've recently fixed multiple shell compatibility issues (PRs #106 and #108) by adding `shell: bash` directives to workflow steps that use bash-specific syntax. While these fixes should work (Git Bash is pre-installed on GitHub-hosted Windows runners), we don't currently have explicit Windows testing to validate this.

## Current State
- All workflows now have proper `shell: bash` declarations for bash-specific syntax
- We test on Ubuntu and macOS in most workflows
- Docker testing uses linux/amd64 and linux/arm64 platforms
- No explicit Windows runner testing exists

## Proposed Solution
Add Windows to the test matrix in key workflows, particularly:
1. **core-build-test.yml** - Add Windows to the OS matrix
2. **extended-node-compatibility.yml** - Include Windows testing
3. **cross-platform-simple.yml** - Already includes Windows but could be enhanced

## Benefits
- **Validation**: Confirms our shell compatibility fixes work as intended
- **Early Detection**: Catches Windows-specific issues before they impact users
- **Confidence**: Ensures true cross-platform compatibility
- **Coverage**: Tests our bash syntax works correctly with Git Bash on Windows

## Implementation Considerations
- Windows runners may be slower than Linux runners
- Some tests may need Windows-specific adjustments (e.g., path handling)
- Consider using a subset of tests for Windows to balance coverage vs. CI time

## Example Matrix Configuration
```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
    node-version: [18.x, 20.x]
```

## Priority
**Low-Medium** - The shell compatibility fixes should work with Git Bash, but explicit testing would provide additional confidence.

## Related Work
- Follows PR #106: Fix PowerShell syntax errors
- Follows PR #108: Fix additional shell compatibility issues
- Part of CI reliability improvements (v1.1.0 milestone)

## Acceptance Criteria
- [ ] Windows added to test matrix in core workflows
- [ ] All tests pass on Windows runners
- [ ] Any Windows-specific issues are documented and resolved
- [ ] CI time remains reasonable despite additional platform testing