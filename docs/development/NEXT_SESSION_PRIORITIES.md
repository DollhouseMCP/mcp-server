# Next Session Priorities - Post January 8, 2025

## 🚨 CRITICAL - Fix Data Loss Risks

These MUST be fixed before any npm publication or user promotion:

### 1. Fix edit_persona Default Protection (#145)
**File**: `src/index.ts:785-900`
**Problem**: Modifies default personas in place
**Solution**: Implement copy-on-write for defaults
**Test**: Edit a default, verify copy created

### 2. Fix Backup System (#144)
**File**: `src/update/BackupManager.ts`
**Problem**: Only backs up git-tracked files
**Solution**: Explicitly backup all personas
**Test**: Create user persona, backup, verify included

## 🔴 HIGH - Complete Tool Audit (#146)

### Verify All 23 Tools Work Correctly

**Core Persona Tools** (6):
- [x] list_personas
- [x] activate_persona
- [x] get_active_persona
- [x] deactivate_persona
- [x] get_persona_details
- [x] reload_personas

**Marketplace Tools** (5):
- [ ] browse_marketplace
- [ ] search_marketplace
- [ ] get_marketplace_persona
- [ ] install_persona
- [ ] submit_persona

**User Identity Tools** (3):
- [ ] set_user_identity
- [ ] get_user_identity
- [ ] clear_user_identity

**Chat Management Tools** (3):
- [x] create_persona ✅ (safe - creates new files)
- [x] edit_persona ❌ (risky - modifies in place)
- [ ] validate_persona

**Auto-Update Tools** (4):
- [ ] check_for_updates
- [ ] get_server_status
- [ ] update_server
- [ ] rollback_update

**Config Tools** (2):
- [ ] configure_indicator
- [ ] get_indicator_config

## 🟡 MEDIUM - NPM Publishing Prep (#40)

**Only after critical fixes!**

### Pre-Publishing Checklist
- [ ] Fix data loss issues (#144, #145)
- [ ] Complete tool audit (#146)
- [ ] Update package.json metadata
- [ ] Create .npmignore
- [ ] Test npm pack locally
- [ ] Document Node.js 24 considerations
- [ ] Add publishing workflow

## 🟢 LOWER - Documentation & Cleanup

### 1. Document Branch Protection (#9)
- Current settings already in `/docs/development/BRANCH_PROTECTION_CONFIG.md`
- May just need to close the issue

### 2. Code Quality Improvements (#140-143)
- Extract constants
- Optimize regex
- Use test.skip()
- Add JSDoc

## Quick Commands for Next Session

```bash
# 1. Check critical issues
gh issue view 145  # edit_persona protection
gh issue view 144  # backup system

# 2. Start with edit_persona fix
cd src
grep -n "editPersona" index.ts  # Line 785

# 3. Test the fix
# Edit a default persona and verify copy created

# 4. Fix backup system
cd src/update
grep -n "createBackup" BackupManager.ts

# 5. Run all tests
npm test
```

## Code Locations Reference

### edit_persona Files
- Tool Definition: `src/server/tools/PersonaTools.ts:129-151`
- Implementation: `src/index.ts:785-900`
- Needs: DEFAULT_PERSONAS constant and copy logic

### Backup System Files
- BackupManager: `src/update/BackupManager.ts`
- createBackup method: ~line 123
- Needs: Additional persona copying after git archive

### Test Files to Update
- Backup tests: `__tests__/unit/BackupManager.test.ts`
- Persona tests: Need to add edit_persona protection tests

## Definition of Done

### For Critical Issues
1. **Code implemented** with proper error handling
2. **Tests written** and passing
3. **Documentation updated** with warnings removed
4. **Manual testing** confirms fix works
5. **No regressions** in existing functionality

### For Tool Audit
1. **Each tool tested** manually
2. **Missing implementations** identified
3. **Documentation matches** reality
4. **Test coverage** exists
5. **Issues created** for problems found

## Session Starter Script

```bash
#!/bin/bash
echo "🚀 Starting DollhouseMCP session"
echo "================================"
echo ""
echo "📋 Critical Issues Status:"
gh issue view 145 --json state,title | jq -r '"\(.title): \(.state)"'
gh issue view 144 --json state,title | jq -r '"\(.title): \(.state)"'
echo ""
echo "📊 Test Status:"
npm test 2>&1 | tail -5
echo ""
echo "🎯 First Priority: Fix edit_persona (#145)"
echo "File: src/index.ts:785"
echo ""
echo "Ready to start!"
```

## Remember
- These are DATA LOSS bugs - highest priority!
- Don't publish to npm until fixed
- Test thoroughly with real scenarios
- Document the fixes clearly