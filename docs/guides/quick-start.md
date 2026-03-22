# Quick Start Guide

DollhouseMCP works with any MCP-compatible AI client. Pick your platform below.

> **v2.0.0-rc.2**: DollhouseMCP v2 is currently a release candidate. Use `@rc` when installing via npm/npx (e.g., `@dollhousemcp/mcp-server@rc`). The Desktop Extension (.mcpb) always installs the latest release. When v2 reaches GA, the `@rc` tag will no longer be needed.

---

## Claude Desktop (One-Click Install)

Download the [DollhouseMCP Desktop Extension](https://github.com/DollhouseMCP/mcp-server/releases/tag/v2.0.0-rc.2) (`.mcpb` file) and open it. Claude Desktop installs everything automatically — no terminal, no configuration file editing.

The `.mcpb` format is an [MCP Bundle](https://github.com/modelcontextprotocol/mcpb) — a portable package containing the server and all dependencies. Node.js ships with Claude Desktop, so DollhouseMCP works out-of-the-box.

---

## Claude Code

All projects (recommended):
```bash
claude mcp add -s user dollhousemcp -- npx -y @dollhousemcp/mcp-server@rc
```

Current project only:
```bash
claude mcp add dollhousemcp -- npx -y @dollhousemcp/mcp-server@rc
```

That's it. Start a new conversation and ask: "List all available Dollhouse personas"

---

## Claude Desktop (Manual Config)

Add to your config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "npx",
      "args": ["-y", "@dollhousemcp/mcp-server@rc"]
    }
  }
}
```

Restart Claude Desktop after saving.

---

## Cursor

Add to `.cursor/mcp.json` in your project directory (or `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "npx",
      "args": ["-y", "@dollhousemcp/mcp-server@rc"]
    }
  }
}
```

Or configure via Settings > MCP Servers in the Cursor UI.

---

## Windsurf

Add to `~/.codeium/windsurf/mcp_config.json` (macOS/Linux) or `%USERPROFILE%\.codeium\windsurf\mcp_config.json` (Windows):

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "npx",
      "args": ["-y", "@dollhousemcp/mcp-server@rc"]
    }
  }
}
```

Or click the MCPs icon in the Cascade panel > Configure to open the file directly.

---

## VS Code (Native MCP Support)

Add to `.vscode/mcp.json` in your workspace:

```json
{
  "servers": {
    "dollhousemcp": {
      "command": "npx",
      "args": ["-y", "@dollhousemcp/mcp-server@rc"]
    }
  }
}
```

> **Note**: VS Code's native MCP support uses `"servers"`, not `"mcpServers"`.

---

## Cline (VS Code Extension)

Click the MCP Servers icon in Cline's top navigation > Configure > Advanced MCP Settings, then add to `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "npx",
      "args": ["-y", "@dollhousemcp/mcp-server@rc"]
    }
  }
}
```

---

## Continue (VS Code / JetBrains)

Add a file at `.continue/mcpServers/dollhousemcp.yaml` in your workspace:

```yaml
name: DollhouseMCP
version: 1.0.0
schema: v1
mcpServers:
  - name: dollhousemcp
    command: npx
    args:
      - "-y"
      - "@dollhousemcp/mcp-server@rc"
```

Continue also accepts JSON files — you can drop a Claude Desktop or Cursor config file into `.continue/mcpServers/` and it will pick it up automatically.

---

## Gemini CLI

One command:

```bash
gemini mcp add dollhousemcp -- npx -y @dollhousemcp/mcp-server@rc
```

Or add to `~/.gemini/settings.json` (user-level) or `.gemini/settings.json` (project-level):

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "npx",
      "args": ["-y", "@dollhousemcp/mcp-server@rc"]
    }
  }
}
```

> **Note**: Gemini CLI's policy parser splits on underscores after the `mcp_` prefix. Avoid underscores in server names (e.g., use `dollhousemcp`, not `dollhouse_mcp`).

---

## OpenAI Codex

One command:

```bash
codex mcp add dollhousemcp -- npx -y @dollhousemcp/mcp-server@rc
```

Or add to `~/.codex/config.toml` (user-level) or `.codex/config.toml` (project-level, trusted projects only):

```toml
[mcp_servers.dollhousemcp]
command = "npx"
args = ["-y", "@dollhousemcp/mcp-server@rc"]
```

> **Note**: Codex uses TOML format, not JSON.

---

## Docker

Build and use DollhouseMCP in a container. This is useful for isolated environments or when you don't want Node.js installed on your host.

```bash
# Build the image
docker build -f docker/Dockerfile -t dollhousemcp .
```

To use the containerized server with an MCP client, the client launches Docker as the command. Mount a volume for your portfolio so elements persist:

For Claude Code, use a wrapper script:

```bash
# save as ~/mcp-servers/dollhousemcp-docker.sh
#!/bin/bash
exec docker run -i --rm \
  -v "$HOME/.dollhouse/portfolio:/app/tmp/portfolio:rw" \
  dollhousemcp
```

```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "bash",
      "args": ["/Users/YOUR_USERNAME/mcp-servers/dollhousemcp-docker.sh"]
    }
  }
}
```

> **Why `-i` and no `-t`?** MCP uses stdio — the client pipes JSON-RPC over stdin/stdout. The `-i` flag keeps stdin open; `-t` would add a TTY that corrupts the protocol stream. Never use `-it` for MCP servers.

> **Why a wrapper script?** MCP client config files (JSON/TOML) don't expand shell variables like `$HOME`. The wrapper script handles variable expansion and keeps the config clean.

> **Portfolio persistence**: The `-v` mount maps your host's portfolio directory into the container so Dollhouse elements persist between runs.

For a full Docker testing environment (including running Claude Code inside the container), see [docker/CLAUDE_CODE_INTEGRATION.md](../../docker/CLAUDE_CODE_INTEGRATION.md).

---

## Local LLMs (via MCP-compatible clients)

Any MCP client that supports stdio transport can run DollhouseMCP. The configuration follows your client's MCP setup — typically a JSON or TOML config with `command` and `args` fields pointing to the server.

If your client doesn't support `npx`, install locally:

```bash
mkdir -p ~/mcp-servers && cd ~/mcp-servers
npm install @dollhousemcp/mcp-server@rc
```

Then point your client at:
```
node ~/mcp-servers/node_modules/@dollhousemcp/mcp-server/dist/index.js
```

---

## Verify It's Working

After configuring, start a conversation and ask:

```
"What DollhouseMCP tools do you have available?"
```

You should see MCP-AQL endpoints (`mcp_aql_create`, `mcp_aql_read`, etc.). Then try:

```
"List all available Dollhouse personas"
"Activate the Dollhouse debug detective persona"
"Open the portfolio browser"
```

If you see a list of personas, you're ready. If not, see [Troubleshooting](troubleshooting.md).

---

## Next Steps

- [Public Beta Onboarding Guide](public-beta-onboarding.md) — Full walkthrough from install to first custom element
- [MCP Client Setup Guide](mcp-client-setup.md) — Advanced configuration for all supported platforms
- [Portfolio Setup](portfolio-setup-guide.md) — GitHub sync and community collection
