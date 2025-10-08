# Parallel Session Execution Guide for Orphaned Issues Cleanup

**Purpose**: Guide for running multiple Claude Code sessions in parallel to systematically review and close 211 orphaned issues

**Context**: See `ORPHANED_ISSUES_ANALYSIS_2025-10-07.md` for full analysis

---

## Quick Start

### Prerequisites
1. Read `ORPHANED_ISSUES_ANALYSIS_2025-10-07.md`
2. Have GitHub CLI (`gh`) authenticated
3. Clone tracking spreadsheet (see Setup section)
4. Have 4 terminal windows ready (or 4 Claude Code instances)

### Setup (5 minutes)

**Create Tracking Spreadsheet**:
```bash
# Create CSV header
cat > docs/development/orphaned-issues-tracking.csv << 'EOF'
Issue,Category,Status,Action,PR References,Session,Notes
EOF

# Or use provided template
cp docs/development/ORPHANED_ISSUES_TRACKING_TEMPLATE.csv docs/development/orphaned-issues-tracking.csv
```

---

## Session 1: Testing & Security (65 issues)

### Objective
Validate test coverage and security implementations, close completed items.

### Issues to Review
**Testing** (40 issues): #29, #47, #48, #49, #50, #52, #63, #66, #211, #237, #325, #394, #420, #446, #487, #567, #571, #579, #598, #629, #663, #680, #698, #715, #717, #723, #737, #799, #809, #912, #933, #1101, #1112, #1113, #1131, #1132

**Security** (25 issues): #72, #73, #74, #77, #168, #169, #170, #172, #180, #207, #208, #212, #214, #218, #245, #254, #256, #259, #274, #344, #380

### Workflow

#### Step 1: Run Test Suite
```bash
# Get current test coverage
npm test -- --coverage > /tmp/test-coverage.txt

# Check security audit
npm run security:audit > /tmp/security-audit.txt

# Check SonarCloud status
npm run lint > /tmp/sonarcloud-lint.txt
```

#### Step 2: For Each Testing Issue
```bash
# Template for investigation
ISSUE_NUM=29
gh issue view $ISSUE_NUM --json title,body,labels

# Search for related tests
TOPIC="MCP protocol integration"
grep -r "describe.*${TOPIC}" __tests__/

# Check PRs that mentioned it
gh pr view <PR_NUM> --json title,body,mergedAt
```

#### Step 3: Determine Status
**Close if**:
- Test file exists with matching description
- Test passes in coverage report
- PR that mentioned it has merged and includes test

**Keep open if**:
- No test exists
- Test exists but fails
- Test coverage is below target

**Example closure**:
```bash
gh issue close 29 --comment "This test was implemented in PR #918. The test file \`__tests__/protocol/integration.test.ts\` contains comprehensive MCP protocol integration tests. Coverage report shows 95% coverage for protocol integration. Closing as complete."
```

#### Step 4: For Each Security Issue
```bash
# Check if security feature exists
grep -r "SecurityMonitor" src/
grep -r "RateLimiter" src/
grep -r "AuditLogger" src/

# Check security audit results
cat /tmp/security-audit.txt | grep -i "<issue-topic>"

# Check CodeQL alerts
gh api repos/DollhouseMCP/mcp-server/code-scanning/alerts
```

#### Step 5: Track Progress
```bash
# Add to tracking CSV
echo "29,Testing,CLOSED,Implemented in PR #918,#918,Session-1,Test exists and passes" >> docs/development/orphaned-issues-tracking.csv
```

### Expected Output
- **Close**: ~50 issues (77%)
- **Keep Open**: ~10 issues (15%)
- **Update**: ~5 issues (8%)

### Completion Checklist
- [ ] All 65 issues reviewed
- [ ] Tracking CSV updated
- [ ] Closed issues have explanation comments
- [ ] Remaining issues have updated status

---

## Session 2: Features (50 issues)

### Objective
Determine implementation status of feature requests, close implemented features.

