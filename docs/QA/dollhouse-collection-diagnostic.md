# DollhouseMCP Collection Diagnostic Report & Fix Guide

**Date**: August 28, 2025  
**Server Version**: 1.6.10  
**GitHub Authentication**: ✅ Connected (mickdarling)  
**Test Environment**: macOS ARM64, Node.js v24.1.0  

## 🚨 Executive Summary

The DollhouseMCP Collection has **critical functionality issues** that prevent users from successfully downloading most elements. Two primary problems were identified:

1. **File Path Mismatch**: Browse tools return incorrect file paths
2. **Overly Aggressive Security Filtering**: Blocks majority of collection content

## 🔍 Detailed Findings

### Issue #1: File Path Inconsistency 

**Problem**: The `browse_collection` tool returns display names with spaces, but GitHub repository uses hyphenated filenames.

**Examples**:
- Browse returns: `"library/skills/Code Review.md"`
- Actual path: `"library/skills/code-review.md"`
- Browse returns: `"library/personas/Security Analyst.md"`
- Actual path: `"library/personas/security-analyst.md"`

**Result**: All direct browse → install workflows fail with:
```
❌ Error fetching content: MCP error -32603: Failed to fetch from GitHub: GitHub API error: 404 Not Found
```

### Issue #2: Security Filter Over-Blocking

**Problem**: Security filter rejects content containing shell commands in backticks, even for legitimate documentation.

**Error Message**:
```
❌ Error installing AI customization element: Critical security threat detected in persona content: Shell command in backticks
```

**Blocked Elements**: Translation skill, Creative Writing skill, Security Analyst persona, Penetration Test Report template, and many others.

### Issue #3: Cache System Inconsistency

**Observation**: 
- Legacy Collection Cache: Empty (0 items)
- Enhanced Index Cache: Working (44 items indexed)
- Enhanced search works correctly, browse collection does not

## ✅ Working vs ❌ Broken Workflows

### ✅ Working Method:
```bash
# Use enhanced search to get correct paths
search_collection_enhanced "code review" --elementType skills
# Returns: library/skills/code-review.md
install_content "library/skills/code-review.md"
```

### ❌ Broken Method:
```bash
# Browse returns incorrect paths
browse_collection "library" "skills"  
# Returns: library/skills/Code Review.md
install_content "library/skills/Code Review.md"  # 404 Error
```

## 🧪 Test Results Summary

| Element Type | Browse Method | Search Method | Install Success | Security Blocks |
|--------------|---------------|---------------|-----------------|-----------------|
| Skills (11)  | ❌ 404 Errors | ✅ Works      | ⚠️ Partial      | 🚫 High         |
| Personas (6) | ❌ 404 Errors | ✅ Works      | ⚠️ Partial      | 🚫 High         |
| Agents (6)   | ❌ 404 Errors | ✅ Works      | ✅ Good         | 🟡 Low          |
| Templates (10)| ❌ 404 Errors| ✅ Works      | ⚠️ Partial      | 🟡 Medium       |

### Successful Installations:
- ✅ **Project Proposal Template** - Clean install
- ✅ **Academic Researcher Agent** - Clean install  
- ✅ **Code Review Skill** - Content accessible (already installed)

### Security Filter Blocks:
- 🚫 Translation skill
- 🚫 Creative Writing skill  
- 🚫 Security Analyst persona
- 🚫 Penetration Test Report template
- 🚫 Roundtrip Test Validator skill

## 🔧 Recommended Fixes

### For Development Team:

#### Fix #1: Path Normalization
**Location**: Collection browse functionality  
**Issue**: Inconsistent file naming between display and storage

**Suggested Code Changes**:
```typescript
// In browse_collection handler
function normalizeFileName(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-\.]/g, '');
}

// When building collection response
const normalizedPath = `library/${type}/${normalizeFileName(item.name)}.md`;
```

#### Fix #2: Security Filter Refinement
**Location**: Content validation system  
**Issue**: Blocking legitimate documentation with code examples

