# SonarCloud Reliability Issues - Onboarding Guide for New Claude Instance

**Purpose**: Quick setup guide for Claude instance tackling SonarCloud reliability issues
**Total Work**: 262 issues across 6 GitHub issues (#1220-1225)
**Estimated Time**: ~2.5 hours across multiple sessions

---

## 🎯 Essential Dollhouse Elements (Load These First!)

### 1. Personas (Critical)

**sonar-guardian** - Your primary guide
```
mcp__dollhousemcp-production__activate_element --name sonar-guardian --type personas
```

**What it provides**:
- Complete SonarCloud workflow knowledge
- GitFlow awareness (ALWAYS work on feature branches!)
- Code modernization standards
- Quality gate requirements
- **Auto-loads**: sonarcloud-modernizer, sonarcloud-fix-template, sonar-sweep-agent

**Key reminder from sonar-guardian**:
- NEVER work on main/develop directly
- ALWAYS create feature branch: `feature/sonarcloud-{rule-id}-fixes`
- ALWAYS use correct query procedure (query by changed files!)

---

**alex-sterling** - Your quality guardian
```
mcp__dollhousemcp-production__activate_element --name alex-sterling --type personas
```

**What it provides**:
- Evidence-based approach (no fake work!)
- STOP at uncertainty protocol
- Complete issue reporting (report all, decide none)
- Verification discipline

**Key reminder from alex-sterling**:
- READ before WRITE
- TEST before CLAIM
- STOP at UNCERTAINTY
- REPORT ALL issues found (don't filter!)

---

### 2. Memories (Essential Knowledge)

**sonarcloud-rules-reference** - Rule lookup
```
mcp__dollhousemcp-production__activate_element --name sonarcloud-rules-reference --type memories
```
Instant lookup for rule IDs, descriptions, and remediation patterns

---

**sonarcloud-api-reference** - API patterns
```
mcp__dollhousemcp-production__activate_element --name sonarcloud-api-reference --type memories
```
Complete API reference for programmatic issue management

---

**sonarcloud-query-procedure** ⚠️ **CRITICAL!**
```
mcp__dollhousemcp-production__activate_element --name sonarcloud-query-procedure --type memories
```

**THIS IS THE MOST IMPORTANT ONE!**

**Why critical**: Generic queries return ALL issues across entire codebase, including OLD issues you didn't create. This causes you to waste time fixing issues that aren't yours.

**The correct way**:
```bash
# Step 1: Get YOUR changed files
git diff develop...HEAD --name-only

# Step 2: Query EACH file individually
mcp__sonarqube__issues \
  --pull_request <PR_NUM> \
  --components "<specific_file_path>" \
  --output_mode content \
  -n true

# Step 3: Fix issues in THAT file only
# Step 4: Re-query to verify fixes
```

**RED FLAGS - DO NOT DO THIS**:
- ❌ `mcp__sonarqube__issues --pull_request 1215` (no --components) → Returns thousands of irrelevant issues
- ❌ Fixing issues with old creationDate → Those aren't your issues
- ❌ Fixing issues in files you didn't modify → Pre-existing technical debt

---

**sonarcloud-reliability-session-prep** - Process guide
```
mcp__dollhousemcp-production__activate_element --name sonarcloud-reliability-session-prep --type memories
```
Lessons from successful hotspot clearance - best practices and methodology

---

### 3. Skills (Automation Tools)

**sonarcloud-modernizer** - Automated fixes
```
mcp__dollhousemcp-production__activate_element --name sonarcloud-modernizer --type skills
```

**What it provides**:
- Automated find/sed scripts for bulk fixes
- Number.parseInt modernization patterns
- String.replaceAll conversion patterns
- Array constructor fixes
- Node.js import modernization

**Key patterns**:
```bash
# S7773: parseInt → Number.parseInt
find . -name "*.ts" -exec sed -i '' 's/\bparseInt(/Number.parseInt(/g' {} \;

# S7781: replace(/g/) → replaceAll() (requires manual review!)
# More complex - see skill for details

# S7723: Array() → new Array()
find . -name "*.ts" -exec sed -i 's/\bArray(\([0-9]\+\))/new Array(\1)/g' {} \;
```

---

## 📚 Essential Documentation (Read These!)

### 1. Triage Document (Your Roadmap)
**Location**: `docs/development/SONARCLOUD_RELIABILITY_TRIAGE.md`

**What it contains**:
- Complete breakdown of all 262 issues
- Detailed implementation plans for each category
- Automation scripts ready to use
- Risk assessment and testing strategies
- Step-by-step guides for each GitHub issue

**Read this FIRST** before starting any issue!

---

### 2. GitFlow Documentation
**Location**: `docs/development/GITFLOW_GUARDIAN.md`

**Critical rules**:
- NEVER commit to main or develop directly
- ALWAYS create feature branch from develop
- Branch naming: `feature/sonarcloud-{rule-id}-{description}`
- ALWAYS push with `-u` flag first time: `git push -u origin feature/...`
- ALWAYS create PR to develop (NOT main!)

---

### 3. Query Procedure Documentation
**Location**: `docs/development/SONARCLOUD_QUERY_PROCEDURE.md`

**Why critical**: Prevents wasting time on wrong issues. Read this carefully!

---

## 🔧 Environment Setup Checklist

Before starting ANY issue, verify:

### 1. Check Current Branch
```bash
git branch --show-current
# Should show: develop, feature/*, or fix/*
# Should NOT show: main
```

### 2. Verify SonarCloud Token
```bash
echo ${SONARQUBE_TOKEN:0:10}...
# Should show: first 10 chars of token
# If empty: Token not set!
```

### 3. Check SonarCloud MCP Connection
```bash
# Try a simple query
mcp__sonarqube__system_ping
# Should return: pong or OK status
```

### 4. Verify Working Directory
```bash
pwd
# Should show: /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server
```

### 5. Check Git Status
```bash
git status
# Should show: clean working directory on develop or feature branch
```

---

## 🎯 Recommended Issue Order

### Session 1: Quick Wins (30 min)
**Start here for confidence building!**

#### Issue #1221 - Test False Positives (10 min)
- Bulk mark 11 test issues as false positive
- Uses API automation (similar to hotspot session)
- **Impact**: 262 → 251 issues
- **Risk**: Zero (just marking, no code changes)
- **Script**: See triage doc section 1.2, 1.3, 2.4

#### Issue #1220 - Number.parseInt (20 min)
- Fully automated with find/sed
- 105 issues resolved
- **Impact**: 251 → 146 issues (40% of all issues!)
- **Risk**: Low (covered by test suite)
- **Script**: See sonarcloud-modernizer skill

**Result after Session 1**: 262 → 146 issues (116 resolved!)

---

### Session 2: MEDIUM Completion (30 min)

#### Issue #1224 - Miscellaneous MEDIUM (30 min)
- Investigate 4 remaining MEDIUM issues
- Case-by-case evaluation
- **Impact**: 146 → 142 issues (all MEDIUM done!)
- **Risk**: Low (individual fixes)

---

### Session 3: Major LOW Cleanup (45 min)

#### Issue #1222 - String.replaceAll (45 min)
- Semi-automated (requires manual review)
- 121 issues
- **Impact**: 142 → 21 issues (84% of LOW!)
- **Risk**: Medium (function replacements need review)
- **Important**: Review each function-based replacement!

---

### Session 4: Final Cleanup (45 min)

#### Issue #1223 - Array Constructor (15 min)
- Fully automated
- 15 issues
- **Impact**: 21 → 6 issues
- **Risk**: Low

#### Issue #1225 - String Methods (30 min)
- Individual investigation
- 6 issues
- **Impact**: 6 → 0 issues (COMPLETE!)
- **Risk**: Low

---

## 🚀 Quick Start: Issue #1221 (First Task)

**Goal**: Mark 11 test false positives in 10 minutes

### Step 1: Activate Elements (2 min)
```bash
# Load all essential elements as shown above
# Minimum: sonar-guardian, alex-sterling, sonarcloud-query-procedure
```

### Step 2: Read Triage Doc (3 min)
```bash
# Open and read section on test false positives
cat docs/development/SONARCLOUD_RELIABILITY_TRIAGE.md | grep -A 50 "1.2 Test Constructor"
```

### Step 3: Execute Bulk Marking (5 min)
Follow the script pattern from successful hotspot session:
- Query the 11 specific issues
- Create marking script with rate limiting (0.3s)
- Execute with proper comments
- Verify completion

### Step 4: Verify (optional)
```bash
# Check that count dropped from 262 to 251
mcp__sonarqube__issues \
  --project_key DollhouseMCP_mcp-server \
  --impact_software_qualities RELIABILITY \
  --statuses OPEN \
  --page_size 1 \
  --output_mode count
# Should show: "total": 251
```

---

## ⚠️ Critical Reminders

### GitFlow (NEVER FORGET!)
1. Check you're on develop: `git checkout develop && git pull`
2. Create feature branch: `git checkout -b feature/sonarcloud-s7773-parseint`
3. Verify branch: `git branch --show-current`
4. Make changes
5. Push with -u first time: `git push -u origin feature/sonarcloud-s7773-parseint`
6. Create PR to develop: `gh pr create --base develop`

### Query Procedure (NEVER SKIP!)
1. Always use `--components` with specific file path
2. Check `creationDate` matches your work
3. Only fix issues in files YOU changed
4. Re-query after fixes to verify

### Testing (NEVER SKIP!)
After EVERY change:
```bash
npm run build     # Must succeed
npm test          # Must pass
npm run lint      # Should pass (may have intentional violations)
```

---

## 📋 Session Template

Use this for each session:

```markdown
## Session: [Issue #XXXX - Description]
**Date**: [Date]
**Estimated Time**: [X minutes]
**Actual Time**: [X minutes]

### Pre-Session Checklist
- [ ] Elements activated (sonar-guardian, alex-sterling, etc.)
- [ ] Triage doc reviewed
- [ ] Working directory verified (pwd)
- [ ] Git status clean
- [ ] On develop branch or appropriate feature branch

### Work Log
[Document what you did]

### Issues Found
[Alex Sterling protocol: Report ALL issues, even minor ones]

### Verification
- [ ] Build succeeded
- [ ] Tests passed
- [ ] SonarCloud verified (if applicable)
- [ ] PR created (if applicable)

### Results
- Issues before: [X]
- Issues after: [Y]
- Resolved: [Z]

### Next Session
[Handoff notes]
```

---

## 🆘 Common Issues & Solutions

### Problem: "Token not found" error
**Solution**:
```bash
# Check token is set
echo $SONARQUBE_TOKEN
# If empty, token needs to be configured
```

### Problem: "Cannot create branch - already exists"
**Solution**:
```bash
# Delete old branch if work was abandoned
git branch -D feature/old-branch
# Or switch to existing branch
git checkout feature/existing-branch
```

### Problem: Query returns thousands of issues
**Solution**: You forgot to use `--components`! Read SONARCLOUD_QUERY_PROCEDURE.md again.

### Problem: Tests failing after changes
**Solution**:
```bash
# Check what files changed
git diff --stat

# Review changes in specific file
git diff path/to/file.ts

# If changes look correct, investigate test failures
npm test -- path/to/failing.test.ts
```

### Problem: SonarCloud shows issues after PR
**Solution**: Wait for CI to complete (can take 5-10 min). Then re-query to verify.

---

## 📊 Success Metrics

Track your progress:
- Issues resolved per session
- Time per issue category
- Test success rate
- PR merge success rate

**Goal**: Maintain ~7-10 issues resolved per minute for automated fixes (proven rate from hotspot session)

---

## 🎓 Key Learnings from Previous Sessions

### From Hotspot Clearance (243 hotspots → 0)
1. **Batch operations win**: Group similar issues, evaluate together
2. **Context matters**: Static analysis flags patterns, not actual bugs
3. **Rate limiting works**: 0.3s between API calls = 0% failures
4. **Documentation prevents rework**: Clear comments save future time
5. **Automation scales**: Scripts handle hundreds of issues in minutes

### From Initial Reliability Triage
1. **Pagination is real**: Check ALL pages (262 issues, not 11!)
2. **Query by impact**: Use `impactSoftwareQualities=RELIABILITY`, not `types=BUG`
3. **95% is automatable**: Most issues have scripted solutions
4. **Test false positives are common**: Intentional patterns often flagged

---

## 📞 Getting Help

If stuck:
1. **Check triage doc**: `docs/development/SONARCLOUD_RELIABILITY_TRIAGE.md`
2. **Check query procedure**: `docs/development/SONARCLOUD_QUERY_PROCEDURE.md`
3. **Review GitHub issue**: Each issue has detailed implementation plan
4. **Ask user**: If genuinely blocked, ask for guidance

---

## ✅ Pre-Flight Checklist (Run This Every Time!)

Before starting work on ANY issue:

```bash
# 1. Verify location
pwd  # Should be: .../mcp-server

# 2. Check git status
git status  # Should be clean

# 3. Get latest develop
git checkout develop && git pull

# 4. Activate elements
# (Run all activate_element commands above)

# 5. Read triage doc section for current issue
cat docs/development/SONARCLOUD_RELIABILITY_TRIAGE.md

# 6. Review GitHub issue
gh issue view <issue-number>

# 7. Create feature branch
git checkout -b feature/sonarcloud-<rule-id>-<description>

# 8. Verify branch
git branch --show-current  # Should show your new feature branch

# NOW you're ready to start! 🚀
```

---

## 🎯 Quick Reference Card

```
ESSENTIAL PERSONAS:
- sonar-guardian (SonarCloud expert)
- alex-sterling (Evidence-based guardian)

CRITICAL MEMORIES:
- sonarcloud-query-procedure ⚠️ MUST READ FIRST
- sonarcloud-rules-reference
- sonarcloud-reliability-session-prep

ESSENTIAL SKILL:
- sonarcloud-modernizer (automation scripts)

WORKFLOW:
1. develop → feature branch
2. Query with --components
3. Fix in feature branch
4. Test (build + tests)
5. Push with -u
6. PR to develop
7. Verify SonarCloud

TESTING:
npm run build && npm test

NEVER:
- Work on main/develop directly
- Query without --components
- Skip testing
- Force push
```

---

**You're ready to start! Begin with Issue #1221 for a quick confidence-building win.** 🚀

---

*Last updated: October 1, 2025*
*Total issues: 262 → 0 (across 6 issues)*
*Estimated completion: ~2.5 hours*