### Issues to Review
#30, #32, #33, #34, #95, #192, #193, #194, #195, #196, #291, #292, #293, #297, #298, #299, #300, #303, #313, #314, #317, #318, #345, #347, #377, #403, #426, #428, #521, #522, #523, #528, #530, #531, #533, #546, #600, #632, #633, #707, #709, #713, #738, #739, #811, #922, #970, #972, #973, #979, #983, #985, #1083, #1085, #1087, #1090, #1240

### Workflow

#### Step 1: List Current Features
```bash
# Get all MCP tools
npm run dev -- --list-tools > /tmp/mcp-tools.txt

# List element types
ls -la ~/.dollhouse/portfolio/

# Check release notes
gh release list --limit 20
```

#### Step 2: For Each Feature Issue
```bash
ISSUE_NUM=192
gh issue view $ISSUE_NUM --json title,body

# Check if feature exists
# Example: "Export all personas to JSON bundle"
grep -r "exportPersonas" src/
grep -r "exportToJSON" src/

# Check for MCP tool
cat /tmp/mcp-tools.txt | grep -i "export"

# Test the feature
# (In separate Claude Code instance, test the MCP tool)
```

#### Step 3: Categorize Features
**Implemented** (close):
- Feature exists in codebase
- MCP tool available
- Tests pass
- Documented in release notes

**Partially Implemented** (update):
- Core functionality exists
- Missing some described features
- Create new issue for remainder

**Not Implemented** (defer or keep open):
- No code exists
- Not in recent releases
- Determine if still desired

**Example closure**:
```bash
gh issue close 192 --comment "The persona export functionality was implemented in PR #1207. The MCP tool \`export_persona\` provides JSON export capability. Feature is documented in v1.9.0 release notes. Closing as complete."
```

#### Step 4: Special Case - Jeet Singh (#1240)
```bash
# This should be easy to verify
grep -i "jeet singh" package.json

# If found, close immediately
gh issue close 1240 --comment "Jeet Singh added to contributors in PR #1248. Visible in package.json. Thanks for the contribution! Closing as complete."
```

### Expected Output
- **Close**: ~30 issues (60%)
- **Defer**: ~10 issues (20%)
- **Update**: ~5 issues (10%)
- **Keep Open**: ~5 issues (10%)

### Completion Checklist
- [ ] All 50 issues reviewed
- [ ] Feature implementation verified
- [ ] Tracking CSV updated
- [ ] Deferred features labeled appropriately

---

## Session 3: Code Quality & Refactoring (40 issues)

### Objective
Verify refactorings completed, consolidate remaining technical debt.

### Issues to Review
#84, #87, #94, #97, #98, #99, #111, #112, #114, #120, #127, #139, #140, #142, #146, #175, #177, #178, #179, #182, #186, #188, #223, #226, #227, #230, #233, #235, #236, #238, #244, #264, #266, #272, #307, #308, #309, #316, #323, #324, #326, #328, #341, #343, #365, #387, #393, #409, #453, #488, #498, #499, #500, #505, #509, #512, #589, #592, #602, #603, #610, #613, #617, #628, #642, #643, #644, #647, #651, #652, #653, #658, #661, #666, #667, #668, #669, #670, #681, #695, #696, #937, #1120, #1122, #1123, #1128, #1150, #1165, #1169, #1192

### Workflow

#### Step 1: Run Quality Checks
```bash
# SonarCloud analysis
npm run lint > /tmp/sonarcloud.txt

# Type checking
npm run typecheck > /tmp/typecheck.txt

# Check for specific patterns
grep -r "ErrorHandler" src/ | wc -l
grep -r "@throws" src/ | wc -l
grep -r "JSDoc" src/ | wc -l
```

#### Step 2: For Each Refactoring Issue
```bash
ISSUE_NUM=509
gh issue view $ISSUE_NUM

# Example: "Replace 250 bare throw statements with ErrorHandler"
# Check current state
grep -r "throw new Error" src/ | wc -l
grep -r "ErrorHandler" src/ | wc -l

# If ratio is favorable (most use ErrorHandler), close it
```

#### Step 3: Check SonarCloud Specific Issues
```bash
# Issue #1150: Address 55 MAJOR bugs
# Check current SonarCloud status
cat /tmp/sonarcloud.txt | grep "MAJOR"

# Issue #1169: Reduce Technical Debt to Zero
# Check technical debt ratio
npm run lint | grep "Technical Debt"
```

