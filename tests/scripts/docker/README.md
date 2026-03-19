# Docker Integration Tests

This directory contains Docker-based integration tests for DollhouseMCP.

## Available Test Scripts

### 1. `integration-tests.sh` - Discrete Tool Tests

Tests the individual MCP tools (`list_elements`, `create_element`, etc.) in a Docker container with Claude Code.

```bash
# Build the Docker image first
docker build -f docker/test-configs/Dockerfile.claude-testing -t claude-dollhouse-test .

# Run the tests
ANTHROPIC_API_KEY=your-key ./tests/scripts/docker/integration-tests.sh
```

### 2. `mcp-aql-integration-tests.sh` - MCP-AQL CRUD Tests

Tests the consolidated MCP-AQL endpoints (`mcp_aql_create`, `mcp_aql_read`, `mcp_aql_update`, `mcp_aql_delete`) in a Docker container.

**Issue:** #230

### 3. `mcp-aql-behavior-tests.sh` - LLM Behavior Tests

Tests how LLMs interact with MCP-AQL tools: query structure, introspection flow, and endpoint selection.

**Issue:** #235

```bash
# Run behavior tests in CRUD mode (default)
./tests/scripts/docker/mcp-aql-behavior-tests.sh

# Run in different modes
MCP_AQL_TEST_MODE=crud ./tests/scripts/docker/mcp-aql-behavior-tests.sh    # 4 CRUD endpoints
MCP_AQL_TEST_MODE=single ./tests/scripts/docker/mcp-aql-behavior-tests.sh  # Single unified endpoint
MCP_AQL_TEST_MODE=all ./tests/scripts/docker/mcp-aql-behavior-tests.sh     # Classic + MCP-AQL

# Enable verbose output to see raw LLM responses
MCP_AQL_VERBOSE=true ./tests/scripts/docker/mcp-aql-behavior-tests.sh

# Run in natural mode to see unmodified LLM behavior (UX research)
MCP_AQL_NATURAL=true MCP_AQL_VERBOSE=true ./tests/scripts/docker/mcp-aql-behavior-tests.sh
```

#### Test Modes

| Mode | Tools Available | Purpose |
|------|-----------------|---------|
| `crud` | `mcp_aql_create`, `mcp_aql_read`, `mcp_aql_update`, `mcp_aql_delete` | Test CRUD endpoint selection |
| `single` | `mcp_aql` | Test single unified endpoint routing |
| `all` | Classic tools + MCP-AQL | Test tool preference behavior |

#### Behavior Test Suites

| Suite | Description |
|-------|-------------|
| 1. Tool Schema Inspection | Verify tool descriptions are visible and accurate |
| 2. Introspection Flow | Test that LLM uses `introspect` to discover operations |
| 3. Query Structure | Validate MCP-AQL query format (operation, elementType, params) |
| 4. CRUD Endpoint Selection | Verify correct endpoint chosen for each operation type |
| 5. Single Endpoint Routing | Test operation routing through unified endpoint |
| 6. Tool Preference | Compare classic vs MCP-AQL tool selection |

