# Release v1.7.4 - Critical Hotfix

## 🚨 Critical Bug Fix

This hotfix release addresses a critical issue that prevented skills activation when using common version formats.

### Fixed
- **Skills Activation Failure** (#935): Skills with versions like "1.1" or "2.0" were failing to activate due to overly strict semantic versioning validation. The system now accepts flexible version formats while maintaining backwards compatibility.

## Changes

### Version Validation Improvements
- ✅ Now accepts flexible version formats:
  - Single number: `"1"`
  - Major.Minor: `"1.0"`, `"1.1"`, `"2.0"`
  - Full semver: `"1.0.0"`, `"2.1.3"`
  - With prerelease: `"1.0.0-beta"`, `"1.0-rc.1"`
  - With build metadata: `"1.0.0+build123"`

### New Features
- **Version Normalization Utility**: Added `normalizeVersion()` function that:
  - Converts short versions to full semver format
  - Strips leading zeros for consistency (e.g., "01.02" → "1.2.0")
  - Preserves prerelease and build metadata

### Developer Experience
- Improved error messages with clear format requirements and multiple examples
- Added comprehensive test coverage (30 tests for version validation)
- Enhanced documentation with inline explanations

## Impact

- **Immediate Fix**: Skills with versions like "1.1" will now activate successfully
- **Better UX**: LLMs and humans can use natural version formats
- **Backwards Compatible**: All existing semver versions continue to work
- **Consistency**: Version normalization ensures consistent comparisons

## Technical Details

- Modified `BaseElement.ts` version validation regex to accept optional minor and patch versions
- Added comprehensive tests in `BaseElement.test.ts`
- Implemented leading zero normalization to prevent confusion

## Credits

- Issue reported and investigated by @mickdarling
- Fix implemented with assistance from Claude Code
- Excellent review feedback from the community

## Upgrade Instructions

```bash
npm update @dollhousemcp/mcp-server@1.7.4
```

---

**Full Changelog**: https://github.com/DollhouseMCP/mcp-server/compare/v1.7.3...v1.7.4
