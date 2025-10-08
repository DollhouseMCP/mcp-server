---
name: Roundtrip Test Skill
description: A test skill for validating the complete collection workflow
author: mickdarling
version: 1.0.0
category: testing
proficiency_levels:
  - beginner
  - intermediate
  - advanced
tags:
  - testing
  - integration
  - workflow
  - validation
parameters:
  test_mode:
    type: boolean
    default: true
    description: Enable test mode for validation
  iteration:
    type: number
    default: 1
    description: Test iteration number
created_date: 2025-08-11
modified_date: 2025-08-11
_dollhouseMCPTest: true
_testMetadata:
  suite: "roundtrip-testing"
  purpose: "End-to-end roundtrip workflow testing"
  created: "2025-08-20"
  version: "1.0.0"
  migrated: "2025-08-20T23:47:24.351Z"
  originalPath: "test-elements/roundtrip-test-skill.md"
---
# Roundtrip Test Skill

This skill is designed to test the complete roundtrip workflow for the DollhouseMCP collection system.

## Purpose

This skill validates the entire content lifecycle:
1. Creation in local portfolio
2. Submission to GitHub portfolio
3. Auto-submission to collection repository
4. Retrieval back from collection

## Test Scenarios

### Scenario 1: Local to Portfolio
- Create or modify skill locally
- Submit to personal GitHub portfolio
- Verify upload without collection submission

### Scenario 2: Portfolio to Collection
- Enable auto-submission
- Submit modified skill
- Verify issue creation in collection repository

### Scenario 3: Complete Roundtrip
- Start with skill from collection
- Modify locally
- Submit to portfolio
- Auto-submit to collection
- Verify complete cycle

## Parameters

- **test_mode**: When enabled, adds test metadata to submissions
- **iteration**: Tracks which test iteration this is

## Usage

This skill doesn't provide actual functionality - it's purely for testing the infrastructure.

## Metadata Tracking

Each submission should preserve:
- Author attribution
- Version information
- Modification timestamps
- Category and tags
- Parameter definitions

## Success Criteria

A successful roundtrip means:
- ✅ All metadata preserved
- ✅ Correct file paths used
- ✅ GitHub issues created with proper labels
- ✅ Content integrity maintained
- ✅ Author attribution correct

---

*Test skill for DollhouseMCP collection workflow validation*