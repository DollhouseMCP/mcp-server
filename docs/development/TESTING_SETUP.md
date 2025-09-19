# Testing Setup Instructions

## Environment Variables

### GitHub Token Setup

To run tests that require GitHub authentication, you need to have `GITHUB_TOKEN` available in your environment.

**Important:** Source your `.zshrc` file to load the necessary tokens:

```bash
source ~/.zshrc
```

This will load:
- `GITHUB_TOKEN` - Required for GitHub API operations
- Other environment variables needed for testing

### Verification

After sourcing, verify the token is loaded:
```bash
echo "Token loaded: $(echo $GITHUB_TOKEN | head -c 10)..."
```

You should see the first 10 characters of your token.

## Running Tests

### Docker Validation Test

Once tokens are loaded:

```bash
# Full validation with bidirectional sync
GITHUB_TEST_TOKEN=$GITHUB_TOKEN ./test-full-validation.js

# Or use the Docker runner script
chmod +x run-docker-validation.sh
./run-docker-validation.sh
```

### Test Environment Files

The test environment configuration is in:
- `docker/test-environment.env` - Docker environment variables
- Test scripts expect `GITHUB_TEST_TOKEN` to be set

## Common Issues

### No GitHub Token
If you see "GITHUB_TEST_TOKEN environment variable is required":
1. Source your `.zshrc`: `source ~/.zshrc`
2. Verify token is loaded
3. Re-run the test

### Docker Build
Ensure you have the latest Docker image:
```bash
docker build -t claude-mcp-test-env:develop -f docker/Dockerfile .
```

---
*Always source `.zshrc` before running tests that require GitHub authentication.*