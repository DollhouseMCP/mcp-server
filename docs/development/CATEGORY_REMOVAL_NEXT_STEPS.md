# Category Removal - Next Steps

**Created**: July 25, 2025  
**Context**: Phase 2 complete, all content PRs merged with flat structure

## 🎯 Immediate Next Steps

### 1. Clean Up Remaining Category Subdirectories

```bash
cd /Users/mick/Developer/MCP-Servers/DollhouseMCP-Collection
git checkout main
git pull origin main

# Check what's still in category subdirectories
find library -type f -path "*/personas/*/*" -o -path "*/skills/*/*" | sort

# Known issues:
# - library/personas/professional/ (4 files)
# - library/personas/educational/ (1 file)
# - library/skills/creative/ (unknown count)
# - library/skills/professional/ (unknown count)

# Option 1: Run the migration script
bash scripts/move-to-flat-structure.sh

# Option 2: Manual move for specific directories
mv library/personas/professional/*.md library/personas/
mv library/personas/educational/*.md library/personas/
mv library/skills/creative/*.md library/skills/
mv library/skills/professional/*.md library/skills/

# Remove empty directories
find library -type d -empty -delete

# Validate all moved files
npm run validate:content library/**/*.md
```

### 2. Phase 3: Update MCP Tools in DollhouseMCP Repository

```bash
# Switch to main DollhouseMCP repository
cd /Users/mick/Developer/MCP-Servers/DollhouseMCP

# Create new branch for MCP tool updates
git checkout main
git pull origin main
git checkout -b feature/remove-category-from-tools

# Files to update:
# 1. src/server/tools/CollectionTools.ts
#    - Remove category parameter from browse_collection
#    - Update tool descriptions
#
# 2. src/collection/CollectionBrowser.ts
#    - Remove category navigation level
#    - Update URL building to go directly from type to files
#
# 3. src/collection/PersonaSubmitter.ts
#    - Keep category in metadata but make it optional
#
# 4. src/persona/PersonaValidator.ts
#    - Make category optional in validation
#    - Remove VALID_CATEGORIES enforcement
#
# 5. src/config/constants.ts
#    - Comment out or remove VALID_CATEGORIES export

# After updates:
npm run build
npm test
```

### 3. Update PR #287 (if still open)
- Keep backward compatibility aliases
- Update deprecated tool descriptions
- Ensure smooth transition for users

### 4. Integration Testing

```bash
# Test MCP tools with Claude Desktop:
1. browse_collection - Should go directly from type to files
2. search_collection - Should still work without categories
3. install_persona - Should handle flat structure files
4. validate_persona - Should accept missing category
5. submit_persona - Should work with optional category

# Test with existing personas that have categories
# Ensure backward compatibility is maintained
```

### 5. Documentation Updates

Files to update:
- README files that mention category structure
- API documentation
- User guides
- Contributing guidelines

### 6. Communication

Create announcement for users:
- Explain the change to flat structure
- Benefits: simpler, Git-native versioning
- Category field still supported (optional)
- No action required for existing content

## 📊 Progress Tracking

- [ ] Clean up remaining category subdirectories
- [ ] Create feature branch for MCP tool updates
- [ ] Update CollectionTools.ts
- [ ] Update CollectionBrowser.ts
- [ ] Update PersonaSubmitter.ts
- [ ] Update PersonaValidator.ts
- [ ] Update constants.ts
- [ ] Run tests
- [ ] Integration test with Claude Desktop
- [ ] Update documentation
- [ ] Create user announcement

## 🚀 Phase 4: Future Enhancements

After Phase 3 is complete:

### Git History Tools (2-3 days)
1. `get_element_history` - Show commit history
2. `get_element_version` - Get specific version
3. `compare_element_versions` - Show diffs

### Benefits Realized
- ✅ Cleaner structure (no empty folders)
- ✅ Git-native versioning
- ✅ Stable filenames
- ✅ Better discovery through tags
- ✅ Natural fork model for variants

## Success Metrics
- All files in flat structure
- All tests passing
- MCP tools working without categories
- No breaking changes for users
- Clear migration path documented

---
*Use this document for next session to continue category removal implementation*