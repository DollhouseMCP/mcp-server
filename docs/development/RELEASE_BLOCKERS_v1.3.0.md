# Release Blockers for v1.3.0

**Created**: July 23, 2025
**Status**: 🚨 BLOCKED - Cannot release until resolved

## Critical Release Blockers

### 1. 🚨 Collection Missing 26 of 31 Default Elements
**Issue**: #376
**Impact**: Users can browse but cannot install most AI customization elements
**Required Action**: Upload all missing elements to collection repository

### 2. 🚨 Memories Directory 404 Error
**Issue**: #377  
**Impact**: Cannot browse or install memory elements at all
**Required Action**: Create memories directory structure in collection

### 3. ✅ ElementInstaller Implementation
**Status**: COMPLETE (pending PR)
**Branch**: `feature/element-installer-v1.3.0`
**Required Action**: Create PR and get code review

## Breaking Changes in v1.3.0

1. **PersonaInstaller → ElementInstaller**
   - All imports must be updated
   - API changed to support element types
   
2. **Collection Path Structure**
   - Now requires: `library/[element-type]/[category]/[element].md`
   - Element type detection is automatic

3. **Terminology Change**
   - "Personas" → "AI Customization Elements" (when referring to all types)
   - Update all user-facing documentation

## Pre-Release Checklist

- [ ] ElementInstaller PR created and approved
- [ ] All 31 default elements uploaded to collection
- [ ] Memories directory created and accessible
- [ ] End-to-end testing of all element types
- [ ] README updated with v1.3.0 changes
- [ ] Collection README updated
- [ ] CHANGELOG updated
- [ ] Migration guide created for breaking changes

## DO NOT RELEASE UNTIL ALL BLOCKERS RESOLVED

The v1.3.0 release introduces the complete element system but will be fundamentally broken without the collection repository being properly populated.

---
*This file should be deleted after v1.3.0 is successfully released*