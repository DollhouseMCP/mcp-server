---
name: Roundtrip Test Skill
description: A test skill designed to validate the complete collection submission workflow roundtrip
author: dollhousemcp
version: 1.0.0
category: testing
created: 2025-08-11
updated: 2025-08-11
tags: [testing, integration, workflow, validation]
proficiency: intermediate
---

# Roundtrip Test Skill

## Purpose

This skill is specifically designed to test the complete roundtrip workflow for the DollhouseMCP collection system. It serves as a validation tool for the entire content lifecycle.

## Test Scenarios

### Scenario 1: Download from Collection
- Skill starts in the DollhouseMCP/collection repository
- User downloads/installs it to local portfolio
- Verifies metadata preservation

### Scenario 2: Local Modification
- User modifies the skill locally
- Updates version number
- Adds modification notes
- Changes persist through workflow

### Scenario 3: Portfolio Upload
- Submit to personal GitHub portfolio
- Test with auto-submit disabled first
- Verify upload without collection submission

### Scenario 4: Collection Submission
- Enable auto-submission
- Submit modified skill
- Creates issue in collection repository
- Completes the roundtrip

## Validation Checklist

- [ ] Skill downloads correctly from collection
- [ ] Local modifications are preserved
- [ ] Portfolio upload maintains metadata
- [ ] Collection issue created with correct format
- [ ] Labels applied correctly (contribution, pending-review, skills)
- [ ] Author attribution maintained throughout
- [ ] Version changes tracked properly

## Test Parameters

When testing, modify these to track your changes:
- `version`: Increment to track modifications (1.0.0 → 1.0.1 → 1.0.2)
- `updated`: Change to current date when modifying
- Add a comment at the end with your username and timestamp

## Expected Behavior

1. **Without Auto-Submit**: Uploads to portfolio only, provides manual submission link
2. **With Auto-Submit**: Uploads to portfolio AND creates collection issue
3. **Error Cases**: Graceful handling with helpful messages

## Test Instructions

```bash
# Step 1: Install from collection
install_collection_element "skills/roundtrip-test-skill.md"

# Step 2: Modify locally
edit_element "Roundtrip Test Skill" --type skills version "1.0.1"

# Step 3: Test without auto-submit
configure_collection_submission autoSubmit: false
submit_content "Roundtrip Test Skill"

# Step 4: Test with auto-submit
configure_collection_submission autoSubmit: true
submit_content "Roundtrip Test Skill"

# Step 5: Verify results
# - Check portfolio: https://github.com/{username}/dollhouse-portfolio
# - Check collection: https://github.com/DollhouseMCP/collection/issues
```

## Success Metrics

A successful roundtrip demonstrates:
- 🔄 Complete cycle: Collection → Local → Modified → Portfolio → Collection
- 📊 Metadata integrity maintained
- 👤 Author attribution preserved
- 🏷️ Proper labeling and categorization
- 📝 Clear audit trail of modifications

---

*This is a test skill from the DollhouseMCP collection - modified for roundtrip testing*