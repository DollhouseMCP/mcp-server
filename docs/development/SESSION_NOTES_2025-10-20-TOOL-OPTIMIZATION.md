# Session Notes - October 20, 2025

**Date**: October 20, 2025
**Time**: Evening session
**Focus**: DollhouseMCP Tool Optimization Investigation
**Outcome**: ✅ Identified major optimization opportunity and created implementation issue

---

## Session Summary

Investigated DollhouseMCP "too many tools" warnings in Claude Code. Discovered that each MCP tool has ~500-600 tokens of baseline overhead, making tool removal 10-20x more effective than description optimization. Identified portfolio tools consolidation as the biggest single optimization win: merging 7 tools into 1 could save 2,500-3,000 tokens.

---

## Context

### Initial Problem
- Claude Code showing warnings about DollhouseMCP being too large
- MCP tools consuming 27.1k tokens (13.6% of context)
- 38 active DollhouseMCP tools registered
- Need to reduce token usage

### Key Questions Explored
1. How many tools are actually active? (38 confirmed)
2. What's the token distribution across tools?
3. Can we consolidate or remove tools?
4. What's the baseline overhead per tool?
5. Are portfolio tools redundant with portfolio_element_manager?

---

## Key Findings

### 1. Baseline Tool Overhead Discovery

**Critical insight**: Every MCP tool has ~500-600 tokens of unavoidable overhead:
- MCP prefix: `mcp__DollhouseMCP__` (~50-100 tokens)
- JSON structure: inputSchema boilerplate (~50-100 tokens)
- Claude Code presentation: formatting and metadata (~100-200 tokens)
- Tool name and minimal fields (~50-100 tokens)

**Evidence**: Smallest tools in system:
- `get_build_info` - 563 tokens
- `get_relationship_stats` - 572 tokens
- `get_collection_cache_health` - 577 tokens

**Implication**: Tool removal is 10-20x more effective than description shortening
- Removing 1 tool = Save 500-1,000 tokens
- Shortening 1 description = Save 20-30 tokens

### 2. Tool Inventory Analysis

**Active tools**: 38 (not 44 from source)
**Total token usage**: ~27.1k tokens

**Previously removed** (7 tools already optimized away):
- 3 User Identity tools (replaced by dollhouse_config)
- 4 Config tools (configure_indicator, get_indicator_config, etc.)

**Current breakdown by category**:
- Element Tools: 12 tools (largest category)
- Collection Tools: 7 tools
- Portfolio Tools: 6 tools
- Auth Tools: 5 tools
- EnhancedIndex Tools: 4 tools
- Config Tools: 2 tools
- Persona Tools: 1 tool
- Build Info: 1 tool

### 3. Largest Tools (by token count)

Top 10 from analysis:
1. portfolio_element_manager - 1,100 tokens
2. sync_portfolio - 927 tokens
3. search_portfolio - 863 tokens
4. search_all - 846 tokens
5. search_collection_enhanced - 846 tokens
6. dollhouse_config - 797 tokens
7. find_similar_elements - 727 tokens
8. get_element_relationships - 719 tokens
9. edit_element - 722 tokens
10. install_collection_content - 711 tokens

### 4. Portfolio Tools Consolidation Opportunity

**Discovery**: portfolio_element_manager already uses operation-based pattern (like dollhouse_config)

**Current state**: 7 portfolio tools consuming 5,683 tokens
1. portfolio_element_manager - 1,100 tokens (operations: download, upload, list-remote, compare)
2. portfolio_status - 599 tokens
3. init_portfolio - 670 tokens
4. portfolio_config - 678 tokens
5. sync_portfolio - 927 tokens
6. search_portfolio - 863 tokens
7. search_all - 846 tokens

**Proposed consolidation**: Expand to 11 operations in single tool
- Element ops (existing): download, upload, list-remote, compare
- Repository ops (new): status, init, config
- Bulk ops (new): sync
- Search ops (new): search, search-all

**Expected result**: 1 tool consuming ~2,500-3,000 tokens

**Savings**: 2,500-3,000 tokens (44-53% reduction)
**Tool count**: 38 → 32 tools (-15.8%)

### 5. Tool Operation Clarification

Investigated confusion about three similarly-named operations:
- **activate_element**: State management (turn element on/off, persists)
- **render_template**: Text generation (fill template with variables, one-time)
- **execute_agent**: Task execution (run autonomous agent toward goal)

These serve completely different purposes and cannot be consolidated.

---

## Optimization Strategies Evaluated

