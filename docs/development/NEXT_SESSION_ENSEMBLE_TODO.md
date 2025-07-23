# Next Session: Ensemble Element TODO

## Immediate Priority (Blocking Merge)

### 1. Fix EnsembleManager Test Mocks
**Issue**: 20 tests failing due to Jest ES module mock setup
**Guide**: See `ENSEMBLE_JEST_MOCK_FIX_GUIDE.md`
**Quick Test**:
```bash
npm test -- test/__tests__/unit/elements/ensembles/EnsembleManager.test.ts
```

### 2. Clarify Activation Strategies
**Issue**: 'all' and 'parallel' do the same thing
**Options**:
1. Add comment explaining they're aliases
2. Remove one of them
3. Implement different behavior

**Code Location**: 
```typescript
// src/elements/ensembles/Ensemble.ts lines 270-271
case 'parallel':
case 'all':
  await this.activateParallel(activationOrder, result, metadata.maxActivationTime!);
```

## After Fixes

### 3. Update PR with Final Changes
```bash
git add -A
git commit -m "fix: Fix test mocks and clarify activation strategies

- Fixed EnsembleManager test mock setup for ES modules
- Added documentation for all/parallel strategy equivalence
- All tests now passing (60/60)

Addresses final review comments from PR #359"
git push
```

### 4. Request Final Review
```bash
gh pr comment 359 --body "## ✅ Final Fixes Complete

All remaining issues have been addressed:

1. **Test Mocks Fixed** - All 60 tests now passing
2. **Activation Strategies Clarified** - Added documentation explaining all/parallel equivalence

The PR is now ready for final review and merge.

### Test Results
- Ensemble.test.ts: ✅ 40/40 passing
- EnsembleManager.test.ts: ✅ 20/20 passing
- Build: ✅ Successful
- Security Audit: ✅ 0 findings"
```

### 5. Monitor and Merge
```bash
# Check CI status
gh pr checks 359 --watch

# Once all green, merge
gh pr merge 359 --merge
```

## Follow-up Work (After Merge)

### High Priority
- Issue #360: Properly differentiate all/parallel strategies
- Issue #361: Improve test mock infrastructure

### Medium Priority  
- Issue #362: Element factory pattern
- Issue #72: Context synchronization (move to correct repo)

### Low Priority
- Performance benchmarks
- Additional element types
- Enhanced documentation

## Quick Reference

### Branch Info
- **Current**: feature/ensemble-element-implementation
- **Target**: main
- **PR**: #359

### Test Commands
```bash
# All ensemble tests
npm test -- test/__tests__/unit/elements/ensembles/ --no-coverage

# Just EnsembleManager (the failing ones)
npm test -- test/__tests__/unit/elements/ensembles/EnsembleManager.test.ts

# Just Ensemble (the passing ones)
npm test -- test/__tests__/unit/elements/ensembles/Ensemble.test.ts
```

### Key Files
- `src/elements/ensembles/Ensemble.ts` - Main implementation
- `src/elements/ensembles/EnsembleManager.ts` - Persistence layer
- `test/__tests__/unit/elements/ensembles/EnsembleManager.test.ts` - Failing tests

## Success Criteria
- [ ] All 60 tests passing
- [ ] Activation strategy confusion resolved
- [ ] PR updated with final commits
- [ ] CI/CD all green
- [ ] PR merged to main

---
*Start here next session to complete the Ensemble implementation!*