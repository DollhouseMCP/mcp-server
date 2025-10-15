# MCP Registry Submission Guide

This guide documents the process for publishing DollhouseMCP to the official Model Context Protocol (MCP) Registry.

## Overview

The MCP Registry is the official, community-driven catalog for MCP servers. It provides a centralized discovery mechanism for MCP clients (like Claude Desktop, Claude Code, Gemini, and others) to find and install MCP servers.

**Registry URL**: https://registry.modelcontextprotocol.io
**Documentation**: https://github.com/modelcontextprotocol/registry/tree/main/docs
**Publisher CLI**: `mcp-publisher` (installed via Homebrew or pre-built binaries)

## Prerequisites

### 1. Tools Installation

#### macOS/Linux (Homebrew - Recommended)
```bash
brew install mcp-publisher
```

#### macOS/Linux (Pre-built Binary)
```bash
curl -L "https://github.com/modelcontextprotocol/registry/releases/download/latest/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/
```

#### Windows PowerShell
```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/download/latest/mcp-publisher_windows_$arch.tar.gz" -OutFile "mcp-publisher.tar.gz"
tar xf mcp-publisher.tar.gz mcp-publisher.exe
rm mcp-publisher.tar.gz
# Move mcp-publisher.exe to a directory in your PATH
```

### 2. Verify Installation
```bash
mcp-publisher --help
```

You should see:
```
MCP Registry Publisher Tool

Usage:
  mcp-publisher <command> [arguments]

Commands:
  init          Create a server.json file template
  login         Authenticate with the registry
  logout        Clear saved authentication
  publish       Publish server.json to the registry
```

## Files Created

### 1. `server.json` (Root Directory)

This is the **required** metadata file for MCP Registry publication. It describes:
- Server name and description
- Package location (NPM registry)
- Transport type (stdio)
- Environment variables
- Repository information

**Location**: `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/server.json`

**Key Fields**:
- `name`: `io.github.dollhousemcp/mcp-server` (uses GitHub namespace)
- `version`: Must match package.json version (`1.9.17`)
- `packages[0].registryType`: `npm` (published on NPM)
- `packages[0].identifier`: `@dollhousemcp/mcp-server` (NPM package name)

### 2. `package.json` Addition

Added the `mcpName` field for NPM validation:
```json
{
  "mcpName": "io.github.dollhousemcp/mcp-server"
}
```

This field is **required** for NPM packages in the MCP Registry. The registry will:
1. Fetch `https://registry.npmjs.org/@dollhousemcp/mcp-server`
2. Check that `mcpName` matches the server name in `server.json`
3. Reject publication if the field is missing or doesn't match

## Authentication Process

### Option 1: GitHub OAuth (Recommended for io.github.* namespaces)

Since our namespace is `io.github.dollhousemcp/*`, we must authenticate via GitHub:

```bash
cd /path/to/active/mcp-server
mcp-publisher login github
```

This will:
1. Open your browser for GitHub OAuth authentication
2. Request permissions to verify your GitHub account
3. Store authentication credentials locally

**Important**: You must be logged in as a user with access to the `DollhouseMCP` organization or as `mickdarling`.

### Option 2: Personal Access Token (CI/CD)

For automated publishing in GitHub Actions:

```bash
export GITHUB_TOKEN=ghp_your_token_here
mcp-publisher publish
```

The CLI will automatically use the `GITHUB_TOKEN` environment variable if present.

## Publishing Process

### Step 1: Verify Files

Ensure all files are ready:
```bash
cd /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server

# Check server.json exists
cat server.json | jq .

# Check package.json has mcpName
cat package.json | jq .mcpName

# Verify versions match
SERVER_VERSION=$(jq -r .version server.json)
PACKAGE_VERSION=$(jq -r .version package.json)
[ "$SERVER_VERSION" = "$PACKAGE_VERSION" ] && echo "✓ Versions match: $SERVER_VERSION" || echo "✗ Version mismatch!"
```

### Step 2: Authenticate

```bash
mcp-publisher login github
```

Follow the browser prompts to authenticate.

### Step 3: Publish

```bash
mcp-publisher publish
```

Expected output:
```
✓ Successfully published
```

### Step 4: Verify Publication

Check that the server appears in the registry:

```bash
curl "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.dollhousemcp/mcp-server"
```

