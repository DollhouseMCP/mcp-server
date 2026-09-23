# Connect an AI client to hosted DollhouseMCP

Sign in to the hosted console and open **Connect**. The console reads the deployment's MCP endpoint from OAuth protected-resource discovery and provides setup for:

- Claude Code
- Codex
- Claude web and Desktop custom connectors
- Cursor

Client documentation: [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Claude custom connectors](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp), and [Cursor install links](https://prod.cursor.com/docs/mcp/install-links).

Use the separate connection name `dollhouse-beta` so an existing local `dollhousemcp` configuration remains unchanged. After adding the endpoint, complete OAuth in the browser when the client prompts you. Copying a command or opening an install link only starts setup; the console reports a connection after the client establishes a real MCP session. Use **Connect → Connected apps** or the full **Sessions** tab to verify it.

Basic hosted access does not require a local DollhouseMCP server. Local permission hooks and host audit require separate local support and are not installed by the hosted flow.

If endpoint discovery is unavailable or does not identify a safe endpoint on the current deployment, the Connect page fails closed and does not generate commands or links. Deployments that configure a custom MCP path publish that path through the same protected-resource metadata.
