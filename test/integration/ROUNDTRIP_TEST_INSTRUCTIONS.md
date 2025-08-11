# Roundtrip Collection Workflow Test

## Overview
This test validates the complete collection workflow using a test skill that exists in the DollhouseMCP/collection repository.

## Test Skill Location
The test skill is available at:
https://github.com/DollhouseMCP/collection/blob/main/library/skills/roundtrip-test-skill.md

---

## Complete Roundtrip Test Instructions

### Step 1: Download the Test Skill
```
Please download the Roundtrip Test Skill from the collection:
1. Go to https://github.com/DollhouseMCP/collection/blob/main/library/skills/roundtrip-test-skill.md
2. Copy the entire content
3. Save it locally as ~/.dollhouse/portfolio/skills/roundtrip-test-skill.md
4. Confirm it's saved by running: list_elements --type skills
```

**Alternative (if you have browse_marketplace):**
```
browse_marketplace skills
install_marketplace_element "skills/roundtrip-test-skill.md"
```

### Step 2: Modify the Skill Locally
```
Please modify the Roundtrip Test Skill:
1. Edit the skill at ~/.dollhouse/portfolio/skills/roundtrip-test-skill.md
2. Change the version from "1.0.0" to "1.0.1"
3. Add a line at the end: "Modified by: mickdarling at [current timestamp]"
4. Save the changes
```

**Or use edit_element if available:**
```
edit_element "Roundtrip Test Skill" --type skills version "1.0.1"
```

### Step 3: Test Portfolio Upload WITHOUT Auto-Submit
```
Please test portfolio upload without collection submission:
1. First, disable auto-submit: configure_collection_submission autoSubmit: false
2. Verify it's disabled: get_collection_submission_config
3. Submit the skill: submit_content "Roundtrip Test Skill"
4. Tell me:
   - Was it uploaded to the portfolio?
   - What's the portfolio URL?
   - Was a collection issue created? (Should be NO)
```

**Expected Result:**
- ✅ Uploaded to https://github.com/mickdarling/dollhouse-portfolio/blob/main/skills/roundtrip-test-skill.md
- ❌ No issue in DollhouseMCP/collection
- 💡 Message about manual submission option

### Step 4: Check GitHub Portfolio
```
Please verify the portfolio upload:
1. Go to https://github.com/mickdarling/dollhouse-portfolio
2. Navigate to skills/roundtrip-test-skill.md
3. Verify:
   - The file exists
   - Version shows "1.0.1"
   - Your modification is present
   - Commit message mentions the skill
```

### Step 5: Test WITH Auto-Submit (Full Roundtrip)
```
Please complete the roundtrip with auto-submission:
1. Enable auto-submit: configure_collection_submission autoSubmit: true
2. Verify it's enabled: get_collection_submission_config
3. Make another small change to the skill (e.g., version to "1.0.2")
4. Submit again: submit_content "Roundtrip Test Skill"
5. Tell me:
   - Was it uploaded to the portfolio?
   - Was a collection issue created?
   - What's the issue URL?
```

**Expected Result:**
- ✅ Updated in portfolio
- ✅ Issue created in DollhouseMCP/collection
- 🏷️ Labels: contribution, pending-review, skills
- 📋 Issue contains portfolio URL and metadata

### Step 6: Verify Collection Issue
```
Please check the collection issue:
1. Go to the issue URL from Step 5
2. Or visit: https://github.com/DollhouseMCP/collection/issues
3. Find the issue titled "[skills] Add Roundtrip Test Skill by @mickdarling"
4. Verify:
   - Title format is correct
   - Labels are applied (contribution, pending-review, skills)
   - Body contains portfolio URL
   - Metadata shows version "1.0.2"
   - Author is @mickdarling
```

### Step 7: Test Error Scenarios
```
Please test error handling:
1. Try submitting a non-existent skill: submit_content "This Skill Does Not Exist"
   - Expected: Error message about not finding the skill
2. Try submitting with a very long name: submit_content "This Is A Really Really Really Long Skill Name That Should Probably Be Shortened But We Are Testing Limits Here"
   - Expected: Either works or gives helpful error
```

### Step 8: Clean Up
```
Please reset the configuration:
1. Disable auto-submit: configure_collection_submission autoSubmit: false
2. Verify: get_collection_submission_config
3. The test is complete!
```

---

## Success Criteria Checklist

After completing all steps, verify:

### Configuration
- [ ] `get_collection_submission_config` works
- [ ] `configure_collection_submission` changes settings
- [ ] Settings correctly control behavior

### Portfolio Operations
- [ ] Skill uploaded to GitHub portfolio
- [ ] Correct file path (skills/roundtrip-test-skill.md)
- [ ] Modifications preserved in upload
- [ ] Version changes reflected

### Collection Submission
- [ ] Auto-submit OFF = no collection issue
- [ ] Auto-submit ON = collection issue created
- [ ] Issue has correct title format
- [ ] Issue has correct labels
- [ ] Issue contains portfolio URL
- [ ] Issue shows metadata

### Error Handling
- [ ] Non-existent content handled gracefully
- [ ] Clear error messages
- [ ] No data loss on errors

### Complete Roundtrip
- [ ] Skill went from collection → local → modified → portfolio → collection
- [ ] All metadata preserved
- [ ] Author attribution correct
- [ ] Workflow feels smooth

---

## Quick Test (5 minutes)

If you're short on time, just test the core functionality:

```
1. Create a simple test skill locally:
   create_skill "Quick Test Skill" "A quick test" "testing" 

2. Test without auto-submit:
   configure_collection_submission autoSubmit: false
   submit_content "Quick Test Skill"
   (Should upload to portfolio only)

3. Test with auto-submit:
   configure_collection_submission autoSubmit: true
   create_skill "Auto Test Skill" "Auto submit test" "testing"
   submit_content "Auto Test Skill"
   (Should upload to portfolio AND create collection issue)

4. Check results:
   - Portfolio: https://github.com/mickdarling/dollhouse-portfolio
   - Collection: https://github.com/DollhouseMCP/collection/issues
```

---

## Troubleshooting

**If authentication fails:**
```
gh auth login --web
```

**If portfolio doesn't exist:**
The first submission will create it automatically.

**If collection issue fails:**
- Check you're authenticated
- Check the error message
- Try manual submission URL provided in error

**To see what's happening behind the scenes:**
Check the MCP server logs for detailed information about each operation.

---

## Report Template

After testing, please provide a summary:

```
## Roundtrip Test Results

### Configuration Tools
- get_collection_submission_config: ✅/❌
- configure_collection_submission: ✅/❌

### Portfolio Upload
- Without auto-submit: ✅/❌
- With auto-submit: ✅/❌
- Modifications preserved: ✅/❌

### Collection Submission
- Issue created when enabled: ✅/❌
- Correct labels: ✅/❌
- Correct format: ✅/❌

### Complete Roundtrip
- Collection → Local → Modified → Portfolio → Collection: ✅/❌

### Issues Found
[List any problems]

### Overall Assessment
[Working well / Needs fixes / Specific issues]
```