# Connect an AI client to hosted DollhouseMCP

Sign in to the hosted console and open **Connect**. The console reads the deployment's MCP endpoint from OAuth protected-resource discovery and provides setup for:

- Claude Code
- Codex
- Claude web and Desktop custom connectors
- Cursor
- VS Code / GitHub Copilot

Client documentation: [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Claude custom connectors](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp), [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp), [Cursor install links](https://prod.cursor.com/docs/mcp/install-links), and [VS Code MCP installation](https://code.visualstudio.com/api/extension-guides/ai/mcp).

The default name is `dollhouse-beta`. You can edit it before setup, using 1–64 ASCII letters, numbers, hyphens, or underscores, starting with a letter or number. Choose a name that is free in your client so an existing local `dollhousemcp` or hosted connection remains unchanged. The console cannot read local client configuration or detect a name collision. Review the proposed name and URL in your client before saving; a name already in use may replace that client's entry.

For Cursor or VS Code, select its tab and choose **Open in Cursor** or **Open in VS Code**. Your browser asks to open the installed desktop app. Review the proposed server there, save it, start or enable it if prompted, and complete OAuth in the browser. If the app is missing, the browser does not open it, or you cancel, install or open the app and retry the link. You can also use the manual JSON on the same tab: merge the named entry into your existing Cursor `mcpServers` or VS Code `servers` configuration without replacing other entries. In VS Code, **MCP: Add Server** → **HTTP** in the Command Palette is another fallback; use the endpoint and connection name shown on the page.

For Claude Code and Codex, use the shown CLI commands. For Claude web or Desktop, add a custom connector with the shown URL and name. Copying a command or opening a native install link only starts setup; it does not confirm installation or connection. Use **Connect → Connected apps** or the full **Sessions** tab to verify a real MCP session. To remove a connection, remove its named entry in the client. Remove saved OAuth authorization separately through that client's account controls if desired.

Basic hosted access does not require a local DollhouseMCP server. Local permission hooks and host audit require separate local support and are not installed by the hosted flow.

If endpoint discovery is unavailable or does not identify a safe endpoint on the current deployment, the Connect page fails closed and does not generate commands or links. Deployments that configure a custom MCP path publish that path through the same protected-resource metadata.
