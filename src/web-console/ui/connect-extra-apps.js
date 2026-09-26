/** Other editors and chat applications; only documented setup actions are offered. */

const s = (title, text, extras = {}) => ({ title, text, ...extras });
const r = (id, label, steps) => ({ id, label, steps });
const c = (id, label, group, summary, docsUrl, routes, availability) =>
  ({ id, label, group, summary, docsUrl, routes, ...(availability ? { availability } : {}) });
const endpoint = (url) => s('MCP endpoint', 'Copy the hosted URL into the client.', { value: url, copyLabel: 'Copy endpoint' });
const check = (client) => s('Test the connection', `Authorize in ${client} if prompted, then invoke a harmless Dollhouse tool. A saved entry or active session alone is not enough.`);

export function appClients({ endpoint: url, connectionName: name }) {
  return [
    c('cline', 'Cline', 'Other clients', 'Remote Servers UI; OAuth with Dollhouse needs testing.', 'https://github.com/cline/cline/blob/main/docs/mcp/mcp-overview.mdx', [
      r('in-app', 'In app', [s('Add a Remote Server', 'In Cline’s Remote Servers tab, enter an unused name, the URL below, and HTTP transport. Review the server before enabling it.'), endpoint(url), s('Qualify OAuth', 'Arbitrary remote server OAuth was not established by the reviewed client guide. Test the browser sign-in and a harmless Dollhouse tool before relying on this route.')]),
    ], 'OAuth unverified'),
    c('roo-code', 'Roo Code', 'Other clients', 'Remote HTTP config; OAuth with Dollhouse needs testing.', 'https://roocodeinc.github.io/Roo-Code/features/mcp/using-mcp-in-roo/', [
      r('config', 'Config file', [s('Configure a remote server', 'Use Roo’s MCP settings for a global or workspace server. Add the named remote HTTP endpoint and keep existing servers.'), endpoint(url), s('Qualify OAuth', 'The reviewed guide establishes remote HTTP configuration, but not this hosted browser OAuth flow. Test authorization and a real tool call.')]),
    ], 'OAuth unverified'),
    c('continue', 'Continue', 'Other clients', 'Remote MCP through Continue configuration; OAuth needs testing.', 'https://docs.continue.dev/customize/deep-dives/mcp', [
      r('config', 'Config file', [s('Configure a remote MCP', 'Use Continue’s MCP configuration guide to add a Streamable HTTP endpoint in your project or user config. Preserve existing configuration.'), endpoint(url), s('Qualify OAuth', 'Remote transport support does not establish a generic OAuth login flow here. Test authorization and a real tool call.')]),
    ], 'OAuth unverified'),
    c('windsurf', 'Windsurf / Cascade', 'Other clients', 'Legacy Cascade remote MCP config; exact current product behavior needs testing.', 'https://docs.windsurf.com/windsurf/cascade/mcp', [
      r('config', 'Config file', [s('Use Cascade MCP config', 'For a Cascade release that supports remote HTTP, add the endpoint under its mcp_config.json without replacing existing servers. Check the linked guide for the version-specific schema.'), endpoint(url), s('Qualify current client', 'The original Windsurf guide now redirects to Devin documentation. Confirm the installed Cascade version, OAuth flow, and a real tool call.')]),
    ], 'Version qualification needed'),
    c('librechat', 'LibreChat', 'Other clients', 'MCP settings or admin config with remote OAuth.', 'https://www.librechat.ai/docs/features/mcp', [
      r('in-app', 'In app', [s('Add MCP server', 'If your LibreChat deployment exposes MCP settings, add a remote Streamable HTTP server with this URL and unused name. Admin configuration may be required.'), endpoint(url), check('LibreChat')]),
    ]),
    c('open-webui', 'Open WebUI', 'Other clients', 'Admin registers remote MCP; each user authorizes.', 'https://docs.openwebui.com/features/extensibility/mcp/', [
      r('admin', 'Admin console', [s('Register the server', 'An Open WebUI admin adds a Streamable HTTP MCP server under extensibility settings and configures OAuth/DCR as documented.'), endpoint(url), s('User authorization', 'Each user authorizes the connection separately. Then check a harmless Dollhouse tool in Open WebUI.')]),
    ], 'Admin registration required'),
    c('perplexity', 'Perplexity / Computer', 'Other clients', 'Custom remote connector with OAuth in eligible accounts.', 'https://www.perplexity.ai/help-center/en/articles/13915507-adding-custom-remote-connectors', [
      r('in-app', 'In app', [s('Add custom connector', 'Open Account settings → Connectors → + Custom connector → Remote. Enter an unused name and the URL below; select Streamable HTTP and OAuth.'), endpoint(url), s('Authorize', 'Review and add the connector, then click its card to authenticate. Enable it in the intended conversation or Computer task.'), check('Perplexity')]),
    ], 'Account plan may limit availability'),
    c('jetbrains-ai', 'JetBrains AI Assistant', 'Other clients', 'HTTP MCP settings; Dollhouse OAuth needs testing.', 'https://www.jetbrains.com/help/ai-assistant/mcp.html', [
      r('in-app', 'In app', [s('Add HTTP MCP', 'Open Settings → Tools → AI Assistant → Model Context Protocol (MCP) → Add → HTTP. Merge this JSON under mcpServers; choose global or project scope.', { value: JSON.stringify({ mcpServers: { [name]: { url } } }, null, 2), copyLabel: 'Copy JSON entry' }), s('Qualify OAuth', 'The reviewed AI Assistant guide documents remote HTTP, but not this OAuth login flow. Test authorization and a real tool call.')]),
    ], 'OAuth unverified'),
  ];
}
