/** Developer agent guides, grounded in each client's linked MCP documentation. */

const s = (title, text, extras = {}) => ({ title, text, ...extras });
const r = (id, label, steps) => ({ id, label, steps });
const c = (id, label, group, summary, docsUrl, routes, availability) =>
  ({ id, label, group, summary, docsUrl, routes, ...(availability ? { availability } : {}) });
const endpoint = (url) => s('MCP endpoint', 'Copy this HTTPS URL into the client.', { value: url, copyLabel: 'Copy endpoint' });
const finish = (client) => s('Authorize and check a tool', `Complete browser OAuth in ${client}, then run a harmless Dollhouse tool. A saved entry or session alone does not prove tool access.`);

export function developerClients({ endpoint: url, connectionName: name }) {
  return [
    c('hermes', 'Hermes Agent', 'Agents & editors', 'Remote MCP with native OAuth in Hermes Desktop or config.',
      'https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md', [
        r('in-app', 'In app', [s('Add a custom MCP server', 'In Hermes Desktop, open its MCP setup UI and add a custom remote server. Use the name and URL below with OAuth authentication.'), endpoint(url), s('Connection name', 'Choose an unused name to keep existing servers.', { value: name, copyLabel: 'Copy name' }), finish('Hermes')]),
        r('config', 'Config file', [s('Merge into config.yaml', 'Add this entry under mcp_servers in ~/.hermes/config.yaml. Keep all existing entries.', { value: `mcp_servers:\n  ${name}:\n    url: ${JSON.stringify(url)}\n    auth: oauth`, copyLabel: 'Copy YAML entry' }), s('Authorize', `Run hermes mcp login ${name} in a fresh terminal, or use Authorize in Desktop. Reload MCP tools after setup.`), finish('Hermes')]),
      ]),
    c('opencode', 'OpenCode', 'Agents & editors', 'Remote MCP config with automatic OAuth.', 'https://opencode.ai/docs/mcp-servers/', [
      r('config', 'Config file', [s('Merge into OpenCode config', 'Add this named entry to the existing mcp object. Do not replace other servers.', { value: JSON.stringify({ mcp: { [name]: { type: 'remote', url } } }, null, 2), copyLabel: 'Copy JSON entry' }), s('Authorize', 'Start OpenCode and complete its OAuth prompt. If needed, use opencode mcp auth for the named server.'), finish('OpenCode')]),
    ]),
    c('openclaw', 'OpenClaw', 'Agents & editors', 'Remote MCP and OAuth through its MCP manager.', 'https://docs.openclaw.ai/cli/mcp/transports', [
      r('terminal', 'Terminal', [s('Save a remote server', 'Run this in a terminal with an unused name. It saves a Streamable HTTP endpoint with OAuth.', { value: `openclaw mcp set ${name} '${JSON.stringify({ url, transport: 'streamable-http', auth: 'oauth' })}'`, copyLabel: 'Copy command' }), s('Authorize', `Run openclaw mcp login ${name} after saving the server.`), finish('OpenClaw')]),
    ]),
    c('zed', 'Zed', 'Agents & editors', 'Add Remote Server in Zed settings; OAuth follows.', 'https://zed.dev/docs/ai/mcp', [
      r('in-app', 'In app', [s('Add Remote Server', 'Open Settings → AI → MCP Servers → Add Server → Add Remote Server. Use an unused name and the URL below.'), endpoint(url), finish('Zed')]),
    ]),
    c('junie', 'JetBrains Junie', 'Agents & editors', 'Junie CLI has a guided remote HTTP setup and browser OAuth.', 'https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html', [
      r('in-app', 'In Junie CLI', [s('Open the MCP assistant', 'In an open Junie CLI session, enter /mcp. Press Ctrl+A twice if the server is not listed, then use the Installation Assistant. Choose Remote HTTP/HTTPS and user or project scope. Enter the name and URL below.'), endpoint(url), s('Authorize', 'Select the server when it shows Authorization required, choose Authorize, and complete browser login.'), finish('Junie')]),
      r('config', 'Config file', [s('Merge into Junie MCP config', 'Add this entry under mcpServers in ~/.junie/mcp/mcp.json or the project .junie/mcp/mcp.json. Preserve existing entries.', { value: JSON.stringify({ mcpServers: { [name]: { url } } }, null, 2), copyLabel: 'Copy JSON entry' }), finish('Junie')]),
    ]),
    c('copilot-cli', 'GitHub Copilot CLI', 'Agents & editors', 'Terminal MCP manager with remote OAuth.', 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers', [
      r('in-app', 'In Copilot CLI', [s('Open the add form', 'In an open Copilot CLI session, enter /mcp add. Choose HTTP, enter an unused server name and the URL below, keep the default * tools, then press Ctrl+S. The server starts without restarting CLI.'), endpoint(url), s('Authorize and verify', 'Use /mcp to inspect the saved server and complete OAuth when prompted, then invoke a harmless Dollhouse tool.')]),
      r('terminal', 'Terminal', [s('Add HTTP server', 'Run this in a terminal. Choose an unused name; the command updates Copilot CLI config.', { value: `copilot mcp add --transport http ${name} '${url}'`, copyLabel: 'Copy command' }), s('Authorize in Copilot CLI', `In an open Copilot CLI session, use /mcp auth ${name} if the server needs authorization.`), finish('Copilot CLI')]),
    ]),
    c('copilot-visual-studio', 'GitHub Copilot in Visual Studio', 'Agents & editors', 'Configure MCP in Visual Studio Agent mode.', 'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp', [
      r('in-app', 'In app', [s('Configure MCP server', 'Open Copilot Chat → Agent → tools → + → Configure MCP server. Enter an unused ID, HTTP type, and this URL; save.'), endpoint(url), s('Authorize', 'Use the Auth CodeLens in mcp.json for remote OAuth.'), finish('Visual Studio')]),
    ]),
    c('copilot-jetbrains', 'GitHub Copilot in JetBrains', 'Agents & editors', 'Manual remote MCP config; Dollhouse OAuth needs client testing.', 'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp', [
      r('in-app', 'In app', [s('Add MCP Tools', 'Open Copilot Agent chat → tools → Add MCP Tools and use the remote endpoint. Keep other MCP entries.'), endpoint(url), s('Check authentication', 'The documented remote example uses a bearer header. Browser OAuth with Dollhouse is unverified here; test authorization and an actual tool call before relying on this route.')]),
    ], 'OAuth unverified'),
    c('copilot-xcode', 'GitHub Copilot for Xcode', 'Agents & editors', 'Extension MCP config; Dollhouse OAuth needs client testing.', 'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/extend-copilot-chat-with-mcp', [
      r('in-app', 'In app', [s('Edit extension config', 'Open the Copilot for Xcode extension settings → MCP → Edit Config. Add the remote server in mcp.json while preserving existing servers.'), endpoint(url), s('Check authentication', 'The documented remote example uses a bearer header. Browser OAuth with Dollhouse is unverified here; test a real tool call.')]),
    ], 'OAuth unverified'),
    c('xcode-native', 'Xcode native agents', 'Agents & editors', 'Embedded Codex or Claude agent config or plug-in import; qualification pending.', 'https://developer.apple.com/documentation/xcode/extending-and-customizing-agents', [
      r('in-app', 'In app', [s('Use the embedded agent', 'In Xcode Settings → Intelligence, configure the Codex or Claude agent. Add this MCP URL through that agent’s Xcode-specific configuration, or use Intelligence → Plug-ins → Add Plug-in for a compatible bundle.'), endpoint(url), s('Qualify in Xcode', 'Confirm OAuth and a real tool call in the embedded agent. Xcode’s mcpbridge exports Xcode tools to other agents; it does not import this server.')]),
    ], 'Needs Xcode qualification'),
  ];
}