You should see JSON response with your server metadata.

You can also verify at: https://registry.modelcontextprotocol.io

## Validation Checklist

Before publishing, verify:

- [ ] `server.json` exists in repository root
- [ ] `server.json` version matches `package.json` version
- [ ] `package.json` includes `mcpName` field
- [ ] `mcpName` value matches `server.json` name field
- [ ] Package is published to NPM (`@dollhousemcp/mcp-server`)
- [ ] GitHub authentication is working (`mcp-publisher login github`)
- [ ] Repository is public (https://github.com/DollhouseMCP/mcp-server)

## Schema Validation

The `server.json` file conforms to the official schema at:
```
https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json
```

To validate manually:
```bash
# Install ajv-cli for JSON schema validation
npm install -g ajv-cli

# Validate server.json
ajv validate -s <(curl -s https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json) -d server.json
```

Expected output:
```
server.json valid
```

## Updating Published Server

When releasing new versions:

### Step 1: Update Version Numbers
```bash
# Update package.json and server.json versions together
npm version patch  # or minor/major

# Manually update server.json version to match
vim server.json  # Update "version" field
```

### Step 2: Publish to NPM First
```bash
npm publish
```

### Step 3: Publish to MCP Registry
```bash
mcp-publisher publish
```

**Important**: Always publish to NPM **before** publishing to the MCP Registry. The registry validates that the package version exists on NPM.

## Troubleshooting

### Error: "Package validation failed"

**Cause**: The `mcpName` field is missing from `package.json` or doesn't match `server.json`.

**Fix**:
```bash
# Check package.json has mcpName
jq .mcpName package.json

# Should output: "io.github.dollhousemcp/mcp-server"
```

### Error: "Authentication failed"

**Cause**: GitHub OAuth failed or token is invalid.

**Fix**:
```bash
# Clear credentials and re-authenticate
mcp-publisher logout
mcp-publisher login github
```

### Error: "Namespace not authorized"

**Cause**: You're not authenticated as a user with access to the `DollhouseMCP` GitHub organization.

**Fix**:
- Ensure you're logged into GitHub as `mickdarling` or a DollhouseMCP org member
- Re-run `mcp-publisher login github`

### Error: "Version already published"

**Cause**: You're trying to publish the same version twice.

**Fix**:
```bash
# Bump the version
npm version patch
# Update server.json to match
vim server.json
# Publish to NPM first
npm publish
# Then publish to registry
mcp-publisher publish
```

### Error: "Package not found on NPM"

**Cause**: The package version specified in `server.json` doesn't exist on NPM yet.

**Fix**:
```bash
# Publish to NPM first
npm publish
# Then publish to registry
mcp-publisher publish
```

## CI/CD Integration (GitHub Actions)

For automated publishing, see the official guide:
https://github.com/modelcontextprotocol/registry/blob/main/docs/guides/publishing/github-actions.md

Example workflow snippet:
```yaml
name: Publish to MCP Registry

on:
  release:
    types: [published]

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write

    steps:
      - uses: actions/checkout@v4

      - name: Install mcp-publisher
        run: |
          curl -L "https://github.com/modelcontextprotocol/registry/releases/download/latest/mcp-publisher_linux_amd64.tar.gz" | tar xz
          chmod +x mcp-publisher
          sudo mv mcp-publisher /usr/local/bin/

      - name: Authenticate with GitHub
        run: |
          echo "${{ secrets.GITHUB_TOKEN }}" | mcp-publisher login github --token-stdin

      - name: Publish to MCP Registry
        run: mcp-publisher publish
```

## Additional Resources

### Official Documentation
- **MCP Registry GitHub**: https://github.com/modelcontextprotocol/registry
- **Publishing Guide**: https://github.com/modelcontextprotocol/registry/blob/main/docs/guides/publishing/publish-server.md
- **server.json Format**: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md
- **MCP Specification**: https://modelcontextprotocol.io

### Community Resources
- **MCP Registry Discussion**: https://github.com/orgs/modelcontextprotocol/discussions/159
- **Registry Development**: https://github.com/modelcontextprotocol/registry/discussions/11

### DollhouseMCP Specific
- **Main Repository**: https://github.com/DollhouseMCP/mcp-server
- **NPM Package**: https://www.npmjs.com/package/@dollhousemcp/mcp-server
- **Website**: https://dollhousemcp.com

## Key Concepts

### Namespace Ownership
- `io.github.username/*` - Requires GitHub authentication as `username`
- `com.yourcompany/*` - Requires DNS or HTTP domain verification

### Package Validation
The registry validates package ownership by:
1. Fetching package metadata from the registry (NPM, PyPI, NuGet, Docker, etc.)
2. Checking for validation metadata:
   - **NPM**: `mcpName` field in package.json
   - **PyPI**: `mcp-name: your-name` in README
   - **NuGet**: `mcp-name: your-name` in README
   - **Docker**: `io.modelcontextprotocol.server.name` label

### Transport Types
- `stdio` - Standard input/output (local execution)
- `sse` - Server-Sent Events (deprecated, use streamable-http)
- `streamable-http` - HTTP streaming (remote execution)

DollhouseMCP uses `stdio` transport for local execution.

## Environment Variables

Users can configure DollhouseMCP with these environment variables:

| Variable | Description | Required | Secret |
|----------|-------------|----------|--------|
| `DOLLHOUSE_PORTFOLIO_DIR` | Custom portfolio directory | No | No |
| `GITHUB_TOKEN` | GitHub PAT for sync/submission | No | Yes |
| `DOLLHOUSE_DEBUG` | Enable debug logging | No | No |

## Features Exposed via MCP Registry

When users install DollhouseMCP from the MCP Registry, they get:

### 47 MCP Tools
- **12 Element Management Tools**: Create, edit, list, activate, deactivate elements
- **7 Collection Management Tools**: Browse, search, install from community collection
- **6 Portfolio Management Tools**: Sync with GitHub, search, manage local elements
- **5 Authentication Tools**: GitHub OAuth, token management
- **4 Enhanced Index Tools**: Semantic similarity, relationship mapping
- **4 Configuration Tools**: Server configuration management
- **3 User Management Tools**: Identity and attribution
- **3 Persona Import/Export Tools**: Legacy format support
- **2 Configuration V2 Tools**: Advanced portfolio management
- **1 Build Information Tool**: Version and runtime information

### 6 Element Types
- **Personas**: Behavioral profiles for AI assistants
- **Skills**: Discrete capabilities and functions
- **Templates**: Reusable content structures
- **Agents**: Goal-oriented autonomous actors
- **Memories**: Persistent context storage
- **Ensembles**: Combined element orchestrations

### Key Capabilities
- Local-first architecture with optional GitHub sync
- Community collection with 100+ elements
- OAuth authentication for GitHub
- Semantic search and relationship mapping
- Enterprise-grade security (AGPL-3.0 + Commercial dual licensing)
- Cross-platform support (macOS, Windows, Linux)
- Docker-ready with multi-arch support

## Post-Publication

After successful publication to the MCP Registry:

1. **Verify Discovery**: Test that MCP clients can find your server
2. **Monitor Issues**: Watch for user feedback on installation
3. **Update Documentation**: Ensure all docs reference the registry
4. **Promote**: Announce availability on community channels

## License Considerations

DollhouseMCP is dual-licensed:
- **AGPL-3.0**: Free for personal, educational, and open source projects
- **Commercial License**: Available for proprietary/commercial use

The `server.json` includes licensing metadata in the `_meta.dollhousemcp.licensing` field:
```json
{
  "licensing": {
    "primary": "AGPL-3.0",
    "commercial_available": true,
    "contact": "contact@dollhousemcp.com"
  }
}
```

Users installing from the MCP Registry are subject to AGPL-3.0 terms unless they have a separate commercial license agreement.

## Version History

| Version | Date | server.json | package.json | Published |
|---------|------|-------------|--------------|-----------|
| 1.9.18  | 2025-10-15 | ✓ Created | ✓ mcpName added | Pending |

## Contacts

- **Registry Issues**: https://github.com/modelcontextprotocol/registry/issues
- **DollhouseMCP Issues**: https://github.com/DollhouseMCP/mcp-server/issues
- **Commercial Licensing**: contact@dollhousemcp.com
- **Technical Support**: support@dollhousemcp.com

---

**Last Updated**: October 15, 2025
**Created By**: Claude (Sonnet 4.5) via Claude Code
**Maintainer**: Mick Darling (@mickdarling)