```bash
# Build the Docker image first
docker build -f docker/test-configs/Dockerfile.claude-testing -t claude-dollhouse-test .

# Run the MCP-AQL tests
ANTHROPIC_API_KEY=your-key ./tests/scripts/docker/mcp-aql-integration-tests.sh

# Use a custom Docker image
MCP_AQL_TEST_IMAGE=my-custom-image ANTHROPIC_API_KEY=your-key ./tests/scripts/docker/mcp-aql-integration-tests.sh

# Configure performance thresholds (in seconds)
MCP_AQL_PERF_PASS=20 MCP_AQL_PERF_SLOW=45 ./tests/scripts/docker/mcp-aql-integration-tests.sh

# Show more lines in error output (default: 20)
MCP_AQL_ERROR_LINES=50 ./tests/scripts/docker/mcp-aql-integration-tests.sh
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | (required) | Anthropic API key for Claude |
| `MCP_AQL_TEST_IMAGE` | `claude-dollhouse-test` | Docker image to use |
| `MCP_AQL_TEST_MODE` | `crud` | Test mode: `crud`, `single`, or `all` |
| `MCP_AQL_VERBOSE` | `false` | Show raw LLM output |
| `MCP_AQL_VERBOSE_LINES` | `100` | Lines to show in verbose mode |
| `MCP_AQL_TIMEOUT` | `60` | Timeout per test in seconds |
| `MCP_AQL_NATURAL` | `false` | Skip terse prompt prefix for UX research |
| `MCP_AQL_PERF_PASS` | `15` | Performance threshold for PASS (seconds) |
| `MCP_AQL_PERF_SLOW` | `30` | Performance threshold for SLOW/TIMEOUT (seconds) |
| `MCP_AQL_ERROR_LINES` | `20` | Number of output lines to show on test failure |

## Test Suites in MCP-AQL Tests

| Suite | Description |
|-------|-------------|
| 1. Tool Discovery | Verify all 4 CRUD endpoints are registered |
| 2. READ Operations | Test `list_elements`, `get_active_elements`, `search_elements` |
| 3. CREATE Operations | Test `create_element`, `activate_element` |
| 4. UPDATE Operations | Test `edit_element` |
| 5. DELETE Operations | Test `deactivate_element`*, `delete_element` |
| 6. Error Handling | Test invalid operations, missing params, wrong endpoints |
| 7. Operation Routing | Verify operations route to correct endpoints |
| 8. Performance | Measure response time |

### Note on `deactivate_element`

\* `deactivate_element` is categorized as a **READ operation** (`mcp_aql_read`), not DELETE. This is because deactivation only changes in-memory session state — it does **not** modify any files on disk. The element remains fully intact; only its "active" status in the current session changes. This matches the MCP-AQL endpoint safety annotations where READ operations are non-destructive.

## Prerequisites

1. **Docker** - Must be installed and running
2. **ANTHROPIC_API_KEY** - Required (see API Key Setup below)
3. **Docker Image** - Build with the Dockerfile.claude-testing

### API Key Setup

The test script automatically loads `ANTHROPIC_API_KEY` from `.env.local` if not set in the environment:

```bash
# Option 1: Add to .env.local (recommended - automatically loaded)
echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env.local

# Option 2: Set environment variable directly
export ANTHROPIC_API_KEY=sk-ant-...

# Option 3: Pass inline when running
ANTHROPIC_API_KEY=sk-ant-... ./tests/scripts/docker/mcp-aql-integration-tests.sh
```

Note: `.env.local` is in `.gitignore` and safe for storing secrets locally.

### Timeout Command (macOS)

The test script uses `timeout` or `gtimeout` for test timeouts. On macOS, install coreutils for timeout support:

```bash
brew install coreutils
```

If neither is available, tests will run without timeout protection (a warning is shown).

## Configuration Files

- `docker/test-configs/mcp-aql-config.json` - MCP-AQL CRUD mode (4 endpoints)
- `docker/test-configs/mcp-aql-all-config.json` - All tools mode (classic + MCP-AQL)
- `docker/test-configs/mcp-aql-single-config.json` - Single endpoint mode
- `docker/test-configs/Dockerfile.claude-testing` - Docker image for testing
- `docker/test-configs/docker-compose.test.yml` - Docker Compose for tests

## CI Integration

Add to GitHub Actions:

```yaml
- name: Run MCP-AQL Docker Integration Tests
  run: ./tests/scripts/docker/mcp-aql-integration-tests.sh
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Troubleshooting

### Docker image not found

```bash
docker build -f docker/test-configs/Dockerfile.claude-testing -t claude-dollhouse-test .
```

### Tests timing out

Increase the timeout in the test script or check network connectivity.

### API key issues

Ensure `ANTHROPIC_API_KEY` is set and valid:

```bash
echo $ANTHROPIC_API_KEY | head -c 10
```
