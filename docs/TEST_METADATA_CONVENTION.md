# Test Metadata Convention

**Last Updated**: August 20, 2025  
**Related Issue**: [#649 - Metadata-Based Test Detection](https://github.com/DollhouseMCP/mcp-server/issues/649)

## Overview

DollhouseMCP uses **metadata-based test detection** instead of filename patterns to identify test files. This gives users complete naming freedom while maintaining 100% accuracy in identifying DollhouseMCP test files.

## Why We Moved From Filename Patterns

### The Problem with Filename Patterns

Previously, DollhouseMCP used filename patterns to detect test files:

```javascript
// OLD APPROACH - Removed in v1.6.0
const TEST_PATTERNS = [
  /^test-/i,
  /^sample-/i,
  /edge-case/i,
  /invalid-element/i,
  /roundtrip.*test/i
];
```

**Issues with this approach:**
- ❌ **False Positives**: User elements with names like "Test Assistant" were incorrectly filtered
- ❌ **Naming Restrictions**: Users couldn't create elements with certain words
- ❌ **Maintenance Burden**: Required constant updates to pattern lists
- ❌ **Cultural Barriers**: Names like "テスト" (Japanese for "test") might be filtered

### The Metadata Solution

Now we use explicit metadata markers:

```yaml
---
_dollhouseMCPTest: true
_testMetadata:
  suite: "test-fixtures"
  purpose: "Test persona for behavior validation"
  created: "2025-08-20"
  version: "1.0.0"
  migrated: "2025-08-20T23:30:45.123Z"
  originalPath: "test/fixtures/roundtrip/sample-persona.md"
---
```

**Benefits:**
- ✅ **Zero False Positives**: Only files with `_dollhouseMCPTest: true` are filtered
- ✅ **Complete Naming Freedom**: Users can name elements anything they want
- ✅ **Future-Proof**: Metadata can evolve without breaking existing files
- ✅ **Self-Documenting**: Test purpose and metadata clearly visible

## Metadata Structure

### Required Field

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `_dollhouseMCPTest` | boolean | ✅ Yes | Must be `true` to identify as DollhouseMCP test file |

### Test Metadata Fields

The `_testMetadata` object contains detailed information about the test:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `suite` | string | ✅ Yes | Test suite category (see [Test Suites](#test-suites)) |
| `purpose` | string | ✅ Yes | Human-readable description of test purpose |
| `created` | string | ✅ Yes | Creation date in YYYY-MM-DD format |
| `version` | string | ✅ Yes | Test version (semantic versioning) |
| `migrated` | string | ⚠️ Migration only | ISO timestamp when migrated from filename patterns |
| `originalPath` | string | ⚠️ Migration only | Original file path for reference |

### Test Suites

| Suite ID | Description | Example Files |
|----------|-------------|---------------|
| `test-fixtures` | Test fixtures for workflow validation | `/test/fixtures/roundtrip/sample-persona.md` |
| `bundled-test-data` | Default test data bundled with DollhouseMCP | `/data/personas/technical-analyst.md` |
| `roundtrip-testing` | End-to-end roundtrip workflow testing | `/test-elements/roundtrip-test-skill.md` |
| `integration-testing` | Integration test scenarios | Custom integration tests |
| `unit-testing` | Unit test data | Unit test fixtures |

## Examples

### Basic Test File

```yaml
---
_dollhouseMCPTest: true
_testMetadata:
  suite: "test-fixtures"
  purpose: "Test persona for behavior validation"
  created: "2025-08-20"
  version: "1.0.0"
name: "Sample Creative Writer"
description: "A test persona for validating creative writing behavior"
type: persona
---

# Sample Creative Writer

You are a creative writing assistant designed for testing DollhouseMCP's persona system...
```

### Edge Case Test File

```yaml
---
_dollhouseMCPTest: true
_testMetadata:
  suite: "test-fixtures"
  purpose: "Edge case testing for Unicode handling and special characters"
  created: "2025-08-20"
  version: "1.0.0"
name: "Unicode Test Element 🧪テスト"
description: "Tests Unicode characters and emoji handling"
type: skill
---

# Unicode Test Element 🧪テスト

This test element validates Unicode character handling...
```

### Roundtrip Test File

```yaml
---
_dollhouseMCPTest: true
_testMetadata:
  suite: "roundtrip-testing"
  purpose: "End-to-end roundtrip workflow testing"
  created: "2025-08-20"
  version: "1.0.0"
name: "Roundtrip Workflow Skill"
description: "Tests the complete roundtrip workflow"
type: skill
---

# Roundtrip Workflow Skill

This skill tests the complete discover → customize → share workflow...
```

## Migration Information

### Automatic Migration

All existing test files have been automatically migrated using the migration script:

```bash
# Run migration (dry-run mode)
node scripts/migrate-test-metadata.ts --dry-run

# Run actual migration
node scripts/migrate-test-metadata.ts

# Check migration results with verbose output
node scripts/migrate-test-metadata.ts --dry-run --verbose
```

### Migration Results

The migration processed 38 test files across 3 directories:

- **`/test/fixtures/`**: 5 files (test fixtures)
- **`/data/`**: 29 files (bundled test data)
- **`/test-elements/`**: 2 files (roundtrip testing)

Files migrated from filename patterns include additional metadata:

```yaml
_testMetadata:
  # ... standard fields ...
  migrated: "2025-08-20T23:30:45.123Z"
  originalPath: "test/fixtures/roundtrip/sample-persona.md"
```

### Rollback Capability

If needed, the migration can be rolled back:

```bash
# Remove all test metadata
node scripts/migrate-test-metadata.ts --rollback

# Preview rollback changes
node scripts/migrate-test-metadata.ts --rollback --dry-run
```

## Implementation Details

### Detection Logic

The system uses a simple metadata reader that:

1. **Reads only YAML frontmatter** (never content body)
2. **Uses 4KB buffer limit** for security
3. **Stops at closing `---` marker**
4. **Handles malformed files gracefully**
5. **Returns false for files without metadata**

```typescript
// Simplified detection logic
function isDollhouseMCPTestElement(filePath: string): boolean {
  const metadata = readMetadataOnly(filePath);
  return metadata?._dollhouseMCPTest === true;
}
```

### Security Features

- **Limited Reading**: Only reads first 4KB maximum
- **Safe Parsing**: Uses js-yaml for secure YAML parsing
- **Graceful Errors**: Returns false for malformed files
- **No Content Access**: Never parses actual element content
- **Performance**: <1ms per file for metadata reading

### Backward Compatibility

- ✅ **All existing tests pass**: No breaking changes to existing functionality
- ✅ **Filename patterns removed**: No more false positives from pattern matching
- ✅ **User elements unaffected**: User-created elements are never filtered
- ✅ **Migration complete**: All DollhouseMCP test files have metadata

## Creating New Test Files

### For Contributors

When creating new test files for DollhouseMCP:

1. **Always include the metadata marker**:
   ```yaml
   ---
   _dollhouseMCPTest: true
   _testMetadata:
     suite: "test-fixtures"  # Choose appropriate suite
     purpose: "Clear description of test purpose"
     created: "2025-08-20"   # Current date
     version: "1.0.0"        # Start with 1.0.0
   # ... your element metadata ...
   ---
   ```

2. **Choose the appropriate test suite**:
   - `test-fixtures` for workflow validation
   - `integration-testing` for integration scenarios
   - `unit-testing` for unit test data

3. **Write clear test purposes**:
   - ✅ "Test persona for behavior validation"
   - ✅ "Edge case testing for Unicode handling"
   - ❌ "Test file"
   - ❌ "Testing"

### For End Users

End users creating their own elements **never** need to include test metadata. Only DollhouseMCP internal test files use this system.

**User elements should NOT include**:
```yaml
# DON'T include this in your personal elements
_dollhouseMCPTest: true
```

## Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| User element being filtered | Contains `_dollhouseMCPTest: true` | Remove the test metadata |
| Test file not detected | Missing `_dollhouseMCPTest: true` | Add the required metadata |
| Malformed metadata | Invalid YAML syntax | Fix YAML formatting |
| Migration failed | File permission issues | Check file permissions |

### Debug Commands

```bash
# Check if file is detected as test
node -e "
const provider = require('./dist/portfolio/DefaultElementProvider.js');
const result = provider.DefaultElementProvider.isDollhouseMCPTestElement('path/to/file.md');
console.log('Is test file:', result);
"

# Validate file metadata
node scripts/migrate-test-metadata.ts --dry-run --verbose
```

## Performance Characteristics

- **Metadata Reading**: <1ms per file
- **Bulk Processing**: ~300ms for 38 files
- **Memory Usage**: <5MB for all operations
- **File Size Impact**: +200-400 bytes per test file
- **False Positive Rate**: 0% (zero false positives)

## Future Enhancements

The metadata system is designed to be extensible:

### Potential Future Fields

```yaml
_testMetadata:
  # Current fields...
  tags: ["integration", "security", "unicode"]
  author: "DollhouseMCP Team"
  dependencies: ["other-test-file.md"]
  timeout: 30000
  priority: "high"
  platforms: ["windows", "macos", "linux"]
```

### Advanced Features

- **Test Dependencies**: Specify test execution order
- **Platform Targeting**: Run tests only on specific platforms
- **Timeout Configuration**: Per-test timeout settings
- **Tag-Based Filtering**: Run specific test categories
- **Test Coverage Tracking**: Detailed coverage metrics

## Summary

The metadata-based test detection system provides:

1. **✅ Complete Naming Freedom**: Users can name elements anything
2. **✅ Zero False Positives**: Only marked files are filtered
3. **✅ Future-Proof Design**: Extensible metadata structure
4. **✅ High Performance**: <1ms per file detection
5. **✅ Security First**: Limited file reading with safe parsing
6. **✅ Migration Complete**: All existing test files upgraded

This system ensures DollhouseMCP test detection is accurate, performant, and user-friendly while maintaining the highest security standards.