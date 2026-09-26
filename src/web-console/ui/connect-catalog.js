/** Core hosted MCP clients. Other client families can use this descriptor shape. */
export function coreConnectionClients(artifacts) {
  const { endpoint, profile } = artifacts;
  const name = profile.connectionName;
  const oauth = { title: 'Authorize', text: 'Complete OAuth in the browser when prompted. Sign in with this Dollhouse account and approve access.' };
  const resume = { title: 'Resume in your client', text: 'Return to the client after authorization. Refresh its MCP server or tool list if needed, then ask it to use a Dollhouse tool to verify the connection.' };
  return [
    {
      id: 'claude-code', label: 'Claude Code', group: 'Anthropic', summary: 'Use a terminal command or your Claude account connector.',
      docsUrl: 'https://code.claude.com/docs/en/mcp',
      routes: [
        { id: 'terminal', label: 'From your terminal', steps: [
          { title: 'Add the server', text: 'Run this command in your terminal. User scope makes the connection available across projects.', value: artifacts.claudeAdd, copyLabel: 'Copy command' },
          { title: 'Authorize', text: 'Run this command to open browser OAuth. In an interactive Claude Code session, /mcp can also authenticate a configured server.', value: artifacts.claudeLogin, copyLabel: 'Copy command' },
          { title: 'Verify and resume', text: 'Run claude mcp list or inspect /mcp for connection status, then return to your session and ask Claude Code to use a Dollhouse tool.' },
        ] },
        { id: 'inside', label: 'Inside Claude Code', steps: [
          { title: 'Add a Claude account connector', text: 'Open Claude → Customize → Connectors → Add custom connector. This account route is available to Claude Code when signed in with a supported claude.ai subscription. API-key and alternative authentication may not share it.', href: 'https://claude.ai/customize/connectors', linkLabel: 'Open Claude connectors' },
          { title: 'Enter the server details', text: `Name it ${name}, paste this hosted MCP URL, then choose Add and Connect.`, value: endpoint, copyLabel: 'Copy endpoint' },
          oauth,
          { title: 'Verify in Claude Code', text: 'Open /mcp to check the connector, then ask Claude Code to use a Dollhouse tool. If the account connector is missing, check /status for a claude.ai subscription login. Claude Code fetches account connectors at startup, so restart Code after adding one if needed. A local server with the same URL may take precedence.' },
        ] },
      ],
    },
    {
      id: 'codex', label: 'Codex', group: 'OpenAI', summary: 'Add the remote server in Codex settings or the CLI.',
      docsUrl: 'https://developers.openai.com/codex/mcp',
      routes: [
        { id: 'inside', label: 'Inside Codex', steps: [
          { title: 'Open MCP settings', text: 'In the Codex desktop app, open Settings → MCP servers → Add server and select Streamable HTTP.' },
          { title: 'Enter the server details', text: `Use ${name} as the name and paste the endpoint. Save the server, then select Authenticate for it in MCP settings. Restart or refresh the server if Codex requests it.`, value: endpoint, copyLabel: 'Copy endpoint' },
          oauth,
          { title: 'Resume in Codex', text: 'Refresh the MCP server or start a new Codex conversation if the current session has not picked it up. Check available tools, then ask Codex to use a Dollhouse tool.' },
        ] },
        { id: 'terminal', label: 'From your terminal', steps: [
          { title: 'Add the server', text: 'Run this command in your terminal. Codex desktop and CLI share the configured MCP server.', value: artifacts.codexAdd, copyLabel: 'Copy command' },
          { title: 'Authorize', text: 'Run this command to complete browser OAuth.', value: artifacts.codexLogin, copyLabel: 'Copy command' },
          { title: 'Verify and resume', text: 'Run codex mcp list to check the entry. Return to Codex, refresh the server or start a new conversation if needed, and ask it to use a Dollhouse tool.' },
        ] },
      ],
    },
    {
      id: 'claude', label: 'Claude web / Desktop', group: 'Anthropic', summary: 'Add a custom connector to your Claude account.',
      docsUrl: 'https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp',
      routes: [{ id: 'inside', label: 'Inside Claude', steps: [
        { title: 'Open connectors', text: 'In Claude web or Desktop, go to Customize → Connectors → + → Add custom connector.', href: 'https://claude.ai/customize/connectors', linkLabel: 'Open Claude connectors' },
        { title: 'Enter the server details', text: `Use ${name} as the name and paste the hosted MCP URL. Choose Add, then Connect.`, value: endpoint, copyLabel: 'Copy endpoint' },
        oauth,
        { title: 'Use in a conversation', text: 'In your conversation, enable the connector from + → Connectors if needed. Ask Claude to use a Dollhouse tool to verify it.' },
      ] }],
    },
    {
      id: 'claude-cowork', label: 'Claude Cowork', group: 'Anthropic', summary: 'Use an account connector in Cowork.',
      docsUrl: 'https://support.claude.com/en/articles/13837440-use-plugins-in-claude',
      routes: [{ id: 'inside', label: 'Inside Claude', steps: [
        { title: 'Add a custom connector', text: 'In Claude, open Customize → Connectors → + → Add custom connector. The account connector is available in Cowork on supported plans.', href: 'https://claude.ai/customize/connectors', linkLabel: 'Open Claude connectors' },
        { title: 'Enter the server details', text: `Name it ${name}, paste this hosted MCP URL, choose Add, then Connect.`, value: endpoint, copyLabel: 'Copy endpoint' },
        oauth,
        { title: 'Resume in Cowork', text: 'Open Cowork and enable the connector for the task if needed. Ask it to use a Dollhouse tool to verify access.' },
      ] }],
    },
    {
      id: 'chatgpt', label: 'ChatGPT', group: 'OpenAI', summary: 'Connect through ChatGPT developer mode.',
      docsUrl: 'https://developers.openai.com/plugins/deploy/connect-chatgpt',
      availability: 'Custom MCP plugin setup requires ChatGPT developer mode and an eligible account or workspace.',
      routes: [{ id: 'inside', label: 'Inside ChatGPT', steps: [
        { title: 'Open plugin setup', text: 'In ChatGPT, enable developer mode in Settings → Apps & Connectors → Advanced settings, then create a custom MCP plugin from the Connectors or Plugins settings. Workspace controls may limit this option.' },
        { title: 'Enter the server details', text: `Use ${name} as the name and paste this remote MCP endpoint into the server URL field.`, value: endpoint, copyLabel: 'Copy endpoint' },
        oauth,
        { title: 'Enable and test', text: 'Enable the custom plugin for a conversation and ask ChatGPT to use a Dollhouse tool. Codex configuration does not automatically add it to ChatGPT.' },
      ] }],
    },
    {
      id: 'vscode', label: 'VS Code / GitHub Copilot', group: 'Editors', summary: 'Open an install link or add an HTTP server in VS Code.',
      docsUrl: 'https://code.visualstudio.com/docs/agent-customization/mcp-servers',
      routes: [
        { id: 'native', label: 'Open in VS Code', steps: [
          { title: 'Open the install link', text: `Open installed VS Code, review the ${name} name and URL, and choose where to save the server.`, href: artifacts.vscodeLink, linkLabel: 'Open in VS Code' },
          oauth,
          { title: 'Verify and resume', text: 'Start or refresh the MCP server in VS Code, check its tools, then ask Copilot to use a Dollhouse tool.' },
        ] },
        { id: 'inside', label: 'Inside VS Code', steps: [
          { title: 'Add an HTTP server', text: 'Open the Command Palette and run MCP: Add Server. Choose HTTP and paste the endpoint. Enter a free connection name and select where to save it.', value: endpoint, copyLabel: 'Copy endpoint' },
          oauth, resume,
          { title: 'Manual configuration', text: 'If editing mcp.json directly, merge this entry into servers; preserve your existing entries.', value: artifacts.vscodeConfig, copyLabel: 'Copy manual JSON' },
        ] },
      ],
    },
    {
      id: 'cursor', label: 'Cursor', group: 'Editors', summary: 'Open an install link or add a remote server in settings.',
      docsUrl: 'https://cursor.com/docs/mcp/install-links',
      routes: [
        { id: 'native', label: 'Open in Cursor', steps: [
          { title: 'Open the install link', text: `Open installed Cursor and review the ${name} server configuration before saving it.`, href: artifacts.cursorLink, linkLabel: 'Open in Cursor' },
          oauth,
          { title: 'Verify and resume', text: 'Refresh the server in Cursor settings if needed, check available tools, then ask Cursor to use a Dollhouse tool.' },
        ] },
        { id: 'inside', label: 'Inside Cursor', steps: [
          { title: 'Open MCP settings', text: 'In Cursor Settings → MCP, add a remote server using this endpoint and a free connection name.', value: endpoint, copyLabel: 'Copy endpoint' },
          oauth, resume,
          { title: 'Manual configuration', text: 'If editing your MCP JSON, merge this entry under mcpServers and preserve your existing entries.', value: artifacts.cursorConfig, copyLabel: 'Copy manual JSON' },
        ] },
      ],
    },
  ].map(client => ({
    ...client,
    connectionNote: 'OAuth opens in your browser. Sign in with this account and approve the MCP connection. Copying or opening setup does not mean the client is connected.',
  }));
}
