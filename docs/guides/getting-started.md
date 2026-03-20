# Getting Started with DollhouseMCP Server

Welcome to the DollhouseMCP server! This guide will walk you through the process of setting up the project for local development.

## 1. Prerequisites

Install the following before you begin:

- **Node.js 20 or later** (the project targets modern ECMAScript features).
- **npm** (bundled with Node).
- **Git** for cloning and contributing.

## 2. Installation

First, clone the repository to your local machine and install the dependencies.

```bash
# Clone the repository
git clone https://github.com/DollhouseMCP/mcp-server.git

# Navigate into the project directory
cd mcp-server

# Install dependencies
npm install
```

## 3. Configuration
The server stores its settings in `~/.dollhouse/config.yml` (created automatically on first run). Run the interactive wizard once to populate GitHub credentials, portfolio details, and sync preferences:

```bash
# Launch the configuration wizard (safe to rerun any time)
dollhouse_config action="wizard"
```

> **Verification:** After running the wizard, verify the directory was created: `ls -la ~/.dollhouse/`

After the wizard completes you can inspect or tweak individual settings:

```bash
dollhouse_config action="get"                       # View everything
dollhouse_config action="set" setting="sync.enabled" value=true
```

For a deeper dive, see [Configuration Basics](configuration-basics.md).

## 4. Running the Server

The MCP server communicates over stdio, so it is typically launched from a client (e.g., Claude Desktop) or an inspector. For local development:

```bash
# Build the project (compiles TypeScript to JavaScript)
npm run build

# Start the server
npm start
```

In development you can use hot reload:

```bash
# Run in development mode
npm run dev
```

To explore the API interactively, launch the MCP Inspector (a web-based tool for testing MCP servers):

```bash
npm run inspector
```

> **What is MCP Inspector?** A debugging tool provided by Anthropic that lets you browse available tools, test tool calls, and inspect server responses. See the [MCP documentation](https://modelcontextprotocol.io/docs) for more details.

## 5. Running Tests

The project ships with comprehensive automated tests covering unit, integration, security, and end-to-end scenarios. Kick off the full suite with:

```bash
# Run all tests
npm test
```

Additional test scripts are available:
- `npm run test:integration` - Cross-module integration tests
- `npm run test:e2e` - End-to-end workflow tests
- `npm run security:rapid` - Quick security validation (~2-4s)
- `npm run security:all` - Full security suite

See `package.json` or `docs/developer-guide/testing-strategy.md` for the complete list.

## 6. Next Steps

Now that you have the server running, here are a few things you can do:

*   **Explore the API:** The server provides a rich set of tools for managing AI elements. You can find the full API documentation in the `docs/reference/api-reference.md` file.
*   **Create a Persona:** Try creating your first persona. You can find more information about element types in `docs/reference/element-types.md`.
*   **See Examples:** Check out `docs/examples/` for ensemble configurations and practical use cases.
*   **Review configuration options:** [Configuration Basics](configuration-basics.md) summarizes the most important settings.
*   **Contribute:** See `CONTRIBUTING.md` for workflow expectations, coding standards, and PR guidelines. **Important:** Before committing code, always run the pre-commit workflow: `npm run pre-commit && npm run lint && npm run build && npm test` (see `docs/developer-guide/workflow.md` for details).

## 7. Troubleshooting

* **`npm install` fails:** Verify Node.js ≥ 20. Tools like `nvm` make version switching simple.
* **Server fails to start:** Rerun the wizard (`dollhouse_config action="wizard"`), then check client logs to confirm the MCP process is launching via stdio.
* **Tests fail:** Remove `node_modules`, reinstall, and ensure no local environment variables (e.g., proxy settings) interfere with networked tests.

Welcome to the DollhouseMCP community!
