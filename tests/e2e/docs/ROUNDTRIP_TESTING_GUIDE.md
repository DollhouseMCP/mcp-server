# Roundtrip Workflow Testing Guide

This guide provides comprehensive instructions for testing the complete DollhouseMCP roundtrip workflow, from collection browsing to portfolio submission and collection contribution.

## Overview

The roundtrip workflow consists of these phases:
1. **Collection Browsing**: Browse and search available content
2. **Content Installation**: Install elements from collection to local portfolio
3. **Local Modification**: Edit and customize elements locally
4. **Portfolio Submission**: Upload elements to GitHub portfolio repository
5. **Collection Submission**: Create issues for community review and inclusion

## Test Environment Setup

### Prerequisites

#### Required Tools
- Node.js (version 18 or higher)
- npm or yarn package manager
- Git with proper configuration
- GitHub CLI (`gh`) for repository operations

#### Environment Variables

Create a `.env.test` file in the project root:

```env
# GitHub Configuration
GITHUB_TOKEN=your_github_personal_access_token
TEST_GITHUB_USERNAME=your_github_username
TEST_GITHUB_EMAIL=your_github_email

# Test Configuration
TEST_PORTFOLIO_REPO=test-dollhouse-portfolio
TEST_COLLECTION_URL=https://github.com/DollhouseMCP/collection
NODE_ENV=test

# Optional: GitHub App Configuration (for advanced testing)
GITHUB_APP_ID=your_app_id
GITHUB_APP_PRIVATE_KEY_PATH=path/to/private-key.pem
```

#### GitHub Token Permissions

Your GitHub token must have these scopes:
- `repo` (full repository access)
- `issues` (create and manage issues)  
- `workflow` (GitHub Actions access)
- `user` (user profile access)

### Test Data Setup

#### 1. Install Dependencies
```bash
cd /path/to/mcp-server
npm install
```

#### 2. Initialize Test Environment
```bash
# Run setup script
npm run test:setup

# Or manually create test directories
mkdir -p test-data/portfolio
mkdir -p test-data/temp
```

#### 3. Prepare Test Collection
```bash
# Clone collection repository for testing
git clone https://github.com/DollhouseMCP/collection.git test-data/collection
```

## Running Tests

### Automated Test Suite

#### Full Test Suite
```bash
# Run complete roundtrip test suite
npm run test:roundtrip

# Run with verbose output
npm run test:roundtrip -- --verbose

# Run specific test categories
npm run test:roundtrip -- --testNamePattern="Phase 1"
```

#### Individual Test Phases
```bash
# Collection browsing and installation tests
npm test test/e2e/roundtrip-workflow.test.ts -- --testNamePattern="Phase 1"

# Local modification tests  
npm test test/e2e/roundtrip-workflow.test.ts -- --testNamePattern="Phase 2"

# Portfolio management tests
npm test test/e2e/roundtrip-workflow.test.ts -- --testNamePattern="Phase 3"

# Collection submission tests
npm test test/e2e/roundtrip-workflow.test.ts -- --testNamePattern="Phase 4"

# Error handling tests
npm test test/e2e/roundtrip-workflow.test.ts -- --testNamePattern="Phase 5"
```

### Manual Testing Procedures

#### Phase 1: Collection Browsing and Installation

**Test 1.1: Browse Collection**
```bash
# Start MCP server
npm start

# In Claude Desktop, run:
browse_collection "library" type:"skills"
```

**Expected Results:**
- Returns list of available skills
- Shows metadata for each element
- Displays version information
- No errors in response

**Test 1.2: Search Collection**
```bash
# In Claude Desktop:
search_collection "creative writing"
```

**Expected Results:**
- Returns relevant search results
- Results include multiple content types
- Metadata is properly formatted
- Search is case-insensitive

**Test 1.3: Install Content**
```bash
# In Claude Desktop:
install_content "library/skills/roundtrip-test-skill.md"
```

**Expected Results:**
- Element is downloaded to local portfolio
- Version information is preserved
- File structure is correct
- Success message indicates completion

#### Phase 2: Local Modification

**Test 2.1: List Local Elements**
```bash
# In Claude Desktop:
list_elements --type skills
```

**Expected Results:**
- Shows installed roundtrip test skill
- Displays current version
- Shows modification status

**Test 2.2: Modify Element**
```bash
# In Claude Desktop:
edit_element "roundtrip-test-skill" --type skills --version "1.0.2"
```

**Expected Results:**
- Version is updated in metadata
- Modification timestamp is updated
- Changes are saved to local file
- Original content structure is preserved

#### Phase 3: Portfolio Management

