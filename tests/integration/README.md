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

## Cross-Platform Support

The test suite works on macOS, Linux, and Windows:

### macOS/Linux
```bash
./test-collection-submission.sh
```

### Windows (Git Bash)
```bash
bash test-collection-submission.sh
```

### Windows (Command Prompt)
```cmd
test-collection-submission.bat
```

### Windows (PowerShell)
```powershell
.\test-collection-submission.ps1
```

## Available Tests

### 1. Bash Environment Test
```bash
./test-collection-submission.sh
```
- Pre-flight checks
- Creates test personas
- Verifies GitHub repository access
- Shows test commands for Claude Desktop
- Works on all platforms with bash

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

### cross-platform-helpers.sh
Provides portable functions for cross-platform compatibility:
- `generate_random_suffix` - Creates random hex strings without md5 dependency
- `command_exists` - Checks if a command is available
- `detect_os` - Identifies the operating system
- `get_home_dir` - Gets home directory across platforms
- `print_color` - Colored output that respects CI environments

Source in your scripts:
```bash
source ./cross-platform-helpers.sh
suffix=$(generate_random_suffix 4)  # e.g., "a3f2"
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

## CI/CD Integration

### GitHub Actions Setup

```yaml
name: Real Integration Tests

on:
  schedule:
    - cron: '0 2 * * *'  # Daily at 2 AM
  workflow_dispatch:

jobs:
  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Build project
        run: npm run build
        
      - name: Run real integration tests
        env:
          TEST_GITHUB_TOKEN: ${{ secrets.TEST_GITHUB_TOKEN }}
          GITHUB_TEST_REPO: ${{ github.repository }}-test
          TEST_CLEANUP_AFTER: true
        run: npm run test:e2e:real
```

### Required Secrets
Add to repository secrets:
- `TEST_GITHUB_TOKEN`: Personal access token with repo scope

## Performance Benchmarks

Expected timings for operations:

| Operation | Expected Time | Max Time |
|-----------|--------------|----------|
| Single upload | 2-5 seconds | 10 seconds |
| File verification | 1-2 seconds | 5 seconds |
| URL check | 1-2 seconds | 5 seconds |
| Complete user flow | 15-30 seconds | 60 seconds |

## Troubleshooting

### "Repository not found"
- Ensure `GITHUB_TEST_REPO` format is `username/repo-name`
- Check token has access to create repositories

### "Rate limit exceeded"
- Default delay between operations: 1 second
- Increase with `TEST_RATE_LIMIT_DELAY_MS=2000`
- Check remaining: `curl -H "Authorization: Bearer TOKEN" https://api.github.com/rate_limit`

### "Timeout errors"
- Increase timeout: `TEST_TIMEOUT_MS=60000`
- Check network connectivity
- Verify GitHub status: https://status.github.com

### "Permission denied"
- Verify token scope includes `repo`
- Check repository permissions
- Ensure branch protection allows pushes

## Best Practices

1. **Always use test repositories** - Never run against production repos
2. **Clean up test data** - Use cleanup utilities or auto-cleanup
3. **Respect rate limits** - Add delays between operations
4. **Use unique prefixes** - Helps identify and clean test data
5. **Monitor token expiry** - Rotate tokens regularly
6. **Test in isolation** - Don't run while other tests use same repo

## Contributing

When adding new tests:
1. Use the `detect_github_user` function for username detection
2. Add random suffixes to test data names
3. Document expected results clearly
4. Include cleanup instructions

## Support

For issues or questions:
1. Check existing issues: https://github.com/DollhouseMCP/mcp-server/issues
2. Review session notes in `docs/agent/development/`
3. Contact the development team

---

*Remember: These are REAL tests that create REAL data on GitHub. Always use test repositories and clean up after testing!*
