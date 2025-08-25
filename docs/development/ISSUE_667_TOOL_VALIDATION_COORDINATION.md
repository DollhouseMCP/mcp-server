# Issue #667: QA Tool Validation Implementation

**Date**: August 21, 2025 Evening  
**Branch**: `feature/qa-tool-validation-667`  
**Issue**: https://github.com/DollhouseMCP/mcp-server/issues/667  
**Orchestrator**: Opus 4.1  
**Agent**: TOOL-1 (Sonnet)  

## Mission Objective

Add tool validation to QA test scripts to prevent testing non-existent tools and provide accurate success rate reporting.

## Problem Statement

QA test scripts currently attempt to call MCP tools without first validating they exist, leading to:
- False negative test results when tools have been renamed/removed
- Misleading failure rates (50% actual vs claimed 98%)
- Tests failing on non-existent tools like `browse_marketplace`

## Solution Approach

1. **Tool Discovery**: Query MCP server for available tools at test start
2. **Validation Function**: Check if tool exists before attempting to test it
3. **Filtering**: Skip deprecated/non-existent tools automatically
4. **Accurate Reporting**: Calculate success rates only for valid tools

## Files to Modify

### Primary Scripts (Must Update)
- `scripts/qa-direct-test.js` - Main direct testing script
- `scripts/qa-simple-test.js` - Simple test runner
- `scripts/qa-github-integration-test.js` - GitHub integration tests
- `scripts/qa-element-test.js` - Element testing script
- `scripts/qa-test-runner.js` - Test orchestration runner

### Support Files
- `test-config.js` - Already has some tool lists, may need updates

## Implementation Details

### Step 1: Create Tool Discovery Function
```javascript
async discoverAvailableTools() {
  try {
    // Use MCP client to get list of available tools
    const tools = await this.client.listTools();
    return tools.tools.map(t => t.name);
  } catch (error) {
    console.error('Failed to discover tools:', error);
    return [];
  }
}
```

### Step 2: Add Validation Helper
```javascript
validateToolExists(toolName, availableTools) {
  if (!availableTools.includes(toolName)) {
    console.log(`  ⚠️  Skipping ${toolName} - tool not available`);
    return false;
  }
  return true;
}
```

### Step 3: Filter Before Testing
```javascript
// At start of test suite
this.availableTools = await this.discoverAvailableTools();
console.log(`📋 Discovered ${this.availableTools.length} available tools`);

// Before each tool test
if (!this.validateToolExists(toolName, this.availableTools)) {
  return { skipped: true, reason: 'Tool not available' };
}
```

### Step 4: Update Success Rate Calculation
```javascript
calculateAccurateSuccessRate(results) {
  // Filter out skipped tests
  const executed = results.filter(r => !r.skipped);
  const successful = executed.filter(r => r.success).length;
  const total = executed.length;
  
  return {
    successful,
    total,
    skipped: results.filter(r => r.skipped).length,
    percentage: total > 0 ? Math.round((successful / total) * 100) : 0
  };
}
```

## Agent Instructions for TOOL-1

### Your Mission
Implement tool validation in all QA test scripts to ensure only existing tools are tested.

### Specific Tasks
1. **Add tool discovery** to each QA script's initialization
2. **Implement validation** before each tool call
3. **Update reporting** to show skipped vs failed tests clearly
4. **Test the changes** to ensure scripts still work

### Success Criteria
- ✅ Tool discovery works and lists available tools
- ✅ Non-existent tools are skipped, not failed
- ✅ Success rates calculated only on valid tools
- ✅ Clear logging shows which tools were skipped
- ✅ All QA scripts updated consistently

### Important Notes
- The MCP SDK client has a `listTools()` method - use it
- Some tools in test-config.js are deprecated - that's expected
- Make sure to handle the async nature of tool discovery
- Test with at least one script before updating all

### Files You Should Modify
1. Start with `scripts/qa-direct-test.js` as the primary test
2. Then update the other scripts with the same pattern
3. Update test-config.js if needed for the tool lists

### Testing Your Changes
```bash
# Test the main script
node scripts/qa-direct-test.js

# Check that it:
# 1. Discovers tools at start
# 2. Skips non-existent tools
# 3. Reports accurate success rates
```

## Expected Outcome

### Before
```
Testing browse_marketplace...
❌ Error: Tool not found
Success Rate: 50% (false failures)
```

### After  
```
📋 Discovered 42 available tools
Testing browse_marketplace...
⚠️ Skipping browse_marketplace - tool not available
Success Rate: 95% (based on 40 valid tools tested)
Skipped: 2 tools
```

## Risk Mitigation

- **Risk**: Tool discovery might fail
- **Mitigation**: Fall back to testing all tools if discovery fails

- **Risk**: Breaking existing tests
- **Mitigation**: Test each change incrementally

## Definition of Done

- [ ] Tool discovery implemented in all QA scripts
- [ ] Validation function checks before each tool test
- [ ] Skipped tools logged clearly
- [ ] Success rates reflect only valid tools
- [ ] All scripts tested and working
- [ ] PR created with clear description

---

**Note for Agent TOOL-1**: Focus only on this issue. Don't fix other problems you might see - we'll handle those in separate PRs. Keep changes minimal and focused on tool validation only.