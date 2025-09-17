# Session Notes - September 15, 2025 - Capability Index Planning

**Date**: September 15, 2025
**Time**: Evening Session (~7:50 PM)
**Duration**: ~45 minutes
**Focus**: Capability Index System design and planning
**Outcome**: ✅ Created comprehensive issue structure for new Capability Index feature

## Session Overview

Designed and documented a comprehensive Capability Index System to enable LLMs to discover and select DollhouseMCP elements based on their capabilities rather than just names. Created a full issue hierarchy for implementation.

## Key Accomplishments

### 1. Capability Index System Design (Issue #966) ✅

**Core Concept**: A lightweight, searchable index providing immediate context about all available DollhouseMCP elements and tools, enabling intelligent selection based on capabilities.

**Critical Insight**: The capability index MUST be injected into the LLM's context for effective discovery - LLMs won't look for capabilities they don't know exist.

### 2. Implementation Issues Created

#### Parent Issue
- **#966**: Capability Index System for Enhanced Element Discovery and Selection

#### Source-Specific Issues
- **#967**: Local Portfolio Capability Index
  - Real-time indexing of `~/.dollhouse/portfolio/`
  - File system monitoring for instant updates
  - No network dependencies

- **#968**: GitHub Portfolio Capability Index
  - Multi-repository support
  - API-based fetching with intelligent caching
  - ETag validation and rate limit awareness

- **#969**: Collection Capability Index
  - Pre-generated master index
  - CDN distribution for efficiency
  - Support for 1000+ elements

#### Technical Implementation Issues
- **#970**: LLM-Based Capability Description Generation
  - Critical dependency - capabilities require semantic understanding
  - Hybrid approach: GitHub Actions for collection, user's LLM for local
  - Cost analysis: ~$0.002 per element

- **#971**: Automated Capability Index Generation for GitHub Portfolios
  - Programmatic extraction from YAML frontmatter
  - GitHub Actions workflow creation via API
  - Reduces LLM dependency significantly

## Key Technical Decisions

### 1. Context Injection Strategy
Since MCP doesn't support automatic context injection at startup:
- **First-call pattern**: Inject index on first tool interaction
- **Progressive disclosure**: Start compact, expand based on usage
- **Tool description enrichment**: Embed capability hints

### 2. Hybrid Generation Approach
- **Programmatic extraction**: For elements with existing capability metadata
- **LLM generation**: Only for elements lacking descriptions
- **Caching**: Store generated capabilities in element metadata

### 3. GitHub Actions Automation
- DollhouseMCP can create workflows in user portfolios via API
- Requires `workflow` scope (already in our OAuth flow)
- Enables automatic index regeneration on push

## Architecture Highlights

### Index Structure
```yaml
version: "1.0.0"
generated: "2025-01-15T10:00:00Z"
sources:
  local: 45 elements
  github: 120 elements
  collection: 500+ elements

elements:
  personas:
    - id: "persona_creative-writer"
      capabilities: ["storytelling", "fiction", "character-development"]
      rating: 4.5

tools:
  - id: "create_element"
    capabilities: ["element creation", "validation"]
```

### Context Management Strategy
- **Compact initial index**: ~5-10KB
- **Priority filtering**: Most used, highest rated
- **Task-based expansion**: Relevant capabilities for current work
- **Ensemble awareness**: Highlight multi-element synergies

## Important Insights

### 1. Ensemble Amplification
Discovery that 20+ elements working together have drastically higher capabilities than individual elements. The index should highlight these synergistic combinations.

### 2. LLM Generation Requirement
Capability descriptions cannot be generated programmatically - they require semantic understanding that only LLMs can provide.

### 3. Workflow Automation Potential
We can programmatically create GitHub Actions in user portfolios, enabling automated index generation without constant manual intervention.

## Next Session Priorities

### Immediate Term
1. Continue new element type implementation
2. Address outstanding features and bugs
3. Proper breakdown of all priorities

### Near Term (Not Urgent)
1. Begin Capability Index implementation
2. Start with programmatic extraction (Issue #971)
3. Set up GitHub Actions for collection

### Future Considerations
1. Ensemble capability scoring
2. ML-based capability inference
3. Usage analytics integration

## Current State

### Repository Status
- **Version**: v1.8.1 (GitHub and NPM)
- **CI**: All workflows passing
- **Open Issues**: 6 new capability index issues created

### Capability Index Status
- **Planning**: Complete ✅
- **Issues**: Created and linked ✅
- **Implementation**: Not started ⏳
- **Priority**: Near-term (not urgent)

## Key Takeaways

1. **Context is King**: Capability information must be in LLM context from the start
2. **Hybrid Approach**: Combine programmatic extraction with LLM generation
3. **Automation Opportunity**: GitHub Actions can handle most indexing automatically
4. **Progressive Enhancement**: Start simple, add intelligence over time

## Files Created This Session

- `SESSION_NOTES_2025_09_15_CAPABILITY_INDEX_PLANNING.md` (this file)
- GitHub Issues: #966, #967, #968, #969, #970, #971

## Commands for Next Session

```bash
# Check current branch and status
cd /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server
git status

# Review capability index issues
gh issue list --label "area: elements" --limit 10

# Consider next element type implementation
# Or begin capability index prototype
```

---
*Session focused on architectural planning for the Capability Index System - a foundational feature for improving element discovery and selection in DollhouseMCP.*