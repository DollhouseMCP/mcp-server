# Trigger Extraction Implementation Guide

## Overview
This guide documents the pattern established in PR #1133 for implementing trigger extraction for different element types. Memory triggers have been successfully implemented and this pattern should be followed for Skills (#1121), Templates (#1122), and Agents (#1123).

## Implementation Checklist

### 1. Update Element Type Interface
**File**: `src/types/elements/I[ElementType].ts`

```typescript
export interface I[ElementType]Metadata extends IElementMetadata {
  // ... existing fields ...
  triggers?: string[];  // Add this field
}
```

### 2. Add Validation Constants
**File**: `src/elements/[elementType]/[ElementType].ts`

```typescript
/**
 * Maximum length for individual trigger words used in Enhanced Index
 * @constant {number}
 */
const MAX_TRIGGER_LENGTH = 50;

/**
 * Validation pattern for trigger words - allows alphanumeric characters, hyphens, and underscores
 * @constant {RegExp}
 */
const TRIGGER_VALIDATION_REGEX = /^[a-zA-Z0-9\-_]+$/;
```

### 3. Update Element Constructor
**File**: `src/elements/[elementType]/[ElementType].ts`

Add trigger validation in the constructor:

```typescript
constructor(yamlContent: string, name: string, metadata?: Partial<I[ElementType]Metadata>) {
  super(yamlContent, name, 'elementType');

  // Validate and sanitize triggers if present
  if (metadata?.triggers && Array.isArray(metadata.triggers)) {
    this.metadata.triggers = metadata.triggers
      .filter(trigger => typeof trigger === 'string')
      .map(trigger => trigger.trim().toLowerCase())
      .filter(trigger =>
        trigger.length > 0 &&
        trigger.length <= MAX_TRIGGER_LENGTH &&
        TRIGGER_VALIDATION_REGEX.test(trigger)
      )
      .slice(0, 20); // Limit to reasonable number
  }
}
```

### 4. Update Manager to Extract Triggers
**File**: `src/elements/[elementType]/[ElementType]Manager.ts`

In the method that parses YAML metadata:

```typescript
private parseMetadata(yamlContent: string): I[ElementType]Metadata {
  // ... existing parsing ...

  // Extract and validate triggers
  triggers: Array.isArray(metadataSource.triggers) ?
    metadataSource.triggers
      .map((trigger: string) => sanitizeInput(trigger, MAX_TRIGGER_LENGTH))
      .filter((trigger: string) => trigger && TRIGGER_VALIDATION_REGEX.test(trigger))
      .slice(0, 20) : // Limit number of triggers
    [],

  // ... rest of metadata ...
}
```

### 5. Update BaseElement for Metadata Preservation
**File**: `src/elements/BaseElement.ts`

Add selective preservation for triggers:

```typescript
// In the metadata processing section
if ('triggers' in metadata && Array.isArray((metadata as any).triggers)) {
  baseMetadata.triggers = (metadata as any).triggers;
}
```

### 6. Update EnhancedIndexManager
**File**: `src/portfolio/EnhancedIndexManager.ts`

In the `extractActionTriggers` method, add extraction for your element type:

```typescript
// Extract [ElementType] triggers
case 'elementTypes': {
  const elementManager = [ElementType]Manager.getInstance();
  const elements = await elementManager.listElements();

  for (const elementName of elements) {
    try {
      const element = await elementManager.getElement(elementName);
      const metadata = element.getMetadata();

      if (metadata.triggers && Array.isArray(metadata.triggers)) {
        for (const trigger of metadata.triggers) {
          const normalized = this.normalizeTrigger(trigger);
          if (normalized) {
            this.addTriggerMapping(normalized, elementName, actionTriggers);
          }
        }
      }
    } catch (error) {
      logger.warn(`Failed to extract triggers from ${elementType} ${elementName}`, { error });
    }
  }
  break;
}
```

### 7. Create Unit Tests
**File**: `test/unit/[ElementType]Manager.triggers.test.ts`

Test scenarios to cover:
- Basic trigger extraction
- Invalid trigger filtering
- Long trigger truncation
- Special character handling
- Empty/null trigger arrays
- Maximum trigger count limits

```typescript
describe('[ElementType]Manager - Trigger Extraction', () => {
  it('should extract valid triggers from metadata', async () => {
    const yamlContent = `
      metadata:
        triggers: [create, generate, build]
      content: test
    `;

    const element = await manager.createElement('test-element', yamlContent);
    const metadata = element.getMetadata();

    expect(metadata.triggers).toEqual(['create', 'generate', 'build']);
  });

  // Add more test cases...
});
```