**Current Logic** (problematic):
```typescript
// Too broad - blocks any backticks
if (content.includes('`') && /`[^`]*\$|sudo|rm|exec/.test(content)) {
  throw new Error('Critical security threat detected');
}
```

**Suggested Improved Logic**:
```typescript
// More nuanced detection
function isSecurityThreat(content: string): boolean {
  const suspiciousPatterns = [
    /`\s*(sudo|rm -rf|exec|eval|system)\s*[^`]*`/gi,
    /`[^`]*\$\([^)]*\)[^`]*`/g,  // Command substitution
    /`[^`]*&&[^`]*`/g,           // Command chaining
    /`[^`]*\|\s*sh[^`]*`/g       // Pipe to shell
  ];
  
  return suspiciousPatterns.some(pattern => pattern.test(content));
}

// Allow safe code examples
function allowSafeCodeBlocks(content: string): boolean {
  // Check if backticks are only in documentation contexts
  const codeBlockPattern = /```[\s\S]*?```|`[^`\n]*`/g;
  const matches = content.match(codeBlockPattern);
  
  if (!matches) return true;
  
  return matches.every(match => {
    // Allow if it's clearly documentation
    return !isSecurityThreat(match);
  });
}
```

#### Fix #3: Error Message Improvement
**Current**: Generic 404 errors  
**Suggested**: Specific error types

```typescript
enum CollectionError {
  FILE_NOT_FOUND = 'COLLECTION_FILE_NOT_FOUND',
  SECURITY_BLOCKED = 'SECURITY_FILTER_BLOCKED', 
  NETWORK_ERROR = 'GITHUB_API_ERROR'
}

function enhancedErrorMessage(error: CollectionError, context: any) {
  switch(error) {
    case CollectionError.FILE_NOT_FOUND:
      return `File not found. Try using search to get correct path: search_collection_enhanced "${context.searchTerm}"`;
    case CollectionError.SECURITY_BLOCKED:
      return `Content blocked by security filter. Reason: ${context.reason}`;
    case CollectionError.NETWORK_ERROR:
      return `GitHub API error: ${context.statusCode} ${context.message}`;
  }
}
```

### For Users (Immediate Workarounds):

#### Workaround #1: Always Use Enhanced Search
```bash
# Instead of browse_collection
search_collection_enhanced "your-search-term" --elementType skills

# Use the returned path exactly as provided
install_content "library/skills/returned-path.md"
```

#### Workaround #2: Manual Path Construction
```bash
# Convert display names to file names
# "Code Review" → "code-review" 
# "Security Analyst" → "security-analyst"
# "Academic Researcher" → "academic-researcher"
```

## 📊 System Health Dashboard

### Server Status:
- ✅ MCP Connection: Active
- ✅ GitHub Auth: Connected (mickdarling)
- ✅ Enhanced Search: 44 elements indexed
- ❌ Legacy Cache: Empty
- ✅ Memory Usage: 19.7MB / 35.0MB

### Collection Statistics:
- **Total Elements**: 44
- **Accessible via Search**: 44 (100%)
- **Accessible via Browse**: 0 (0%)  
- **Successfully Installable**: ~20% (due to security filter)

### Cache Performance:
- Enhanced Index Cache: ✅ Healthy (13m TTL remaining)
- Legacy Collection Cache: ❌ Empty (expired)
- Search Response Time: 0-80ms

## 🚀 Priority Fix Recommendations

1. **High Priority**: Fix file path normalization in browse_collection
2. **High Priority**: Refine security filter to allow safe documentation
3. **Medium Priority**: Improve error messaging with specific guidance
4. **Low Priority**: Investigate legacy cache system issues

## 🧪 Testing Commands for Validation

### Test Path Consistency:
```bash
# Should return same paths
browse_collection "library" "skills"
search_collection_enhanced "code review" --elementType skills
```

### Test Security Filter:
```bash
# Try installing known blocked content
install_content "library/skills/translation.md"

# Try installing known working content  
install_content "library/templates/project-proposal.md"
```

### Test Cache Health:
```bash
get_collection_cache_health
```

## 📝 Implementation Notes

- File path normalization should be bidirectional (display ↔ storage)
- Security filter needs whitelist for common documentation patterns
- Consider implementing content sanitization pipeline
- Add automated testing for collection workflows
- Monitor false positive rates in security filtering

---

**Report Generated**: August 28, 2025  
**Next Review**: After implementation of path normalization fix