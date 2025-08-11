# Integration Test Suite

This directory contains integration tests for the DollhouseMCP collection submission workflow.

## Configuration

### GitHub Username

The test suite auto-detects your GitHub username in the following order:

1. **Environment Variable** (highest priority)
   ```bash
   export GITHUB_USER=your-username
   ./test-collection-submission.sh
   ```

2. **GitHub CLI** (auto-detected)
   ```bash
   gh auth login  # Authenticate first
   ./test-collection-submission.sh  # Will auto-detect
   ```

3. **Git Config** (fallback)
   ```bash
   git config --global github.user your-username
   ./test-collection-submission.sh
   ```

### Test Data Naming

Test data includes random suffixes to prevent conflicts:
- Format: `Test-{Type}-{Timestamp}-{Random}`
- Example: `Test-Manual-20250811-164351-ba06`

This allows multiple test runs without cleanup between runs.

## Available Tests

### 1. Bash Environment Test
```bash
./test-collection-submission.sh
```
- Pre-flight checks
- Creates test personas
- Verifies GitHub repository access
- Shows test commands for Claude Desktop

### 2. Claude Desktop Test Script
See `CLAUDE_DESKTOP_TEST_SCRIPT.md` for step-by-step instructions to copy/paste into Claude Desktop.

### 3. Roundtrip Test
See `ROUNDTRIP_TEST_INSTRUCTIONS.md` for testing the complete workflow using a real skill from the collection.

### 4. Automated Testing Skill
The `collection-integration-tester.md` skill can be activated in Claude to run comprehensive tests automatically.

## Helper Scripts

### detect-github-user.sh
Utility script for detecting GitHub username:
```bash
./detect-github-user.sh  # Prints detected username
```

Can be sourced by other scripts:
```bash
source ./detect-github-user.sh
user=$(detect_github_user)
```

## Test Coverage

The test suite validates:
- ✅ Configuration tools (get/set)
- ✅ Portfolio upload with/without auto-submit
- ✅ Collection issue creation
- ✅ Error handling
- ✅ Complete roundtrip workflow
- ✅ GitHub repository operations

## Troubleshooting

### No GitHub User Detected
```bash
# Option 1: Set environment variable
export GITHUB_USER=your-username

# Option 2: Authenticate with GitHub CLI
gh auth login

# Option 3: Set git config
git config --global github.user your-username
```

### Portfolio Not Found
The portfolio repository will be created automatically on first submission.

### Collection Access Denied
Ensure you have access to the DollhouseMCP/collection repository.

## Clean Up

After testing, remove test data:
```bash
# Remove test personas
rm ~/.dollhouse/portfolio/personas/Test-*.md

# Remove test skills
rm ~/.dollhouse/portfolio/skills/*test*.md
```

## Contributing

When adding new tests:
1. Use the `detect_github_user` function for username detection
2. Add random suffixes to test data names
3. Document expected results clearly
4. Include cleanup instructions