# Collection Submission Test Suite Summary

## What We've Created

### 1. Simple Test Script (`CLAUDE_DESKTOP_TEST_SCRIPT.md`)
- **Purpose**: Step-by-step manual test instructions for Claude Desktop
- **Use**: Copy/paste each section into Claude Desktop
- **Coverage**: Configuration, upload, submission, error handling
- **Time**: ~10-15 minutes

### 2. Automated Testing Skill (`skills/collection-integration-tester.md`)
- **Purpose**: AI skill that knows how to test the entire workflow
- **Use**: Activate the skill and ask it to run integration tests
- **Coverage**: Comprehensive testing with reporting template
- **Time**: ~20 minutes for full suite

### 3. Bash Test Script (`test-collection-submission.sh`)
- **Purpose**: Pre-flight checks and test setup
- **Use**: Run before Claude Desktop testing to verify environment
- **Coverage**: GitHub auth, repo access, test persona creation
- **Command**: `bash test/integration/test-collection-submission.sh`

### 4. Roundtrip Test Skill (`roundtrip-test-skill.md`)
- **Purpose**: Test the complete workflow roundtrip
- **Location**: 
  - Collection: `https://github.com/DollhouseMCP/collection/blob/main/library/skills/roundtrip-test-skill.md`
  - Local: `~/.dollhouse/portfolio/skills/roundtrip-test-skill.md` (already copied)
- **Use**: Modify locally and submit to test full cycle

### 5. Roundtrip Test Instructions (`ROUNDTRIP_TEST_INSTRUCTIONS.md`)
- **Purpose**: Detailed instructions for testing with the roundtrip skill
- **Use**: Follow step-by-step for complete workflow validation
- **Coverage**: Download → Modify → Upload → Submit cycle
- **Time**: ~15 minutes

## Quick Start Testing

### Option A: Simplest Test (5 minutes)
1. Open Claude Desktop
2. Run:
   ```
   configure_collection_submission autoSubmit: false
   submit_content "Roundtrip Test Skill"
   ```
3. Verify upload to portfolio only (no collection issue)
4. Run:
   ```
   configure_collection_submission autoSubmit: true
   submit_content "Roundtrip Test Skill"
   ```
5. Verify collection issue created

### Option B: Guided Test (15 minutes)
1. Open `CLAUDE_DESKTOP_TEST_SCRIPT.md`
2. Copy each test section into Claude Desktop
3. Follow the expected results
4. Complete the checklist

### Option C: Automated Test (20 minutes)
1. Activate the testing skill:
   ```
   activate_skill "Collection Integration Tester"
   ```
2. Ask: "Please run the complete integration test suite"
3. Review the report

### Option D: Roundtrip Test (15 minutes)
1. Open `ROUNDTRIP_TEST_INSTRUCTIONS.md`
2. Follow the step-by-step instructions
3. Verify the complete cycle works

## What to Check

### In GitHub Portfolio (`https://github.com/{your-username}/dollhouse-portfolio`)
- Repository created automatically on first submission
- Files appear in correct directories (`personas/`, `skills/`, etc.)
- Commit messages reference the element names
- Content matches what was submitted

### In Collection Repository (`https://github.com/DollhouseMCP/collection/issues`)
- Issues created only when auto-submit is enabled
- Title format: `[element-type] Add {name} by @{username}`
- Labels: `contribution`, `pending-review`, element type
- Body contains portfolio URL and metadata

### Configuration Behavior
- `autoSubmit: false` → Portfolio only
- `autoSubmit: true` → Portfolio + Collection issue
- Settings persist across commands

## Test Data Created

### Test Skill
- **Name**: Roundtrip Test Skill
- **Location**: `~/.dollhouse/portfolio/skills/roundtrip-test-skill.md`
- **Status**: Ready to test

### Test Personas (if using bash script)
- `Test-Manual-{timestamp}.md`
- `Test-Auto-{timestamp}.md`

## Cleanup After Testing

### Remove Test Files
```bash
rm ~/.dollhouse/portfolio/skills/roundtrip-test-skill.md
rm ~/.dollhouse/portfolio/personas/Test-*.md
```

### Reset Configuration
In Claude Desktop:
```
configure_collection_submission autoSubmit: false
```

### Close Test Issues
Go to https://github.com/DollhouseMCP/collection/issues and close any test issues created.

## Success Criteria

The collection submission workflow is working if:
1. ✅ Portfolio uploads work when authenticated
2. ✅ Collection issues respect auto-submit setting
3. ✅ Error messages are helpful
4. ✅ Labels and formatting are correct
5. ✅ The complete roundtrip works smoothly

## Troubleshooting

### Authentication Issues
```bash
gh auth status  # Check status
gh auth login --web  # Re-authenticate
```

### Portfolio Not Found
- Will be created automatically on first submission
- Check https://github.com/{your-username}/dollhouse-portfolio

### Collection Issues Not Created
- Verify auto-submit is enabled
- Check authentication token has repo scope
- Look for error messages in response

## Files in This Test Suite

```
test/integration/
├── CLAUDE_DESKTOP_TEST_SCRIPT.md      # Simple copy/paste tests
├── ROUNDTRIP_TEST_INSTRUCTIONS.md     # Detailed roundtrip test
├── TEST_SUITE_SUMMARY.md              # This file
└── test-collection-submission.sh      # Bash setup script

skills/
└── collection-integration-tester.md   # Automated testing skill

~/.dollhouse/portfolio/skills/
└── roundtrip-test-skill.md            # Test skill (ready to use)
```

## Ready to Test!

Everything is set up and ready. The test skill is in place, instructions are clear, and multiple testing approaches are available. Choose the option that best fits your needs and time availability.

Good luck with testing! 🚀