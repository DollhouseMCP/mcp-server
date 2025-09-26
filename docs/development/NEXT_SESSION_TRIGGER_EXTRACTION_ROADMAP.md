# Next Session: Trigger Extraction Roadmap

## Session Context
**Previous Work**: Memory trigger extraction fully implemented (PR #1133)
**Date**: September 26, 2025
**Status**: Ready to implement triggers for remaining element types

## Priority Order for Implementation

### 1. 🎯 Skills Trigger Extraction (#1121) - HIGHEST PRIORITY
**Why First**: Skills are action-oriented by nature, making them ideal for verb triggers
**Branch**: `feature/skills-trigger-extraction`
**Estimated Time**: 2-3 hours

#### Implementation Checklist
- [ ] Create feature branch from develop
- [ ] Add `triggers?: string[]` to ISkillMetadata
- [ ] Update SkillManager to extract triggers from YAML
- [ ] Update BaseElement preservation (if needed)
- [ ] Add to EnhancedIndexManager.extractActionTriggers()
- [ ] Create unit tests (follow MemoryManager.triggers.test.ts pattern)
- [ ] Create integration tests
- [ ] Test manually with skill files
- [ ] Create PR with comprehensive description

#### Expected Triggers for Skills
- Action verbs: "analyze", "validate", "optimize", "debug", "scan"
- Domain-specific: "security", "performance", "quality"
- Tool-specific: "lint", "format", "compile"

#### Test Skills to Create
```yaml
name: code-analyzer
metadata:
  triggers: [analyze, scan, review, audit, inspect]
  description: Analyzes code for issues
```

### 2. 📄 Templates Trigger Extraction (#1122) - MEDIUM PRIORITY
**Why Second**: Templates have clear use cases that map to triggers
**Branch**: `feature/templates-trigger-extraction`
**Estimated Time**: 2 hours

#### Implementation Notes
- Templates use different verbs than skills
- Focus on document types: "create", "generate", "draft"
- Consider template categories as implicit triggers

#### Expected Triggers for Templates
- Creation verbs: "create", "generate", "draft", "compose"
- Document types: "email", "report", "proposal", "readme"
- Actions: "format", "structure", "outline"

### 3. 🤖 Agents Trigger Extraction (#1123) - LOWER PRIORITY
**Why Third**: Agents are more complex, goal-oriented rather than verb-oriented
**Branch**: `feature/agents-trigger-extraction`
**Estimated Time**: 2-3 hours

#### Special Considerations
- Agents might need both action triggers AND goal triggers
- Consider two-level trigger system
- May need different extraction logic

#### Expected Triggers for Agents
- Goal verbs: "achieve", "complete", "solve", "coordinate"
- Process verbs: "plan", "execute", "monitor", "iterate"
- Domain-specific: "research", "investigate", "troubleshoot"

## Implementation Pattern Reference

### Quick Copy-Paste Template
```typescript
// In [ElementType].ts
const MAX_TRIGGER_LENGTH = 50;
const TRIGGER_VALIDATION_REGEX = /^[a-zA-Z0-9\-_]+$/;

// In [ElementType]Manager.ts
triggers: Array.isArray(metadataSource.triggers) ?
  metadataSource.triggers
    .map((trigger: string) => sanitizeInput(trigger, MAX_TRIGGER_LENGTH))
    .filter((trigger: string) => trigger && TRIGGER_VALIDATION_REGEX.test(trigger))
    .slice(0, 20) :
  [],

// In EnhancedIndexManager.ts
case 'elementType': {
  const manager = [ElementType]Manager.getInstance();
  const elements = await manager.listElements();

  for (const elementName of elements) {
    try {
      const element = await manager.getElement(elementName);
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

## Testing Strategy

### For Each Element Type
1. **Unit Tests** (10-12 tests)
   - Valid trigger extraction
   - Invalid character filtering
   - Length validation (>50 chars)
   - Count limits (>20 triggers)
   - Empty/null arrays
   - Special characters
   - Case normalization
   - Duplicate handling

2. **Integration Tests** (5-6 tests)
   - Element appears in verb search
   - Multiple elements with same trigger
   - No triggers scenario
   - Index rebuild with triggers
   - Cross-element type searches

3. **Performance Tests** (2-3 tests)
   - 200+ triggers handling
   - Large YAML files
   - Concurrent access

## Common Pitfalls to Avoid

### From Memory Implementation Experience
1. **TypeScript Type Errors**: Always add explicit type annotations in filter/map
2. **ESM Compatibility**: Be prepared to add tests to ignore list
3. **BaseElement Modification**: Test YAML serialization after changes
4. **Index Rebuild**: Clear index file when testing locally
5. **CI Failures**: Run `npm run build` before committing

## Verification Steps

### After Each Implementation
```bash
# 1. Build check
npm run build

# 2. Run specific tests
npm test -- [ElementType]Manager.triggers

# 3. Check integration
rm ~/.dollhouse/portfolio/capability-index.yaml
# Restart server, create element with triggers
# Search using trigger verb

# 4. Verify index
cat ~/.dollhouse/portfolio/capability-index.yaml | grep action_triggers -A 30

# 5. Run full test suite
npm test
```

## Session Goals

### Minimum Viable Session
- [ ] Complete Skills trigger extraction (#1121)
- [ ] All tests passing
- [ ] PR created and CI green

### Stretch Goals
- [ ] Complete Templates trigger extraction (#1122)
- [ ] Start Agents trigger extraction (#1123)

### Documentation Goals
- [ ] Update implementation guide with lessons learned
- [ ] Create session notes for completed work
- [ ] Update issue status

## Pre-Session Checklist

### Setup
```bash
# 1. Ensure on develop
git checkout develop
git pull

# 2. Check CI status
gh workflow list --all | grep failing

# 3. Review open PRs
gh pr list

# 4. Check issue status
gh issue view 1121
gh issue view 1122
gh issue view 1123
```

## Quick Commands

### Create Feature Branch
```bash
git checkout develop
git pull
git checkout -b feature/skills-trigger-extraction
```

### Run Targeted Tests
```bash
# Skills tests only
npm test -- --testPathPattern="Skill.*trigger"

# Integration tests
npm test -- --testPathPattern="integration.*skill"
```

### Create PR
```bash
gh pr create --base develop \
  --title "feat: Add trigger extraction for Skills elements" \
  --body "Implements trigger extraction for Skills as part of Enhanced Index improvements.

Fixes #1121

Following the pattern established in PR #1133 for Memory triggers."
```

## Success Metrics

### Per Element Type
- ✅ Triggers extracted from metadata
- ✅ Elements appear in verb search
- ✅ All tests passing (unit, integration, performance)
- ✅ CI fully green
- ✅ PR merged to develop

### Overall
- ✅ All three element types implemented
- ✅ Enhanced Index fully functional with all triggers
- ✅ Documentation updated
- ✅ Issues closed

## Notes from Previous Session

### What Worked Well
- Following established pattern from memories
- Creating comprehensive tests upfront
- Implementing real features, not just TODOs
- Quick hotfix for ESM compatibility

### What to Improve
- Check CI more frequently during development
- Run build before every commit
- Test in Node 22.x environment if possible

## Resources

### Key Files to Reference
- `src/elements/memories/Memory.ts` - Validation pattern
- `src/elements/memories/MemoryManager.ts` - Extraction pattern
- `test/unit/MemoryManager.triggers.test.ts` - Test pattern
- `docs/development/TRIGGER_EXTRACTION_IMPLEMENTATION_GUIDE.md` - Full guide

### Related PRs
- PR #1133 - Memory trigger implementation (reference)
- PR #1134 - ESM compatibility fix
- PR #1135 - Documentation

## Time Estimates

### Conservative Timeline
- Skills: 3 hours (with tests and PR)
- Templates: 2.5 hours
- Agents: 3 hours
- **Total**: 8.5 hours (2-3 sessions)

### Optimistic Timeline
- Skills: 2 hours
- Templates: 1.5 hours
- Agents: 2 hours
- **Total**: 5.5 hours (1-2 sessions)

## Final Reminders

1. **Always run `npm run build` before committing**
2. **Add explicit TypeScript types to avoid CI failures**
3. **Test locally before pushing**
4. **Update session notes after each element type**
5. **Create PRs incrementally, don't batch all three**

---
*Ready for next session - all patterns established and documented*
*Start with Skills (#1121) as highest priority*