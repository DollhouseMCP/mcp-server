# Test Data Safety - Development Mode Protection

## Overview

When running DollhouseMCP from a cloned repository (development mode), the example/test elements in the `data` directory are **NOT** automatically loaded into your portfolio. This prevents test data, security examples, and other development content from appearing in your MCP server.

## Why This Matters

The `data` directory contains example elements for testing and demonstration, including:
- Security testing personas (penetration testing, threat modeling)
- Example templates and skills
- Test agents and ensembles
- Other development content

These are useful for testing but shouldn't automatically appear in a user's portfolio when they're developing or testing the MCP server.

## How It Works

### Automatic Detection
The system automatically detects when it's running from a git repository (development mode) by checking for the `.git` directory. In this mode:
- Test data loading is **disabled by default**
- Only NPM-installed production data is loaded
- The repository's `data` directory is skipped

### Manual Override
If you need to load the test data for development or testing purposes, you can enable it using an environment variable:

```bash
# Enable test data loading
export DOLLHOUSE_LOAD_TEST_DATA=true

# Or run with the variable set
DOLLHOUSE_LOAD_TEST_DATA=true npm run dev
```

## User Experience

### For Developers
When running from a cloned repository without the environment variable:
```
[DefaultElementProvider] Development mode detected - test data loading disabled
[DefaultElementProvider] To enable test data, set DOLLHOUSE_LOAD_TEST_DATA=true
[DefaultElementProvider] Skipping default element population in development mode
```

### For End Users
Users who install via NPM will get appropriate starter content (if we provide any in the NPM package), but not the full test suite from the repository.

## Testing with Test Data

When you need to test with the example elements:

1. **Temporary enable for one session:**
   ```bash
   DOLLHOUSE_LOAD_TEST_DATA=true npm run dev
   ```

2. **Enable for your development environment:**
   ```bash
   # Add to your .env or shell profile
   export DOLLHOUSE_LOAD_TEST_DATA=true
   ```

3. **In tests:**
   ```typescript
   const provider = new DefaultElementProvider({
     loadTestData: true  // Explicitly enable for tests
   });
   ```

## Security Benefits

This approach provides several security benefits:

1. **No Accidental Exposure**: Test personas with security examples don't appear in production use
2. **Clean Development**: Developers get a clean portfolio without test clutter
3. **Explicit Opt-In**: Test data requires deliberate action to enable
4. **Separation of Concerns**: Test data stays separate from user data

## Implementation Details

The safety mechanism is implemented in `DefaultElementProvider`:

1. **Development Mode Detection**: Checks for `.git` directory
2. **Configuration Check**: Reads `DOLLHOUSE_LOAD_TEST_DATA` environment variable
3. **Path Filtering**: Excludes repository data paths unless explicitly enabled
4. **Logging**: Clear messages about what's happening and why

## Related Configuration

- `DOLLHOUSE_LOAD_TEST_DATA`: Set to `true` or `1` to enable test data loading
- `DOLLHOUSE_PORTFOLIO_DIR`: Override the default portfolio location
- Development mode: Automatically detected by presence of `.git` directory

## Future Improvements

Potential enhancements to consider:
- Separate test data into a `test-data` directory
- Provide minimal starter content for NPM installations
- Add a CLI flag for enabling test data
- Create different test data sets for different testing scenarios