#### Step 4: Verify Specific Refactorings
**Root directory cleanup** (#120, #512):
```bash
ls -la / | wc -l  # Count root files
# If clean, close issues
```

**Version consolidation** (#592):
```bash
grep -r "version" package.json
grep -r "VERSION" src/
# Check if single source of truth
```

**Documentation** (#323, #393):
```bash
# Count JSDoc comments
grep -r "@param\|@returns\|@throws" src/ | wc -l
```

### Expected Output
- **Close**: ~28 issues (70%)
- **Keep Open**: ~4 issues (10%)
- **Update**: ~8 issues (20%)

### Completion Checklist
- [ ] All 40 issues reviewed
- [ ] SonarCloud status documented
- [ ] Remaining technical debt consolidated
- [ ] Tracking CSV updated

---

## Session 4: Docs, Architecture & Infrastructure (56 issues)

### Objective
Quick wins - close obvious completions in documentation and architecture.

### Issues to Review
**Documentation** (6): #103, #119, #283, #284, #628, #749
**Architecture** (13): #291, #292, #293, #297, #298, #299, #300, #972, #973, #979, #1083, #1085, #1087
**Infrastructure** (2): #109, #936
**Remaining**: Review any uncategorized issues

### Workflow

#### Step 1: Documentation Quick Check
```bash
# Check if docs exist
ls docs/
ls README.md
ls CONTRIBUTING.md

# For each doc issue, verify file exists
ISSUE_NUM=749
gh issue view $ISSUE_NUM
# If template exists, close
```

#### Step 2: Architecture Verification
```bash
# Check element types implemented
ls ~/.dollhouse/portfolio/

# Should see: personas, skills, templates, agents, memories, ensembles

# Check Enhanced Index
grep -r "EnhancedIndex" src/
grep -r "Jaccard" src/
grep -r "Shannon" src/

# If features exist, close issues
```

#### Step 3: Infrastructure Check
```bash
# Check CI workflows
ls .github/workflows/

# Check for Windows testing
cat .github/workflows/test.yml | grep -i "windows"

# Check for process leak fixes
grep -r "cleanup\|kill" src/ | grep -i "process"
```

#### Step 4: Mass Closure
For architecture issues (#291-300, #972-979, #1083-1087):
- These are likely all implemented (portfolio system, memory system, enhanced index)
- Verify key classes exist
- Close with reference to system implementation

```bash
# Example batch closure
for issue in 291 292 293 297 298 299 300; do
  gh issue close $issue --comment "Portfolio/element system implemented in v1.9.x series. All element types (personas, skills, templates, agents, memories, ensembles) are functional. Closing as complete."
done
```

### Expected Output
- **Close**: ~45 issues (80%)
- **Keep Open**: ~6 issues (11%)
- **Update**: ~5 issues (9%)

### Completion Checklist
- [ ] All documentation issues reviewed
- [ ] Architecture features verified
- [ ] Infrastructure items checked
- [ ] Mass closures documented

---

## Consolidation Phase (30 minutes)

### After All Sessions Complete

#### Step 1: Merge Tracking Data
```bash
# Each session appends to same CSV
cat docs/development/orphaned-issues-tracking.csv | sort -t',' -k1 -n > docs/development/orphaned-issues-final.csv
```

#### Step 2: Generate Summary Report
```bash
# Count by status
echo "=== Closure Summary ===" > docs/development/orphaned-issues-summary.txt
echo "" >> docs/development/orphaned-issues-summary.txt
awk -F',' '{print $3}' docs/development/orphaned-issues-final.csv | sort | uniq -c >> docs/development/orphaned-issues-summary.txt
```

#### Step 3: Create Follow-up Issues
For issues marked as "UPDATE" or "KEEP OPEN", review and create consolidated issues:

```bash
# Example: Consolidate all remaining test coverage issues
gh issue create \
  --title "Epic: Complete Test Coverage for Core Features" \
  --body "Consolidates remaining test coverage work from orphaned issue cleanup..." \
  --label "testing,epic"
```

#### Step 4: Update Project Documentation
- Update README with current feature status
- Update ROADMAP with remaining work
- Document closure results in session notes

---

## Tips for Efficient Execution

### Before Starting
1. **Read issue carefully** - understand what was requested
2. **Check PR that mentioned it** - see what was actually done
3. **Search codebase** - verify implementation exists
4. **Test if possible** - confirm functionality works

### Decision Making
**Close if**:
- Feature/fix exists in codebase
- Tests pass
- Mentioned in release notes
- PR merged and completed the work

**Defer if**:
- Still desired but not current priority
- Would be nice to have but not critical
- Requires significant effort

**Update if**:
- Partially completed
- Scope has changed
- Original issue too broad

**Keep open if**:
- Actively being worked on
- Critical functionality missing
- Clear next steps defined

### Common Patterns
**"Add tests for X"** → Search for test file, if exists close
**"Implement feature Y"** → Check if MCP tool exists, test it
**"Refactor Z"** → Search for improved code, compare to PR description
**"Add documentation"** → Check if docs exist, update if needed

### Avoiding Mistakes
❌ **Don't close if unsure** - ask in comments first
❌ **Don't close without checking PR** - might be partial work
❌ **Don't batch close without verification** - each needs individual check
✅ **Do explain closure** - link to PR, mention verification
✅ **Do err on side of keeping open** - can always close later
✅ **Do ask for second opinion** - in issue comments

---

## Templates

### Closure Comment Template
```
This [feature/test/refactor] was completed in PR #XXXX.

Verification:
- [x] Code exists in [file path]
- [x] Tests pass
- [x] Documented in [release/docs]

Closing as complete. If this was closed in error, please reopen with updated context.
```

### Deferral Comment Template
```
This is a valuable enhancement but not currently prioritized. Marking as future-enhancement and closing for now.

To revisit this:
1. Assess current priority vs other work
2. Create new issue with updated requirements
3. Include in next release planning cycle

Closing to keep backlog focused on current work.
```

### Update Comment Template
```
Original issue scope was [X]. We've completed [Y] in PR #XXXX.

Remaining work:
- [ ] Part A
- [ ] Part B

Creating new issue #YYYY to track remaining work. Closing this issue as the core functionality is complete.
```

---

## Tracking Spreadsheet Format

```csv
Issue,Category,Status,Action,PR References,Session,Notes
29,Testing,CLOSED,Implemented in PR #918,"#918",Session-1,Test exists and passes
30,Feature,DEFERRED,Future work,"#1202,#1204",Session-2,Multi-platform support planned for v2.0
50,Testing,CLOSED,Implemented in PR #1125,"#1125,#1137",Session-1,Unicode tests comprehensive
...
```

### Status Values
- `CLOSED` - Issue complete, closed
- `DEFERRED` - Future work, closed with label
- `UPDATED` - New issue created, original closed
- `OPEN` - Still needs work, kept open
- `IN REVIEW` - Currently being evaluated

### Action Values
- `Implemented in PR #XXX`
- `Deferred to v2.0`
- `Split into #XXX`
- `Needs implementation`
- `Under investigation`

---

## Success Metrics

### Target Closure Rate: >60%
- **Excellent**: >70% closed
- **Good**: 60-70% closed
- **Acceptable**: 50-60% closed
- **Needs Review**: <50% closed

### Target Review Rate: 100%
- Every single issue must be reviewed
- Every issue gets a status determination
- Every closure gets an explanation

### Quality Metrics
- **Zero false closures**: Better to keep open than close incorrectly
- **Clear documentation**: Every action has reasoning
- **Actionable backlog**: Remaining issues are current work

---

## Next Steps After Cleanup

1. **Update Project Board**: Reflect current work
2. **Update Milestones**: Based on remaining issues
3. **Review Labels**: Ensure consistent labeling
4. **Create Epics**: Consolidate related work
5. **Update Roadmap**: Communicate current state

---

**Document Version**: 1.0
**Last Updated**: October 7, 2025
**Related**: `ORPHANED_ISSUES_ANALYSIS_2025-10-07.md`
