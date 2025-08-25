# Quick Wins Coordination Document

**Date**: August 22, 2025  
**Orchestrator**: Opus 4.1  
**Objective**: Implement performance quick wins and fix OAuth token persistence

## Current State

### Performance Issues Identified
1. **Tool Discovery**: Highly variable performance (6-207ms)
2. **Collection Browse**: 33% failure rate due to timeouts
3. **OAuth Token**: Not persisting after device flow authorization

### QA Metrics
- Current success rate: 94%
- Target: 100%
- Main blockers: Timeouts and OAuth authentication

## Task Breakdown

### Task 1: Tool Discovery Caching (Agent: Sonnet)
**Priority**: HIGH - Quick Win  
**Estimated Time**: 15 minutes  
**Impact**: Stabilize tool discovery performance

#### Requirements
- [ ] Create `ToolCache` class in `src/utils/ToolCache.ts`
- [ ] Cache tool discovery results with 1-minute TTL
- [ ] Integrate into main server class
- [ ] Add cache invalidation on tool changes
- [ ] Add performance logging to verify improvement

#### Success Criteria
- Tool discovery consistently < 10ms after first call
- Cache properly expires after 1 minute
- No stale data issues

#### Implementation Notes
- Use Map for O(1) lookups
- Include timestamp with cached data
- Consider memory limits (max 100 entries)

---

### Task 2: Collection Index Lazy Loading (Agent: Sonnet)
**Priority**: HIGH - Quick Win  
**Estimated Time**: 30 minutes  
**Impact**: Eliminate browse_collection timeouts

#### Requirements
- [ ] Create `CollectionIndexManager` class in `src/collection/CollectionIndexManager.ts`
- [ ] Implement background fetching with 1-hour TTL
- [ ] Add local file caching in `~/.dollhouse/cache/collection-index.json`
- [ ] Return stale cache while refreshing in background
- [ ] Add retry logic with exponential backoff
- [ ] Add connection timeout configuration (default 5s, configurable via env)

#### Success Criteria
- No browse_collection timeouts
- Index refreshes automatically in background
- Graceful degradation with stale cache
- Configurable timeout via `COLLECTION_FETCH_TIMEOUT` env var

#### Implementation Notes
- Store index with metadata (timestamp, version, checksum)
- Use setTimeout(..., 0) for background refresh
- Implement circuit breaker pattern for repeated failures

---

### Task 3: OAuth Token Polling Fix (Orchestrator Investigation)
**Priority**: CRITICAL - Blocks Roundtrip  
**Estimated Time**: Investigation first, then implementation

#### Investigation Steps
1. Review current OAuth flow in `src/auth/GitHubAuthManager.ts`
2. Check why `pollForToken()` isn't called from MCP tools
3. Verify token storage mechanism
4. Test with real GitHub OAuth app

#### Known Issues
- `setup_github_auth` only returns device code
- Never polls for token completion
- Token not stored after user authorizes

#### Fix Requirements
- [ ] Update `AuthTools.ts` to poll for token after device flow
- [ ] Store token securely (keychain on Mac, credential store on Windows)
- [ ] Add timeout handling (5 minutes max)
- [ ] Add progress indicators during polling
- [ ] Test full roundtrip flow

---

## Agent Instructions

### For Task 1 (Tool Discovery Caching)
```
Create a simple but effective caching mechanism for tool discovery:

1. Create src/utils/ToolCache.ts with:
   - Generic cache class with TTL support
   - Memory limit protection (max 100 entries)
   - Performance metrics logging

2. Integrate into src/index.ts:
   - Cache tool discovery results
   - Invalidate on tool changes
   - Add debug logging for cache hits/misses

3. Test that:
   - First call fetches tools (>5ms)
   - Subsequent calls use cache (<1ms)
   - Cache expires after 1 minute

Focus on simplicity and reliability. Don't over-engineer.
```

### For Task 2 (Collection Index Lazy Loading)
```
Implement robust collection index management with offline support:

1. Create src/collection/CollectionIndexManager.ts with:
   - Background refresh mechanism
   - Local file caching for offline use
   - Configurable timeouts via environment variables
   - Retry logic with exponential backoff

2. Key features:
   - Return cached index immediately if available
   - Refresh in background without blocking
   - Handle network failures gracefully
   - Store index with metadata (timestamp, checksum)

3. Integration points:
   - Update browse_collection tool to use manager
   - Add startup preload (non-blocking)
   - Add manual refresh command

4. Error handling:
   - Network timeouts: use cached version
   - Parse errors: log and use previous valid
   - No cache: single blocking fetch with timeout

Make it bulletproof - this is a critical user-facing feature.
```

## Coordination Notes

### Parallel Execution
- Task 1 and Task 2 can run in parallel (different agents)
- Task 3 requires investigation before implementation

### Dependencies
- OAuth fix may depend on understanding current token storage
- Collection index may need OAuth for private repos (future)

### Testing Strategy
1. Unit tests for cache classes
2. Integration tests with QA framework
3. Manual testing of OAuth flow
4. Full roundtrip test once OAuth works

## Success Metrics

### Performance
- Tool discovery: P95 < 10ms (from 207ms)
- Collection browse: 0% timeout rate (from 33%)
- Overall QA success: 100% (from 94%)

### Functionality
- OAuth token persists across sessions
- Full roundtrip test passes
- No race conditions or memory leaks

## Timeline

### Phase 1: Quick Wins (30 minutes)
- [ ] Tool discovery caching (15 min)
- [ ] Collection index lazy loading (30 min)
- Both can run in parallel

### Phase 2: OAuth Investigation (30 minutes)
- [ ] Understand current implementation
- [ ] Identify exact failure point
- [ ] Design fix approach

### Phase 3: OAuth Implementation (1 hour)
- [ ] Implement token polling
- [ ] Add secure storage
- [ ] Test full flow

## Notes for Agents

- Keep changes minimal and focused
- Add comprehensive error handling
- Include debug logging for troubleshooting
- Write clear comments explaining design decisions
- Test edge cases (network down, slow responses, etc.)

---

*Ready to delegate tasks to Sonnet agents for parallel execution*