# Element Implementation Lessons Learned

## Key Patterns Established

### 1. File Structure Pattern
Every element follows this structure:
```
src/elements/{element-type}/
├── {Element}.ts          # Core implementation extending BaseElement
├── {Element}Manager.ts   # CRUD operations implementing IElementManager
├── constants.ts          # Limits, defaults, and enums
├── types.ts              # TypeScript interfaces
└── index.ts              # Module exports
```

### 2. Security Pattern
Every element MUST have:
```typescript
// In constructor
const sanitizedMetadata = {
  name: sanitizeInput(UnicodeValidator.normalize(metadata.name).normalizedContent, 100),
  // ... other fields
};

// For any user input
if (MALICIOUS_PATTERNS.some(pattern => input.toLowerCase().includes(pattern))) {
  SecurityMonitor.logSecurityEvent({
    type: 'CONTENT_INJECTION_ATTEMPT',
    severity: 'HIGH',
    source: 'Element.method',
    details: `Malicious content detected`
  });
  throw new Error('Invalid content');
}
```

### 3. Memory Management Pattern
```typescript
// Constants
private readonly MAX_ITEMS = 100;
private readonly MAX_ITEM_SIZE = 10000;

// Enforcement
if (this.items.length >= MAX_ITEMS) {
  throw new Error(`Maximum items (${MAX_ITEMS}) reached`);
}

// Cleanup in deactivate()
public override async deactivate(): Promise<void> {
  this.clearItems();
  await super.deactivate();
}
```

### 4. State Persistence Pattern
```typescript
// Manager saves state separately
const stateFilename = `${name}${STATE_FILE_EXTENSION}`;
const stateFilepath = path.join(this.elementsPath, STATE_DIRECTORY, stateFilename);

// YAML serialization with type conversion
const serializedState = {
  ...state,
  // Convert non-string types for FAILSAFE_SCHEMA
  count: String(state.count),
  timestamp: state.timestamp.toISOString()
};

// Parse back on load
if (state.count !== undefined) {
  state.count = parseInt(state.count, 10);
}
```

### 5. Testing Pattern
```typescript
// Mock setup in test files
beforeEach(() => {
  jest.clearAllMocks();
  (FileLockManager.atomicWriteFile as jest.Mock) = jest.fn().mockResolvedValue(undefined);
  (FileLockManager.atomicReadFile as jest.Mock) = jest.fn();
  (SecurityMonitor.logSecurityEvent as jest.Mock) = jest.fn();
});

// File content mocking
(FileLockManager.atomicReadFile as jest.Mock).mockImplementation(async (path: string) => {
  if (path.includes('.state.yaml')) {
    return `---\nstate: data\n---`;
  } else {
    return `---\nmetadata: data\n---\nContent`;
  }
});
```

## Common Pitfalls & Solutions

### 1. YAML Type Issues
**Problem**: FAILSAFE_SCHEMA only supports strings
**Solution**: Convert all types to strings, parse back on load

### 2. Mock Type Errors
**Problem**: `jest.mocked()` doesn't work with our setup
**Solution**: Use type casting: `(Class.method as jest.Mock)`

### 3. Frontmatter Parsing
**Problem**: SecureYamlParser expects full content with markers
**Solution**: When parsing extracted frontmatter, wrap it:
```typescript
SecureYamlParser.parse(`---\n${frontmatter}\n---`, options)
```

### 4. BaseElement Defaults
**Problem**: BaseElement sets default name "Unnamed Element"
**Solution**: Always pass name in metadata to avoid defaults

### 5. Test File Access
**Problem**: Real files created during tests
**Solution**: Mock fs.access to control file existence:
```typescript
jest.spyOn(fs, 'access').mockResolvedValueOnce(); // File exists
jest.spyOn(fs, 'access').mockRejectedValueOnce({ code: 'ENOENT' }); // Not exists
```

## Manager Implementation Checklist

- [ ] Extends correct path from portfolio
- [ ] Uses FileLockManager for all file ops
- [ ] Uses SecureYamlParser for YAML parsing
- [ ] Implements IElementManager interface
- [ ] Has validateName() method
- [ ] Has validatePath() method
- [ ] Handles state persistence
- [ ] Logs security events
- [ ] Sanitizes all inputs
- [ ] Checks file sizes

## Element Implementation Checklist

- [ ] Extends BaseElement
- [ ] Implements IElement
- [ ] Constructor sanitizes inputs
- [ ] Has memory limits
- [ ] Implements validate()
- [ ] Implements serialize()
- [ ] Implements deserialize()
- [ ] Has activate/deactivate if needed
- [ ] Logs security events
- [ ] Cleans up in deactivate()

## Review Response Patterns

### For Security Comments
"Added comprehensive inline documentation explaining:
- What the vulnerability was
- How it was fixed
- Why the fix improves security
- Before/after examples"

### For Test Coverage
"Added X additional tests covering:
- Edge case scenarios
- Security validation
- Error conditions
- Performance limits"

### For Performance Concerns
"Implemented limits to prevent resource exhaustion:
- MAX_ITEMS = X
- Automatic cleanup when limit reached
- Efficient data structures for lookups"

---
*Reference this for all future element implementations*