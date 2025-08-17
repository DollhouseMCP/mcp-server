# Next Session: Fix Initialization Race Condition (Issue #610)

**Priority**: HIGH - Blocks PR #606  
**Estimated Time**: 1-2 hours  
**Approach**: Opus orchestrator with specialized Sonnet agents

## Starting Context

### The Problem
- MCP server doesn't respond to commands in PR #606
- Race condition: server connects before portfolio/personas load
- Legacy pattern from personas-only days causing issues

### The Solution
Move initialization from constructor to `run()` method to ensure proper sequencing.

## Agent Architecture for Next Session

### Orchestrator: Opus
Coordinates the fix across multiple aspects and maintains big picture view.

### Specialized Agents Needed

#### 1. **InitializationAnalyzer Agent**
**Purpose**: Analyze current initialization flow  
**Tasks**:
- Map all initialization dependencies
- Identify what must happen before MCP connection
- Find all async operations in constructor
- Document current initialization order

**Starting Points**:
- `src/index.ts` constructor (lines 97-184)
- `initializePortfolio()` method
- `run()` method (line 4865)

#### 2. **RefactorImplementer Agent**
**Purpose**: Implement the initialization fix  
**Tasks**:
- Move initialization logic to `run()` method
- Ensure proper await sequencing
- Maintain backward compatibility
- Preserve all error handling

**Key Changes**:
```typescript
// Move from constructor to run()
async run() {
  await this.initializePortfolio();
  await this.initializeCollectionCache();
  // Then connect
  await this.server.connect(transport);
}
```

#### 3. **TestValidator Agent**
**Purpose**: Verify the fix works  
**Tasks**:
- Test MCP commands work locally
- Verify Docker tests pass
- Ensure no regression in existing tests
- Document test results

**Test Commands**:
```bash
# Local MCP test
echo '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}' | node dist/index.js

# Docker test
docker compose --file docker/docker-compose.yml run --rm -T dollhousemcp
```

#### 4. **DocumentationTracker Agent**
**Purpose**: Document changes for Issue #512  
**Tasks**:
- Track what initialization code was moved
- Note dependencies discovered
- Document for future refactoring
- Update coordination documents

**Files to Update**:
- `COORDINATION_SEARCH_INDEX_FIXES.md`
- Create `INIT_FIX_610_IMPLEMENTATION.md`

## Agent Coordination Document Template

```markdown
# Agent Coordination - Issue #610 Initialization Fix

## Agent Status

### InitializationAnalyzer
- [ ] Started analysis
- [ ] Mapped dependencies
- [ ] Identified async operations
- [ ] Documented findings

### RefactorImplementer
- [ ] Received analysis
- [ ] Implemented changes
- [ ] Tested locally
- [ ] Created PR

### TestValidator
- [ ] Local tests pass
- [ ] Docker tests pass
- [ ] Regression tests pass
- [ ] Performance verified

### DocumentationTracker
- [ ] Changes documented
- [ ] Issue #512 updated
- [ ] PR description complete
- [ ] Handoff notes created

## Key Findings
[Agents add findings here]

## Blockers
[Agents note any blockers]

## Session History
[Track work across sessions]
```

## Critical Information for Agents

### Don't Change These
- Constructor signature (can't be async)
- Public API methods
- Error handling patterns
- Tool registration

### Must Preserve These
- All initialization that's currently working
- Error messages and logging
- Configuration loading
- Environment variable handling

### Known Dependencies
- Portfolio must initialize before personas
- PathValidator needs personasDir
- UpdateManager needs safe directory
- GitHub client needs early setup

## Success Criteria

1. **MCP Responds**: Server responds to JSON-RPC commands
2. **Docker Tests Pass**: No more timeouts
3. **No Regressions**: All existing tests still pass
4. **Clean Code**: Initialization is clear and sequential
5. **Documented**: Changes tracked for Issue #512

## Commands to Start Next Session

```bash
# Start on correct branch
git checkout develop
git pull origin develop
git checkout -b fix/server-initialization-race-condition

# Open key files
code src/index.ts
code docs/development/COORDINATION_SEARCH_INDEX_FIXES.md

# Have test ready
echo '{"jsonrpc":"2.0","method":"initialize","params":{},"id":1}' > test-mcp.json
```

## Links and References

### Issues and PRs
- **Issue #610**: Fix race condition in server initialization
- **Issue #512**: Refactor massive index.ts file
- **PR #606**: Search index implementation (blocked)
- **PR #609**: Docker debug infrastructure (reference for testing)

### Key Documentation to Read

#### Session Documents (Chronological)
1. `docs/development/SESSION_NOTES_2025_08_16_MORNING_DOCKER_INVESTIGATION.md`
   - Initial Docker hanging investigation
   - Discovered tests hanging for 30+ minutes

2. `docs/development/SESSION_NOTES_2025_08_16_AFTERNOON_DOCKER_BREAKTHROUGH.md`
   - Discovered MCP server waiting for STDIO
   - Found that server works but doesn't respond to commands

3. `docs/development/DOCKER_MCP_FIX_SESSION_2025_08_16_EVENING.md`
   - Identified race condition as root cause
   - Attempted fix to make tests more resilient

4. `docs/development/SESSION_COMPLETE_2025_08_16_DOCKER_FIXED.md`
   - Comprehensive summary of the problem
   - Clear explanation of legacy personas pattern
   - Action plan for fixes

#### Coordination Documents
- `docs/development/COORDINATION_SEARCH_INDEX_FIXES.md`
  - Bite-sized execution plan
  - Dependencies between issues
  - Timeline estimates

#### Technical References
- `docs/development/DOCKER_FIX_INTELLIGENCE_PR606.md`
  - Agent coordination from morning session
  - Details about 176KB index.ts file
  - Docker test analysis

- `docs/development/TEST_STATUS_ANALYSIS.md`
  - Current test status across all platforms
  - What's failing and why

#### Historical Context (Optional but Helpful)
- `docs/development/DOCKER_DEBUG_INTELLIGENCE.md`
  - Earlier Docker debugging attempts
  - Progressive testing approach

### Key Code Locations
- **Main Problem**: `src/index.ts` lines 97-184 (constructor with async init)
- **Run Method**: `src/index.ts` line 4865
- **Portfolio Init**: `src/index.ts` line 158 (`initializePortfolio().then()`)
- **Docker Tests**: `.github/workflows/docker-testing.yml`

## Session Goal

Fix the initialization race condition in the most contained way possible while:
1. Documenting everything for Issue #512
2. Maintaining forward progress
3. Not breaking existing functionality
4. Setting up for larger refactoring

---
*Ready for fresh session with full context for proper orchestrated agent approach*