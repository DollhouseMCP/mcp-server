# SOLUTION: Skills Won't Activate - Markdown Corruption Bug
**Date**: 2025-09-11 22:55:00
**Status**: ❌ BROKEN - NO WORKAROUND
**Checklist**: 0/10 items - CANNOT VERIFY
**Problem Category**: DollhouseMCP/Skills System
**Time Wasted**: ~1 hour debugging

## Problem Statement
### Error/Issue
```
Failed to activate skills 'verified-solutions-documenter': An unexpected error occurred. Please try again later.
```

### When This Occurs
- Creating any new skill through `create_element`
- Attempting to activate newly created skills
- Skills that should work perfectly fail silently

## Environment Context
### System Information
- **OS**: macOS Darwin 24.6.0
- **Shell**: zsh
- **Working Directory**: `/Users/mick/Developer/Organizations/DollhouseMCP`
- **User**: mick

### Environment Variables
```bash
DOLLHOUSE_PORTFOLIO_DIR=/Users/mick/.dollhouse
# Other MCP variables set correctly
```

### Tool Versions
```bash
node --version  # v20.x
npm --version   # 10.x
DollhouseMCP version # 1.7.x
```

## Prerequisites
### Required Before Starting
- [x] DollhouseMCP installed and running
- [x] Portfolio directory exists
- [x] Skills directory exists at `/Users/mick/.dollhouse/portfolio/skills/`
- [x] Proper permissions on directories

## What We Tried (ALL FAILED)

### Failed Approach 1: Create and Activate Skill
**What We Tried**: 
```bash
create_element "verified-solutions-documenter" --type skills
activate_element "verified-solutions-documenter" --type skills
```
**Why It Failed**: Markdown corruption during save
**Error Produced**: "An unexpected error occurred"

### Failed Approach 2: Delete and Recreate
**What We Tried**: 
```bash
delete_element "verified-solutions-documenter" --type skills --deleteData true
create_element "verified-solutions-documenter" --type skills
```
**Why It Failed**: Same markdown corruption pattern
**Error Produced**: Same activation error

### Failed Approach 3: Check File Content
**What We Tried**: Reading the saved file directly
**Why It Failed**: Found malformed markdown - headers merged with content
**Evidence**: Line 26: `# Verified Solutions DocumenterA comprehensive...`

## Common Mistakes (THESE DON'T WORK)
- ❌ **Don't**: Try to fix by recreating the skill
  - **Because**: The save process itself is broken
- ❌ **Don't**: Think it's your markdown formatting
  - **Because**: The system corrupts valid markdown
- ❌ **Don't**: Assume it's a specific skill problem
  - **Result**: ALL new skills have this issue

## Debug Journey

### Initial Hypothesis
"We thought the skill content was malformed"

### Investigation Path
1. Created skill with proper markdown - Failed on activation
2. Checked saved file - Found markdown corruption
3. Deleted and recreated - Same corruption pattern
4. Tested other skills - conversation-audio-summarizer works (old skill)
5. Realized ALL NEW skills fail

### Root Cause
**Actual Problem**: DollhouseMCP's markdown processor strips newlines between headers and content during save
**Why Missed Initially**: Error message "An unexpected error occurred" gives no clue about markdown corruption

## The REAL Bug

### File Corruption Pattern
```markdown
# What we send to create_element:
---
name: skill-name
---
# Skill Title

Description paragraph here.

# What gets saved to disk:
---
name: skill-name
---
# Skill TitleDescription paragraph here.
```

The newlines after headers are being stripped!

## Impact Analysis
- **Skills system**: COMPLETELY BROKEN for new skills
- **Documentation system**: Cannot use skills with personas
- **User experience**: Hours wasted thinking it's user error
- **Workaround**: NONE - must embed skill content in personas

## GitHub Issue Created
- Issue #935: https://github.com/DollhouseMCP/mcp-server/issues/935
- Priority: P0 - CRITICAL
- Label: bug

## What NOT to Do
1. **DON'T** keep trying to recreate the skill
2. **DON'T** think you're formatting markdown wrong
3. **DON'T** try different skill names or content
4. **DON'T** waste time on activation attempts

## Current Status
**🚨 WAITING FOR FIX IN DOLLHOUSEMCP**

No workaround exists. Skills cannot be activated until the markdown save process is fixed.

## Temporary Solution
Embed skill content directly in personas:
1. Create persona with skill documentation inline
2. Use persona instructions to reference skill patterns
3. Wait for DollhouseMCP fix

## Test for When It's Fixed
```bash
# Create test skill
create_element "test-skill" --type skills --content "# Test\n\nContent"

# Read the file
cat /Users/mick/.dollhouse/portfolio/skills/test-skill.md

# Should see:
# Test

Content

# NOT:
# TestContent
```

## Related Information
### See Also
- Session Notes: `/active/mcp-server/docs/development/SESSION_NOTES_2025_09_11_EVENING_COMPLETE.md`
- GitHub Issue: #935
- Solution Keeper persona (includes skill content inline as workaround)

### Credits
- Discovered by: Mick & Debug Detective
- Verified by: Alex Sterling
- Documented by: Solution Keeper

---
**Reproducibility Score**: N/A - Bug prevents any success
**Estimated Time Wasted**: 1+ hours per user who encounters this
**Last Verified**: 2025-09-11 22:55:00
**Status**: BROKEN UNTIL FIXED