### 8. Create Performance Tests
**File**: `test/unit/[ElementType]Manager.triggers.performance.test.ts`

```typescript
it('should handle large numbers of triggers efficiently', async () => {
  const triggers = Array.from({ length: 200 }, (_, i) => `trigger${i}`);
  // Test performance with many triggers
});
```

### 9. Create Integration Tests
**File**: `test/integration/[elementType]-enhanced-index.test.ts`

```typescript
describe('[ElementType] Enhanced Index Integration', () => {
  it('should find elements by trigger verb', async () => {
    // Create element with triggers
    // Rebuild index
    // Search by trigger
    // Verify element found
  });
});
```

## Element-Specific Considerations

### Skills (#1121)
- Skills often have action-oriented names already
- Consider extracting verbs from skill names in addition to triggers
- Example triggers: "analyze", "optimize", "validate", "debug"

### Templates (#1122)
- Templates might use triggers for template selection
- Consider context-specific triggers
- Example triggers: "email", "report", "proposal", "invoice"

### Agents (#1123)
- Agents are goal-oriented, triggers should reflect goals
- May need multiple trigger categories (action vs. goal)
- Example triggers: "investigate", "research", "solve", "coordinate"

## Validation Rules

### Trigger Format Requirements
- **Length**: 1-50 characters
- **Characters**: Alphanumeric, hyphens, underscores only
- **Case**: Convert to lowercase for consistency
- **Count**: Maximum 20 triggers per element (configurable)

### Security Considerations
- Always sanitize input with `sanitizeInput()` function
- Validate against regex pattern
- Limit total number of triggers
- Trim whitespace
- Filter empty strings

## Testing Requirements

### Unit Tests
- [ ] Valid trigger extraction
- [ ] Invalid character filtering
- [ ] Length validation
- [ ] Count limits
- [ ] Empty/null handling
- [ ] Type checking

### Integration Tests
- [ ] Enhanced Index integration
- [ ] Search by trigger verb
- [ ] Multiple elements with same trigger
- [ ] No triggers scenario

### Performance Tests
- [ ] Handle 200+ triggers
- [ ] Large YAML files
- [ ] Concurrent access

## Migration Considerations

### Backward Compatibility
- Elements without triggers should work normally
- Existing elements don't require triggers
- Triggers are optional metadata

### Index Rebuild
After implementing triggers for a new element type:
1. Clear existing index: `rm ~/.dollhouse/portfolio/capability-index.yaml`
2. Rebuild: The index will rebuild automatically on next access

## Common Pitfalls to Avoid

1. **Don't forget type annotations** - TypeScript compilation will fail
2. **Don't skip validation** - Security risk with unsanitized input
3. **Don't allow unlimited triggers** - Performance and storage impact
4. **Don't modify BaseElement carelessly** - Can break YAML serialization
5. **Don't forget ESM test compatibility** - Add to ignore list if needed

## Verification Steps

After implementation:
1. Run build: `npm run build`
2. Run tests: `npm test`
3. Test manually:
   ```bash
   # Create element with triggers
   # Restart server
   # Search using trigger verb
   ```
4. Check Enhanced Index:
   ```bash
   cat ~/.dollhouse/portfolio/capability-index.yaml | grep action_triggers -A 20
   ```

## Example PR Description Template

```markdown
## Summary
Implements trigger extraction for [ElementType] elements as part of Enhanced Index improvements.

## Changes
- Added `triggers` field to I[ElementType]Metadata interface
- Implemented trigger validation and sanitization
- Updated [ElementType]Manager to extract triggers from YAML
- Added BaseElement metadata preservation for triggers
- Integrated with EnhancedIndexManager action triggers
- Added comprehensive unit and integration tests

## Testing
- Unit tests for trigger extraction and validation
- Integration tests with Enhanced Index
- Performance tests with 200+ triggers
- Manual testing with various trigger patterns

## Related Issues
Fixes #[issue-number]

## Checklist
- [ ] Tests pass locally
- [ ] Build successful
- [ ] Documentation updated
- [ ] Backward compatible
```

## Success Metrics

Implementation is complete when:
1. ✅ Elements can define triggers in metadata
2. ✅ Triggers are validated and sanitized
3. ✅ Enhanced Index includes triggers in action_triggers
4. ✅ Search by trigger verb returns correct elements
5. ✅ Tests provide >95% coverage
6. ✅ Performance acceptable with 200+ triggers
7. ✅ Backward compatibility maintained

## Support

For questions or issues:
- Review PR #1133 for Memory implementation reference
- Check SESSION_NOTES_2025-09-26-memory-triggers.md
- Create issue with `trigger-extraction` label

---
*Based on successful Memory trigger implementation in PR #1133*