### Option A: Remove Diagnostic Tools
- Remove: oauth_helper_status, get_collection_cache_health, get_relationship_stats
- Savings: ~237 tokens (3 tools)
- Risk: Low
- Impact: Minimal

### Option B: Remove EnhancedIndex Tools
- Remove: All 4 EnhancedIndex tools
- Savings: ~747 tokens (4 tools)
- Risk: Medium (depends on usage)
- Impact: Moderate

### Option C: Consolidate Portfolio Tools ⭐ RECOMMENDED
- Merge 7 tools into 1
- Savings: 2,500-3,000 tokens (6 tools)
- Risk: Low (follows existing patterns)
- Impact: **MAJOR** - biggest single win

### Option D: Shorten Descriptions
- Optimize all 38 descriptions
- Savings: ~750-1,150 tokens
- Risk: Low
- Impact: Minimal compared to tool removal

**Conclusion**: Portfolio consolidation (Option C) is the clear winner.

---

## Actions Taken

### 1. Created Comprehensive Analysis Documents

**Tool inventory**: `/tmp/dollhousemcp-current-tools-inventory.md`
- Complete numbered list of all 44 tools in source code
- Comparison with 38 active tools
- Identified 7 previously removed tools

**Tool size analysis**: `/tmp/tool-size-optimization-analysis.md`
- All tools sorted by token count
- Optimization opportunities with savings calculations
- Conservative/Moderate/Aggressive approaches

**Portfolio comparison**: `/tmp/portfolio-tools-comparison.md`
- Detailed analysis of portfolio_element_manager vs 6 portfolio tools
- Explanation of why there's minimal overlap
- Functional differences

**Portfolio consolidation**: `/tmp/portfolio-consolidation-analysis.md`
- Detailed consolidation proposal
- Implementation example
- Benefits and downsides
- 3-phase implementation plan

**Element operations**: `/tmp/element-operations-comparison.md`
- Clarification of activate_element vs render_template vs execute_agent
- Why they can't be merged

**Baseline overhead**: `/tmp/minimal-tool-test.md`
- Analysis of minimum token cost per tool
- Why tool removal is most effective strategy

### 2. Created GitHub Issue

**Issue #1385**: "Consolidate 7 Portfolio Tools into Single portfolio Tool"
- Link: https://github.com/DollhouseMCP/mcp-server/issues/1385
- Labels: enhancement, area: performance
- Complete implementation plan with 3 phases
- Technical details and code examples
- Testing requirements
- Success metrics
- Estimated effort: 4-6 hours

### 3. Activated Audio Summarizer Workflow

Successfully configured and tested:
- conversation-audio-summarizer skill
- auto-whisper-activator skill
- Created memory documenting permission requirement: `Bash(say:*)`

---

## Technical Insights

### MCP Tool Structure Overhead

Every tool includes:
```typescript
{
  name: "mcp__DollhouseMCP__tool_name",  // Prefix adds tokens
  description: "...",                      // Variable size
  inputSchema: {                           // Structure overhead
    type: "object",
    properties: { ... },
    required: [...]
  }
}
```

Claude Code presents each as:
```
└ mcp__DollhouseMCP__tool_name (DollhouseMCP): XXX tokens
```

This presentation wrapper + JSON structure = ~500 token baseline.

### Operation-Based Pattern Success

Two existing tools prove this pattern works:
1. **dollhouse_config**: Consolidated 3 user identity tools
   - Operations: get, set, reset, export, import, wizard
   - Successfully reduced tool count

2. **portfolio_element_manager**: Already uses operations
   - Operations: download, upload, list-remote, compare
   - Proven pattern for expansion

### Why Verbose Descriptions Matter

User insight: "Part of the reason we have verbose descriptions is so the LLM has the context to know which tools to trigger at any particular moment when it's doing work automatically."

**Important consideration**: Description optimization must balance:
- Token reduction (shorter = fewer tokens)
- Tool discovery (verbose = better context for LLM selection)

This reinforces that **tool removal** is the better optimization strategy - we keep useful descriptions while eliminating baseline overhead.

---

## Key Learnings

1. **Baseline overhead dominates**: With 500-600 tokens per tool, removing 5 tools saves as much as optimizing all 38 descriptions

2. **Operation-based consolidation works**: We have two successful precedents (dollhouse_config, portfolio_element_manager)

3. **Portfolio tools are ideal candidates**: Already partially operation-based, logical grouping, massive savings

4. **Tool count matters more than descriptions**: 6 tools × 500 overhead = 3,000 tokens saved, regardless of description length