**Test 3.1: Check Portfolio Status**
```bash
# In Claude Desktop:
portfolio_status
```

**Expected Results:**
- Shows repository status
- Displays element count
- Shows sync status
- No errors if portfolio exists

**Test 3.2: Configure Portfolio**
```bash
# In Claude Desktop:
portfolio_config auto_submit:false auto_sync:true
```

**Expected Results:**
- Configuration is updated
- Settings are persisted
- Confirmation of changes

**Test 3.3: Submit to Portfolio**
```bash
# In Claude Desktop:
submit_content "roundtrip-test-skill"
```

**Expected Results:**
- Element is uploaded to GitHub repository
- Commit is created with proper message
- Portfolio URL is returned
- Manual submission link provided (when auto_submit is false)

#### Phase 4: Collection Submission

**Test 4.1: Enable Auto-Submit**
```bash
# In Claude Desktop:
portfolio_config auto_submit:true
```

**Test 4.2: Submit with Collection Issue**
```bash
# In Claude Desktop:
submit_content "roundtrip-test-skill"
```

**Expected Results:**
- Element is uploaded to portfolio
- Collection issue is created automatically
- Issue has proper title format: "[skills] Add Roundtrip Test Skill by @username"
- Issue has correct labels: `contribution`, `pending-review`, `skills`
- Issue body contains portfolio URL and element details

#### Phase 5: Error Handling

**Test 5.1: Invalid Content Submission**
```bash
# In Claude Desktop:
submit_content "non-existent-element"
```

**Expected Results:**
- Clear error message indicating element not found
- No partial operations completed
- System remains stable

**Test 5.2: Invalid Collection Path**
```bash
# In Claude Desktop:
install_content "library/invalid/non-existent.md"
```

**Expected Results:**
- Appropriate error message
- No empty files created locally
- Clear indication of what went wrong

## Verification Procedures

### Portfolio Verification

#### GitHub Repository Check
1. Navigate to `https://github.com/{username}/{portfolio-repo}`
2. Verify element exists in correct directory (`skills/roundtrip-test-skill.md`)
3. Check commit history shows proper commit messages
4. Verify file content matches local version
5. Confirm metadata is preserved

#### Local Portfolio Integrity
```bash
# Check local portfolio structure
find ~/.dollhouse -name "*.md" -type f | head -10

# Verify element content
cat ~/.dollhouse/skills/roundtrip-test-skill.md

# Check metadata extraction
npm run test:metadata ~/.dollhouse/skills/roundtrip-test-skill.md
```

### Collection Integration Verification

#### GitHub Issues Check
1. Navigate to `https://github.com/DollhouseMCP/collection/issues`
2. Find issue titled "[skills] Add Roundtrip Test Skill by @{username}"
3. Verify labels: `contribution`, `pending-review`, `skills`
4. Check issue body contains:
   - Link to portfolio repository
   - Element summary
   - Author information
   - Version details

#### Collection Repository Check
1. Check if any pull requests were created (should not be automatic)
2. Verify collection repository structure remains unchanged
3. Confirm no unauthorized commits to collection

## Troubleshooting

### Common Issues

#### Authentication Problems
**Symptoms:** `401 Unauthorized` errors, authentication failures
**Solutions:**
- Verify GitHub token is valid and has required scopes
- Check token expiration date
- Regenerate token if necessary
- Ensure token is properly set in environment variables

#### Repository Permission Issues  
**Symptoms:** `403 Forbidden` errors, cannot create repositories
**Solutions:**
- Check GitHub token has `repo` scope
- Verify user has permission to create repositories
- Check organization membership if using organization repositories

#### Network and API Rate Limiting
**Symptoms:** `429 Too Many Requests`, API timeouts
**Solutions:**
- Implement retry logic with exponential backoff
- Check GitHub API rate limits: `curl -H "Authorization: token $GITHUB_TOKEN" https://api.github.com/rate_limit`
- Use authenticated requests to increase rate limits

#### Content Validation Failures
**Symptoms:** Elements fail validation, metadata parsing errors
**Solutions:**
- Check element format matches expected structure
- Verify metadata fields are complete and valid
- Ensure proper markdown formatting
- Validate version number format (semantic versioning)

#### File System Permissions
**Symptoms:** Cannot write to portfolio directory, file access errors
**Solutions:**
- Check directory permissions: `ls -la ~/.dollhouse`
- Fix permissions: `chmod -R 755 ~/.dollhouse`
- Verify disk space availability: `df -h`

### Debug Commands

