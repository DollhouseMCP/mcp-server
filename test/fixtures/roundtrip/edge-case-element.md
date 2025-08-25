---
_dollhouseMCPTest: true
_testMetadata:
  suite: "test-fixtures"
  purpose: "Edge case testing for robustness validation"
  created: "2025-08-20"
  version: "1.0.0"
  migrated: "2025-08-20T23:47:24.337Z"
  originalPath: "test/fixtures/roundtrip/edge-case-element.md"
---
# Edge Case Test Element ñáméd wîth spéçial çhäråctérs

A test element with edge cases for validating robust workflow handling.

## Metadata
- Type: skill
- Version: 10.99.999
- Author: test-user-with-very-long-name-that-might-cause-issues@example-domain-name.com
- Tags: edge-case, unicode-test, special-characters, very-long-tag-name-that-exceeds-normal-limits, 中文, العربية, русский
- Created: 2025-12-31T23:59:59.999Z
- Updated: 2025-12-31T23:59:59.999Z

## Description

This element contains various edge cases to test workflow robustness:
- Unicode characters in title
- High version number
- Very long author name
- Mixed language tags
- Boundary timestamp values
- Special characters throughout content

## Edge Case Content

### Unicode Testing Section
This section contains various Unicode characters:
- Emoji: 🚀 💻 🔧 ⚡ 🎯 📊 🎨 💡
- Mathematical symbols: ∫ ∑ ∞ ≠ ≤ ≥ ± ∂ ∇ 
- Currency: $ € £ ¥ ₹ ₿ ₱ ₫ ₦ ₡
- Arrows: ← → ↑ ↓ ↔ ↕ ↖ ↗ ↘ ↙
- Diacritical marks: àáâãäåæçèéêëìíîïñòóôõöøùúûüý

### Special Characters Testing
```
Special characters in code blocks: !@#$%^&*()[]{}|;:'",./<>?`~
Escaped characters: \n \t \r \\ \' \"
HTML entities: &lt; &gt; &amp; &quot; &apos;
URL encoding: %20 %21 %22 %23 %24 %25 %26
```

### Long Content Section
Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.

### Markdown Edge Cases

#### Nested Lists
1. First level item
   - Second level bullet
     - Third level bullet
       1. Mixed numbering
          - Even deeper nesting
             - Maximum depth testing

#### Complex Tables
| Column 1 | Column with very long header name | Special Chars | Unicode |
|----------|----------------------------------|---------------|---------|
| Normal   | Very long content that might wrap | !@#$%^&*() | 🌟✨💫 |
| `code`   | **bold** *italic* ~~strikethrough~~ | <>&"' | 中文测试 |

#### Code Blocks with Various Languages
```javascript
// JavaScript with Unicode
const specialString = "Hello 世界! 🌍";
function test(param) {
  return `Result: ${param} ñáméd`;
}
```

```python
# Python with special characters
def special_function(ñáme, vålué=None):
    """Function with special characters in docstring: àáâã"""
    return f"Processing {ñáme} with value {vålué}"
```

```sql
-- SQL with Unicode
SELECT * FROM users WHERE name LIKE '%ñáméd%' AND status = '活跃';
```

## Testing Validation Points

This element should test:
- Unicode handling in metadata parsing
- Special character preservation
- Long content processing
- Complex markdown rendering
- Character encoding consistency
- Version number validation (boundary case)
- Tag processing with mixed languages
- Timestamp parsing edge cases
- File naming with special characters
- URL encoding for portfolio/collection submission

## Expected Behavior

The system should:
1. Preserve all Unicode characters correctly
2. Handle special characters without corruption
3. Process high version numbers appropriately
4. Maintain encoding consistency throughout workflow
5. Generate valid URLs despite special characters
6. Create proper file names (with character sanitization if needed)
7. Successfully submit to portfolio and collection
8. Display content correctly in all interfaces