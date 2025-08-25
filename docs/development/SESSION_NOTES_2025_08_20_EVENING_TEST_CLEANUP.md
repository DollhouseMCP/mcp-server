# Session Notes - August 20, 2025 Evening - Test Element Cleanup Required

## Critical Issue Discovered
Test elements are appearing in the user's actual portfolio directory (`~/.dollhouse/portfolio/personas/`) when they should NEVER be there. These test elements are polluting the user's portfolio with 100+ test personas including YAMLBomb, YAMLTest, and other dangerous test content.

## Root Cause Analysis

### What Should Happen
1. **Test data** should remain in `/test/` directory in the repository
2. **Legitimate content** comes from `/data/` directory in the repository  
3. **User portfolio** (`~/.dollhouse/portfolio/`) should only contain:
   - Content created by the user
   - Content installed from the `/data/` directory
   - Content installed from the DollhouseMCP collection

### What's Actually Happening
Test elements from the `/test/` directory have somehow been copied into the user's portfolio directory and are persisting there. This includes:
- 100+ YAMLBomb personas (lines 137-291 in QA test)
- 100+ YAMLTest personas (lines 293-729 in QA test)
- TestPersona variants (lines 77-99 in QA test)
- Dangerous-looking names like "rm -rf /" and "touch /tmp/pwned"

### Evidence
```bash
# Found test elements in actual portfolio:
/Users/mick/.dollhouse/portfolio/personas/yamlbomb1755626563559.md
/Users/mick/.dollhouse/portfolio/personas/yamltest1755368545406ju6qd.md
/Users/mick/.dollhouse/portfolio/personas/yamlbomb1755715831084.md
# ... and many more
```

## Action Plan for Next Session

### Step 1: Clean Up Portfolio
1. Identify all test element filenames in `/test/` directory
2. Create a script to remove matching files from `~/.dollhouse/portfolio/`
3. Verify only legitimate content remains

### Step 2: Find the Source of Contamination
Investigate how test content is getting into the portfolio:
1. Check test scripts - are they writing to the actual portfolio directory?
2. Check for any installation/migration code that might copy test data
3. Review any automated testing that might be using the real portfolio path

### Step 3: Prevent Future Contamination
1. Ensure all tests use temporary directories, not the user's portfolio
2. Add safeguards to prevent test data from being written to portfolio
3. Consider adding a check on startup to remove known test files

## Current Filtering Implementation

The code DOES have filtering in place:
```javascript
// In src/index.ts line 378:
.filter(file => !this.portfolioManager.isTestElement(file));
```

However, the patterns in `isTestElement()` are incomplete and miss many test files:
- Missing: `yamlbomb` (no pattern)
- Missing: `yamltest` (pattern looks for `yaml-test` with hyphen)
- Missing: `testpersona` variants (pattern only matches with digits)

## Important Discovery
The filtering approach (adding more patterns) is treating the symptom, not the cause. The real issue is that test data should never be in the portfolio folder in the first place.

## Next Session Priority
1. **URGENT**: Clean the portfolio of all test elements
2. **CRITICAL**: Find and fix the source of test data contamination
3. **IMPORTANT**: Add safeguards to prevent future contamination

## Files to Reference Next Session
- `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/docs/QA/persona-list-test-Aug-20-2025-003.md` - Shows the contaminated portfolio
- `/test/` directory - Contains test data that shouldn't be in portfolio
- `/data/` directory - Contains legitimate content for installation
- `~/.dollhouse/portfolio/` - User's portfolio that needs cleaning

## Key Insight
We've been approaching this wrong - instead of trying to filter out test elements with better patterns, we need to:
1. Remove test elements that shouldn't be there
2. Find out why they got there
3. Prevent them from getting there again

The test elements in the portfolio are not supposed to be filtered - they're not supposed to exist there at all.

---
*Session ending due to context limit. Continue with cleanup plan in next session.*