# Complete Roundtrip Workflow Test Guide

This is the full, rigorous test of the entire collection workflow system. Follow each step exactly.

---

## PART 1: Claude Desktop Setup (Start Here)

Start in Claude Desktop with these prompts:

### Prompt 1: Browse and install from collection
```
First, browse the skills available in the collection using: browse_collection "skills"

Then install the Roundtrip Test Skill using: install_collection_element "skills/roundtrip-test-skill.md"

Tell me if it downloaded successfully and what version it shows.
```

### Prompt 2: Verify installation
```
Please list all skills in my portfolio using list_elements --type skills and tell me if you see "Roundtrip Test Skill" in the list. Also tell me what version number it shows.
```

### Prompt 3: Check current configuration
```
Show me my current collection submission configuration using get_collection_submission_config and tell me if auto-submit is enabled or disabled.
```

### Prompt 4: Test WITHOUT auto-submit
```
First disable auto-submit by running: configure_collection_submission autoSubmit: false

Then verify it's disabled with: get_collection_submission_config

Finally, submit the Roundtrip Test Skill to my portfolio using: submit_content "Roundtrip Test Skill"

Tell me:
1. Was it uploaded to my GitHub portfolio?
2. What's the portfolio URL?
3. Was a collection issue created? (Should be NO)
4. Did you get a manual submission link?
```

### Prompt 5: Verify portfolio upload
```
Please check my GitHub portfolio at https://github.com/mickdarling/dollhouse-portfolio and tell me if you can see the roundtrip-test-skill.md file in the skills folder. What version does it show?
```

### Prompt 6: Make another modification
```
Please modify the Roundtrip Test Skill by using: edit_element "Roundtrip Test Skill" --type skills version "1.0.3"

Also add a note at the end saying "Modified via Claude Desktop test"

Then verify the changes were saved by showing me the updated version.
```

### Prompt 7: Test WITH auto-submit
```
Now enable auto-submit by running: configure_collection_submission autoSubmit: true

Verify it's enabled with: get_collection_submission_config

Then submit the modified skill again using: submit_content "Roundtrip Test Skill"

Tell me:
1. Was it updated in my GitHub portfolio?
2. Was a collection issue created this time?
3. What's the issue URL?
4. What labels were applied to the issue?
```

### Prompt 8: Test error handling
```
Try submitting a skill that doesn't exist: submit_content "This Skill Does Not Exist"

What error message did you get? Was it helpful?
```

### Prompt 9: Browse collection directly
```
Browse the skills in the collection using: browse_collection "skills"

Can you see other skills available? List the first 3 you see.
```

### Prompt 10: Search collection
```
Search for test-related content in the collection using: search_collection "test"

What results do you find? Do you see the roundtrip test skill?
```

### Prompt 11: Clean install from collection
```
Let's test installing a fresh skill from the collection. First, delete the local roundtrip test skill if it exists.

Then install it fresh using: install_collection_element "skills/roundtrip-test-skill.md"

Did it download successfully? What version did you get?
```

---

## PART 2: Terminal Verification (Optional)

Back in the terminal, run:

```bash
~/.dollhouse/verify-roundtrip.sh
```

This will show you the current state of the skill in your portfolio.

---

## PART 3: GitHub Verification

Open your browser and check:

### 1. Your Portfolio
**URL**: https://github.com/mickdarling/dollhouse-portfolio
- Navigate to `/skills/roundtrip-test-skill.md`
- Check the version number
- Check the modification notes

### 2. Collection Issues
**URL**: https://github.com/DollhouseMCP/collection/issues
- Look for an issue titled "[skills] Add Roundtrip Test Skill by @mickdarling"
- Check it has labels: `contribution`, `pending-review`, `skills`
- Verify the issue body contains your portfolio URL

---

## PART 4: Final Cleanup

### Prompt 12: Reset configuration
```
Please disable auto-submit for normal use by running: configure_collection_submission autoSubmit: false

Then verify with: get_collection_submission_config

The test is complete. Please summarize what worked and what didn't.
```

---

## Success Checklist

After all steps, you should have verified:

- [ ] Skill downloads from collection
- [ ] Script modifies version automatically
- [ ] Manual modifications work via Claude Desktop
- [ ] Portfolio upload works without auto-submit
- [ ] Manual submission link provided when auto-submit is off
- [ ] Portfolio upload + issue creation works with auto-submit
- [ ] Issue has correct format and labels
- [ ] Error handling provides helpful messages
- [ ] Browse collection shows available elements
- [ ] Search collection finds content
- [ ] Install from collection works
- [ ] Complete roundtrip successful

---

## What Success Looks Like

1. **Version progression**: 1.0.0 (collection) → 1.0.1 (script) → 1.0.3 (manual edit)
2. **Two portfolio commits**: One without issue, one with issue
3. **One collection issue**: Created only when auto-submit was enabled
4. **All metadata preserved**: Throughout the entire journey
5. **Clean error messages**: When testing invalid operations

---

## Quick Reference

### Key Commands
- `list_elements --type skills` - List all skills
- `browse_collection "skills"` - Browse collection
- `install_collection_element "skills/roundtrip-test-skill.md"` - Install from collection
- `submit_content "Roundtrip Test Skill"` - Submit to portfolio
- `configure_collection_submission autoSubmit: true/false` - Toggle auto-submit
- `get_collection_submission_config` - Check config

### Key URLs
- Portfolio: https://github.com/mickdarling/dollhouse-portfolio
- Collection: https://github.com/DollhouseMCP/collection
- Issues: https://github.com/DollhouseMCP/collection/issues

---

*This tests every single part of the workflow!*