5. **Previously optimized**: System already removed 7 tools (UserTools, ConfigTools), showing ongoing optimization effort

6. **Don't consolidate functionally different tools**: activate_element, render_template, and execute_agent serve distinct purposes

---

## Next Session Priorities

### High Priority: Portfolio Consolidation (Issue #1385)

**Phase 1**: Expand portfolio_element_manager
- Add 7 new operations to existing 4
- Update inputSchema with all operation parameters
- Implement handler routing logic
- Write comprehensive tests

**Phase 2**: Deprecate old tools
- Mark 6 portfolio tools as deprecated
- Create migration documentation
- Update internal references

**Phase 3**: Remove old tools
- Delete PortfolioTools.ts
- Clean up registrations
- Final testing and verification

### Medium Priority: Consider Additional Consolidations

**Collection tools** (7 tools):
- Could merge search_collection into search_collection_enhanced (saves 1 tool)
- Keep others (browse, get, install, submit serve distinct purposes)

**EnhancedIndex tools** (4 tools):
- Evaluate usage metrics
- If rarely used, consider removal (saves 747 tokens)
- If valuable, keep all

**Diagnostic tools** (3 tools):
- Low-hanging fruit: oauth_helper_status, get_collection_cache_health
- Minor savings but easy win

### Low Priority: Description Optimization

Only after tool consolidation is complete:
- Analyze most verbose descriptions
- Shorten while maintaining LLM context
- Estimated 750-1,150 token savings

---

## Metrics and Success Criteria

### Current State
- **Tools**: 38 active
- **Token usage**: ~27.1k tokens (13.6% of context)
- **Status**: Claude Code showing "too many tools" warnings

### After Portfolio Consolidation
- **Tools**: 32 active (-15.8%)
- **Token usage**: ~24-25k tokens (-9-11%)
- **Status**: Should reduce warnings

### Ultimate Goal
- Get below warning threshold
- Maintain all functionality
- Preserve description quality for LLM tool selection

---

## Files Modified

None (investigation and planning session only)

---

## Documentation Created

1. `/tmp/dollhousemcp-current-tools-inventory.md` - Complete tool inventory
2. `/tmp/tool-size-optimization-analysis.md` - Token analysis and strategies
3. `/tmp/portfolio-tools-comparison.md` - Portfolio functionality comparison
4. `/tmp/portfolio-consolidation-analysis.md` - Detailed consolidation plan
5. `/tmp/element-operations-comparison.md` - Operation clarifications
6. `/tmp/minimal-tool-test.md` - Baseline overhead analysis
7. Memory: `audio-summarizer-permission-requirement` - Permission documentation

---

## Commands and Queries Run

```bash
# Tool inventory
cd ~/.dollhouse/claudecode-production/node_modules/@dollhousemcp/mcp-server
find . -name "*.js" -path "*/tools/*"
grep -r "name:" dist/server/tools/*.js

# Source analysis
cd /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/src/server/tools
wc -l *.ts
grep -A 1 'name: "' *.ts

# Python analysis script for token counting
python3 << 'PYEOF'
# [Token analysis script]
PYEOF

# Issue creation
gh issue create --title "Consolidate 7 Portfolio Tools into Single portfolio Tool" --body "..."
```

---

## References

- Issue #1385: Portfolio tools consolidation
- MCP Context: 27.1k tokens for DollhouseMCP tools
- Smallest tool: get_build_info at 563 tokens (baseline overhead proof)
- Precedent: dollhouse_config successfully consolidated 3 tools

---

## Session Reflection

**What went well**:
- Thorough investigation of tool overhead
- Discovery of baseline 500-600 token overhead per tool
- Identified clear optimization path with measurable impact
- Created detailed implementation issue with all needed info

**What was surprising**:
- How much overhead exists per tool (500-600 tokens minimum)
- That 7 tools were already removed (UserTools, ConfigTools)
- Portfolio tools were perfect consolidation candidates (already partially operation-based)

**What we learned**:
- Tool removal >> description optimization (10-20x more effective)
- Operation-based patterns work well (dollhouse_config precedent)
- Verbose descriptions serve a purpose (LLM tool selection)
- Each tool costs ~500 tokens even if it does nothing

**Next steps**:
- Implement portfolio consolidation (Issue #1385)
- Monitor token usage after changes
- Evaluate EnhancedIndex tools usage
- Consider minor optimizations after major wins

---

**Status**: Session complete, ready for implementation in future session
