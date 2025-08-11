# Test Data Safety - Development Mode Protection

## Overview

When running DollhouseMCP from a cloned repository (development mode), the example/test elements in the `data` directory are **NOT** automatically loaded into your portfolio. This prevents test data, security examples, and other development content from appearing in your MCP server.

## Quick Start - Most Common Scenario

**Scenario:** You're a developer who just cloned the repo and want to test with example data.

```bash
# Clone the repository
git clone https://github.com/DollhouseMCP/mcp-server.git
cd mcp-server
npm install

# Run WITHOUT test data (default)
npm run dev
# Result: Clean portfolio, no example elements loaded

# Run WITH test data (when you need examples)
DOLLHOUSE_LOAD_TEST_DATA=true npm run dev
# Result: Example personas, skills, templates loaded from data/ directory
```

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
If you need to load the test data for development or testing purposes, you can enable it using an environment variable.

## How to Set the Environment Variable

### Method 1: Terminal Session (Temporary)
Set it for your current terminal session only:

```bash
# For Mac/Linux:
export DOLLHOUSE_LOAD_TEST_DATA=true
npm run dev

# Or as a one-liner:
DOLLHOUSE_LOAD_TEST_DATA=true npm run dev

# For Windows Command Prompt:
set DOLLHOUSE_LOAD_TEST_DATA=true
npm run dev

# For Windows PowerShell:
$env:DOLLHOUSE_LOAD_TEST_DATA="true"
npm run dev
```

### Method 2: Shell Profile (Permanent for User)
Add to your shell configuration file to set it permanently:

```bash
# For Mac/Linux - add to ~/.bashrc, ~/.zshrc, or ~/.profile:
echo 'export DOLLHOUSE_LOAD_TEST_DATA=true' >> ~/.zshrc
source ~/.zshrc

# For Windows - set as user environment variable:
# Open System Properties > Environment Variables
# Add new user variable: DOLLHOUSE_LOAD_TEST_DATA = true
```

### Method 3: Project .env File (Project-specific)
Create a `.env` file in the project root:

```bash
# Create .env file in project root
echo 'DOLLHOUSE_LOAD_TEST_DATA=true' > .env
```

Note: The project needs to be configured to read .env files (using dotenv package).

### Method 4: VS Code Launch Configuration
If using VS Code, add to `.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "node",
      "request": "launch",
      "name": "Run with Test Data",
      "program": "${workspaceFolder}/dist/index.js",
      "env": {
        "DOLLHOUSE_LOAD_TEST_DATA": "true"
      }
    }
  ]
}
```

### Method 5: NPM Scripts
Add custom scripts to `package.json`:

```json
{
  "scripts": {
    "dev:with-test-data": "cross-env DOLLHOUSE_LOAD_TEST_DATA=true npm run dev",
    "start:with-test-data": "cross-env DOLLHOUSE_LOAD_TEST_DATA=true npm start"
  }
}
```

Then run:
```bash
npm run dev:with-test-data
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

## Who Sets This and When?

### Who Would Set This Variable:

1. **Developers** working on DollhouseMCP who need to:
   - Test new features with example data
   - Debug issues with specific element types
   - Verify that default elements work correctly
   
2. **Contributors** who are:
   - Adding new example elements
   - Testing pull requests
   - Writing integration tests
   
3. **QA Testers** who need to:
   - Validate functionality with known test data
   - Reproduce issues reported by users
   - Test edge cases with specific personas

### When to Enable Test Data:

✅ **Enable it when:**
- Testing element loading functionality
- Debugging portfolio population issues
- Creating new example elements
- Running integration tests that need sample data
- Demonstrating features with example content
- Testing security features with known payloads

❌ **Keep it disabled when:**
- Doing normal development work
- Testing with your own custom elements
- Using the MCP server for actual work
- Running in production-like environments
- Testing user workflows without example clutter

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