#### Enable Debug Logging
```bash
# Set debug environment variables
export DEBUG=dollhouse:*
export LOG_LEVEL=debug

# Run tests with debug output
npm run test:roundtrip -- --verbose
```

#### Inspect Test State
```bash
# Check test portfolio contents
ls -la test-portfolio/

# Verify test element content
cat test-portfolio/skills/roundtrip-test-skill.md

# Check Git status
cd test-portfolio && git status
```

#### Manual Cleanup
```bash
# Clean test data
rm -rf test-data/ test-portfolio/

# Reset GitHub test repository (use with caution)
gh repo delete test-dollhouse-portfolio --confirm
```

## Performance Testing

### Load Testing Scenarios

#### Concurrent Operations Test
```javascript
// Test multiple simultaneous operations
const operations = Array(10).fill(0).map((_, i) => 
  testServer.handleTool('browse_collection', { type: 'skills' })
);
await Promise.allSettled(operations);
```

#### Large Element Handling
```javascript
// Test with large elements (>1MB content)
const largeElement = createLargeTestElement(1024 * 1024); // 1MB
await testServer.handleTool('install_content', { element: largeElement });
```

#### Rapid Modification Test
```javascript
// Test rapid successive modifications
for (let i = 0; i < 100; i++) {
  await testServer.handleTool('edit_element', {
    name: 'test-element',
    version: `1.0.${i}`
  });
}
```

## Test Data Management

### Test Element Lifecycle

#### Creation
- Use fixtures in `test/fixtures/roundtrip/`
- Generate elements with proper metadata
- Include version progression scenarios

#### Modification
- Test version increments
- Validate metadata preservation
- Check content integrity

#### Cleanup
- Remove test elements after test completion
- Clean up GitHub repositories
- Reset configuration to defaults

### Data Isolation

#### Test-Specific Directories
```bash
# Each test run uses isolated directories
TEST_RUN_ID=$(date +%s)
TEST_DIR="test-data/run-${TEST_RUN_ID}"
mkdir -p "${TEST_DIR}"
```

#### Configuration Isolation
```bash
# Use test-specific configuration
export DOLLHOUSE_CONFIG_DIR="${TEST_DIR}/config"
export DOLLHOUSE_DATA_DIR="${TEST_DIR}/data"
```

## Continuous Integration

### GitHub Actions Configuration

#### Test Matrix
```yaml
strategy:
  matrix:
    os: [ubuntu-latest, macos-latest, windows-latest]
    node-version: [18, 20, 22]
```

#### Environment Setup
```yaml
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  TEST_GITHUB_USERNAME: ${{ secrets.TEST_GITHUB_USERNAME }}
  NODE_ENV: test
```

#### Cleanup Step
```yaml
- name: Cleanup Test Data
  if: always()
  run: |
    npm run test:cleanup
    gh repo delete test-dollhouse-portfolio --confirm || true
```

## Success Criteria

### Functional Requirements
- [ ] All collection browsing operations complete successfully
- [ ] Content installation preserves metadata and structure
- [ ] Local modifications are saved and tracked properly
- [ ] Portfolio submission creates proper Git commits
- [ ] Collection issues are created with correct format and labels
- [ ] Error handling provides clear, actionable messages

### Performance Requirements
- [ ] Collection browsing completes within 5 seconds
- [ ] Element installation completes within 10 seconds
- [ ] Portfolio submission completes within 30 seconds
- [ ] System handles 10 concurrent operations without failure

### Quality Requirements
- [ ] No data corruption during workflow execution
- [ ] All metadata is preserved throughout the process
- [ ] Version tracking works correctly
- [ ] Unicode and special characters are handled properly
- [ ] Test coverage exceeds 95% for workflow-related code

---

## Quick Reference

### Essential Commands
```bash
# Run full test suite
npm run test:roundtrip

# Manual testing setup
export GITHUB_TOKEN=your_token
export TEST_GITHUB_USERNAME=your_username

# Debug mode
DEBUG=dollhouse:* npm run test:roundtrip

# Clean up test data
npm run test:cleanup
```

### Key Test Files
- `test/e2e/roundtrip-workflow.test.ts` - Main E2E test suite
- `test/fixtures/roundtrip/` - Test element fixtures
- `test/integration/COMPLETE_ROUNDTRIP_TEST_GUIDE.md` - Manual testing guide

### Important URLs
- Collection Repository: `https://github.com/DollhouseMCP/collection`
- Test Portfolio: `https://github.com/{username}/test-dollhouse-portfolio`
- Collection Issues: `https://github.com/DollhouseMCP/collection/issues`

---

*This guide ensures comprehensive testing of the complete roundtrip workflow with proper setup, execution, and validation procedures.*