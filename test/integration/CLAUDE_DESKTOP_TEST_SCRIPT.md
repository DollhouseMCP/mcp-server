# Claude Desktop Integration Test Script for Collection Submission

## Instructions
Copy each section below and paste into Claude Desktop to test the collection submission workflow.
Run each test in order and verify the expected results.

---

## Test 1: Check Initial Configuration
```
Please run these commands to check the initial configuration:
1. Run: get_collection_submission_config
2. Tell me what the current auto-submit setting is
```

**Expected:** Should show current configuration (likely autoSubmit: false initially)

---

## Test 2: Create a Test Persona
```
Please create a test persona for our integration testing:
1. Create a persona called "Integration Test Helper" with the description "A test persona for validating the collection submission workflow"
2. Set its category to "professional"
3. Give it the instructions: "You are a helpful assistant designed to test the DollhouseMCP collection submission workflow. You provide clear, concise responses and help verify that all systems are working correctly."
```

**Expected:** Persona created successfully in local portfolio

---

## Test 3: Test Portfolio Upload WITHOUT Auto-Submit
```
Please test submitting to portfolio without auto-submission:
1. First ensure auto-submit is disabled: configure_collection_submission autoSubmit: false
2. Then submit the "Integration Test Helper" persona: submit_content "Integration Test Helper"
3. Tell me:
   - Was it uploaded to the portfolio? 
   - What was the portfolio URL?
   - Was an issue created in the collection repo?
   - What message did you receive?
```

**Expected:** 
- ✅ Uploaded to portfolio at https://github.com/mickdarling/dollhouse-portfolio/...
- ❌ No issue created in collection
- 💡 Message about submitting to collection later

---

## Test 4: Enable Auto-Submit and Test
```
Please test with auto-submission enabled:
1. Enable auto-submit: configure_collection_submission autoSubmit: true
2. Verify it's enabled: get_collection_submission_config
3. Create another test persona called "Auto Submit Test" with description "Testing automatic collection submission"
4. Submit it: submit_content "Auto Submit Test"
5. Tell me:
   - Was it uploaded to the portfolio?
   - What was the portfolio URL?
   - Was an issue created in the collection repo?
   - What was the issue URL?
   - What labels were applied to the issue?
```

**Expected:**
- ✅ Uploaded to portfolio
- ✅ Issue created in DollhouseMCP/collection
- 🏷️ Labels: contribution, pending-review, personas
- 🎉 Success message with both URLs

---

## Test 5: Test with Non-Existent Content
```
Please test error handling with non-existent content:
1. Try to submit something that doesn't exist: submit_content "This Does Not Exist At All 12345"
2. Tell me what error message you received
```

**Expected:** Error message about not finding the content in local portfolio

---

## Test 6: Test Different Element Types
```
Please test with different element types:
1. Create a skill called "Code Review Expert" with description "Reviews code for quality and security"
2. Submit it: submit_content "Code Review Expert" 
3. If successful, check the GitHub issue and tell me:
   - What labels were applied?
   - Does the issue title show it's a skill?
```

**Expected:** 
- Labels should include "skills" instead of "personas"
- Title should say "[skills] Add Code Review Expert..."

---

## Test 7: Verify GitHub Portfolio
```
Please check my GitHub portfolio:
1. First, determine my GitHub username (you can check from previous test outputs or use 'gh auth status')
2. Go to https://github.com/{username} and look for the "dollhouse-portfolio" repository
2. Tell me:
   - Does the repository exist?
   - Are there any recent commits?
   - What personas/skills are in there?
```

**Expected:** Repository exists with recent test submissions

---

## Test 8: Verify Collection Issues
```
Please check the collection repository:
1. Go to https://github.com/DollhouseMCP/collection/issues
2. Tell me:
   - Are there any issues created by our tests?
   - What are their titles?
   - What labels do they have?
   - What's their status?
```

**Expected:** Should see issues for any auto-submitted content

---

## Test 9: Disable Auto-Submit
```
Please clean up by disabling auto-submit:
1. Disable it: configure_collection_submission autoSubmit: false
2. Verify: get_collection_submission_config
```

**Expected:** Configuration shows autoSubmit: false

---

## Test Summary Checklist

After running all tests, verify:
- [ ] Configuration tools work (get/set)
- [ ] Portfolio upload works when authenticated
- [ ] Auto-submit respects configuration setting
- [ ] Issues are created with correct format when enabled
- [ ] Labels are applied correctly (contribution, pending-review, element-type)
- [ ] Error messages are helpful
- [ ] Different element types work correctly
- [ ] Portfolio repository is created/updated
- [ ] Collection issues are created when expected

---

## Notes for Tester
- If authentication fails, you may need to run: `gh auth login --web`
- The repository name should be `dollhouse-portfolio` 
- Issues go to `DollhouseMCP/collection` repository
- Each test builds on previous ones, so run in order