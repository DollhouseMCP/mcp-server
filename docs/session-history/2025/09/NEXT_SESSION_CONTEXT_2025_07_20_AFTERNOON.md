# Next Session Context - July 20, 2025 (Afternoon)

## Current Status
✅ Portfolio directory structure is implemented and merged (PR #301)
✅ Security vulnerabilities addressed
✅ Migration system operational
✅ 8 follow-up issues created for future improvements

## Immediate Next Steps

### 1. Create Abstract Element Interface (#295)
This is the next critical piece. We need to design and implement `IElement`:

```typescript
interface IElement {
  // Identity
  id: string;
  type: ElementType;
  version: string;
  
  // Metadata
  metadata: IElementMetadata;
  
  // Features
  references?: Reference[];
  extensions?: Record<string, any>;
  ratings?: ElementRatings;
  
  // Core operations
  validate(): ValidationResult;
  serialize(): string;
  deserialize(data: string): void;
  receiveFeedback?(feedback: string, context?: FeedbackContext): void;
  
  // Lifecycle
  beforeActivate?(): Promise<void>;
  activate?(): Promise<void>;
  afterActivate?(): Promise<void>;
  deactivate?(): Promise<void>;
  getStatus(): ElementStatus;
}
```

### 2. Update PersonaInstaller for Portfolio
The PersonaInstaller still uses the old personas directory. It needs:
- Update to use `PortfolioManager.getElementDir(ElementType.PERSONA)`
- Consider making it more generic for future element types
- Path: `src/collection/PersonaInstaller.ts`

### 3. Begin Persona Refactoring (#293)
Once IElement exists, refactor Persona to implement it:
- Extract common functionality
- Implement all interface methods
- Maintain backward compatibility
- Update tests

## Key Files to Remember

### Portfolio System (Just Implemented)
- `src/portfolio/PortfolioManager.ts` - Directory management
- `src/portfolio/MigrationManager.ts` - Migration logic
- `src/server/startup.ts` - Integration point (unused currently)
- `test/__tests__/unit/portfolio/` - All tests

### Files Needing Updates
- `src/collection/PersonaInstaller.ts` - Still uses old path
- `src/update/BackupManager.ts` - May need portfolio awareness
- Various test files that reference personas directory

## Design Decisions Made
1. **No backward compatibility** for MCP tools (clean break)
2. **Element** terminology (not "content type")
3. **Portfolio** structure with type-specific subdirectories
4. **Automatic migration** with optional backup
5. **Security-first** approach with comprehensive validation

## Technical Debt to Track
High Priority (Issues #302, #303):
- File locking for concurrent operations
- Atomic file operations

Medium Priority (Issues #304-306, #308):
- Pagination for large collections
- More security tests
- Concurrent access tests
- Migration failure recovery

Low Priority (Issues #307, #309):
- Performance benchmarks
- Enhanced backup features

## Environment Setup
```bash
# Current state
- On main branch
- Portfolio structure merged
- All tests passing
- 8 new issues created

# For next session
git pull origin main
npm test # Verify everything still works
```

## Implementation Timeline
We're on track with the 16-17 session plan:
- ✅ Session 1: Portfolio structure (DONE)
- 🔄 Session 2: Abstract element interface (NEXT)
- Sessions 3-4: Refactor personas
- Sessions 5-17: Implement remaining element types

## Critical Success Factors
1. IElement interface must be extensible
2. Maintain existing persona functionality
3. Keep tests passing during refactor
4. Document patterns for future elements

## Questions to Consider Early
1. How will element references work across types?
2. Should ratings be stored separately or inline?
3. How to handle element dependencies?
4. Migration strategy for existing personas to new format?

---
*Ready to continue building the element type system on a solid, secure foundation!*