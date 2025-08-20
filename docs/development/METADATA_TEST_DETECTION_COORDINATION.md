# Metadata-Based Test Detection - Multi-Agent Coordination Document

**Issue**: #649  
**Branch**: `feature/metadata-based-test-detection`  
**Start Time**: August 20, 2025 - Evening  
**Orchestrator**: Opus 4.1  
**Status**: 🟡 IN PROGRESS  

## Mission Statement
Replace filename-based test detection with metadata-based detection to give users complete naming freedom while maintaining 100% accuracy in identifying DollhouseMCP test files.

## Agent Team

| Agent | Model | Role | Status |
|-------|-------|------|--------|
| Orchestrator | Opus 4.1 | Overall coordination | 🟢 Active |
| Migration Agent | Sonnet 3.5 | Migrate test files with metadata | 🔄 Deploying |
| Documentation Agent | Sonnet 3.5 | Update all documentation | 🔄 Deploying |
| Testing Agent | Sonnet 3.5 | Create comprehensive tests | 🔄 Deploying |
| Implementation Agent | Sonnet 3.5 | Update DefaultElementProvider | ⏳ Pending |
| Reviewer Agent | Sonnet 3.5 | Review all changes | ⏳ Pending |

## Task Breakdown

### Phase 1: Setup ✅
- [x] Create feature branch
- [x] Create GitHub issue #649
- [x] Create this coordination document
- [ ] Wait for SafeDocumentParser (Issue #648)

### Phase 2: Parallel Work (Can run simultaneously)

#### Migration Agent Tasks
- [ ] Analyze all existing test files in:
  - `/test/fixtures/`
  - `/data/` (bundled test data)
  - Any test files in `/test/__tests__/`
- [ ] Create migration script at `/scripts/migrate-test-metadata.ts`
- [ ] Add `_dollhouseMCPTest: true` to all test files
- [ ] Add `_testMetadata` with suite/purpose/created/version
- [ ] Generate migration report
- [ ] Test migration is reversible

#### Documentation Agent Tasks
- [ ] Update README.md about test detection change
- [ ] Create `/docs/TEST_METADATA_CONVENTION.md`
- [ ] Update `/CONTRIBUTING.md` with new test file requirements
- [ ] Create migration guide for external contributors
- [ ] Update any references to filename patterns in docs

#### Testing Agent Tasks
- [ ] Create test fixtures with metadata at `/test/fixtures/metadata-detection/`
- [ ] Create test fixtures without metadata for comparison
- [ ] Write unit tests for metadata detection
- [ ] Create integration tests for production blocking
- [ ] Create performance benchmarks
- [ ] Test migration script thoroughly

### Phase 3: Implementation (Sequential - after Phase 2)

#### Implementation Agent Tasks
- [ ] Integrate SafeDocumentParser into DefaultElementProvider
- [ ] Create `isDollhouseMCPTestElement()` method
- [ ] Update `copyElementFiles()` to use metadata check
- [ ] Remove `isTestDataPattern()` method
- [ ] Remove `getCompiledTestPatterns()` method
- [ ] Remove `compiledTestPatterns` static field
- [ ] Remove all regex pattern constants
- [ ] Update logging messages

### Phase 4: Review & Testing (Sequential - after Phase 3)

#### Reviewer Agent Tasks
- [ ] Review all code changes for correctness
- [ ] Verify all test files have metadata
- [ ] Check test coverage is maintained
- [ ] Validate documentation completeness
- [ ] Run full test suite
- [ ] Performance testing
- [ ] Security review

## Success Criteria

### Must Have
- ✅ Zero false positives blocking user content
- ✅ 100% of test files correctly identified
- ✅ All tests passing
- ✅ Documentation complete
- ✅ Migration script works

### Should Have
- ✅ Performance < 50ms per file
- ✅ Memory usage stays low
- ✅ Clean git history

### Nice to Have
- ✅ Detailed migration report
- ✅ Performance benchmarks
- ✅ Rollback capability

## Communication Protocol

### Agent Updates
Agents should update this document with:
- Status changes (⏳ Pending → 🔄 In Progress → ✅ Complete)
- Blockers discovered
- Decisions needed
- Test results

### Format for Updates
```markdown
### [Agent Name] Update - [Timestamp]
**Status**: In Progress
**Progress**: Completed X of Y tasks
**Blockers**: None
**Notes**: [Any relevant information]
```

## Decisions Log

| Date | Decision | Rationale | Made By |
|------|----------|-----------|---------|
| Aug 20 | Use `_dollhouseMCPTest` with underscore | Clear system metadata indicator | User |
| Aug 20 | Remove ALL filename patterns | Eliminate false positives completely | User |
| Aug 20 | Multi-agent orchestration approach | Parallel work, thorough implementation | User |

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| SafeDocumentParser not ready | Low | High | Can implement basic version temporarily |
| Migration misses test files | Low | Medium | Reviewer agent will verify |
| Performance regression | Low | Low | Testing agent will benchmark |
| Breaking existing functionality | Low | High | Comprehensive test coverage |

## Test Results

### Migration Results
- Files analyzed: TBD
- Files migrated: TBD
- Errors: TBD

### Performance Results
- Metadata extraction time: TBD
- Bulk operation time: TBD
- Memory usage: TBD

### Test Coverage
- Unit tests: TBD
- Integration tests: TBD
- Overall coverage: TBD

## Notes Section

### Orchestrator Notes
- Created coordination structure
- Ready to deploy agents
- Waiting for SafeDocumentParser dependency

### Important Reminders
- The underscore in `_dollhouseMCPTest` is intentional
- We're removing ALL filename patterns, not keeping any
- Test metadata should be comprehensive for future use
- Migration must be complete before implementation

---

## Agent Communication Space

*Agents: Add your updates below this line*

---

### Orchestrator Update - Aug 20, 2025, Evening
**Status**: Active
**Progress**: Setup phase complete, deploying 3 parallel agents
**Blockers**: Waiting for SafeDocumentParser (Issue #648)
**Next Steps**: Monitor parallel agent progress, coordinate Implementation Agent later

### Orchestrator Agent Deployment - Aug 20, 2025
**Action**: Deploying 3 parallel agents for Phase 2 work
**Strategy**: Since SafeDocumentParser isn't ready, focusing on independent tasks
**Deployed Agents**: Migration, Documentation, Testing
