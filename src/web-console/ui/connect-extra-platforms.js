/** Microsoft and Google product surfaces have separate setup and eligibility rules. */

const s = (title, text, extras = {}) => ({ title, text, ...extras });
const r = (id, label, steps) => ({ id, label, steps });
const c = (id, label, group, summary, docsUrl, routes, availability) =>
  ({ id, label, group, summary, docsUrl, routes, ...(availability ? { availability } : {}) });
const endpoint = (url) => s('MCP endpoint', 'Copy the hosted URL into the product setup.', { value: url, copyLabel: 'Copy endpoint' });
const check = (client) => s('Verify a tool', `After authorization in ${client}, run a harmless Dollhouse tool. A connector listing or session alone is not a tool check.`);

export function microsoftGoogleClients({ endpoint: url, connectionName: name }) {
  return [
    c('microsoft-copilot-personal', 'Microsoft Copilot personal', 'Microsoft', 'Custom remote MCP setup is not established for the consumer app.', 'https://support.microsoft.com/en-us/Microsoft-Copilot/connecting-microsoft-copilot-to-other-services', [
      r('availability', 'Availability', [s('Custom MCP unavailable in this guide', 'Microsoft documents a list of supported service connectors for personal Copilot. There is no verified arbitrary remote MCP entry route for Dollhouse. Use a different client from this catalog.')]),
    ], 'No verified custom MCP route'),
    c('microsoft-365-copilot', 'Microsoft 365 Copilot', 'Microsoft', 'Work Chat requires an MCP plug-in package and tenant distribution.', 'https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/build-mcp-plugins', [
      r('admin', 'Admin / developer', [s('Build an MCP plug-in', 'A developer packages the remote MCP action in a declarative-agent plug-in, configures OAuth, and submits it through the Microsoft 365 app flow. Tenant policy and admin distribution may apply.'), endpoint(url), s('Keep the capabilities distinct', 'The federated connector path is read-only. Use an action-capable MCP plug-in for Dollhouse tools, then test authorization and a real tool call.')]),
    ], 'Requires package and tenant setup'),
    c('microsoft-copilot-cowork', 'Microsoft Copilot Cowork', 'Microsoft', 'Connector-only Microsoft 365 app package can point to remote MCP.', 'https://learn.microsoft.com/en-us/microsoft-365/copilot/cowork/cowork-plugin-development', [
      r('admin', 'Admin / developer', [s('Package the connector', 'Build a Microsoft 365 app ZIP with an agentConnectors remoteMcpServer entry and this mcpServerUrl. Replace any OAuth placeholder reference with a real registration; Cowork-only dynamic registration is documented when supported by the server.'), endpoint(url), s('Install and verify', 'Use the documented personal or tenant installation flow, then enable the plug-in in Cowork → Sources & Skills. Authorize and check a real tool call.')]),
    ], 'Requires Microsoft 365 app package'),
    c('copilot-studio', 'Microsoft Copilot Studio', 'Microsoft', 'A maker adds a remote MCP server to an agent.', 'https://learn.microsoft.com/en-us/microsoft-copilot-studio/mcp-add-existing-server-to-agent', [
      r('in-app', 'In app', [s('Add to an agent', 'In Copilot Studio, use the add existing MCP server wizard for the agent. Enter this server URL and configure the wizard’s OAuth settings.'), endpoint(url), s('Publish and test', 'Complete maker setup, publish the agent according to your environment policy, then authorize and invoke a harmless Dollhouse tool. An agent link does not install a server into personal Copilot.')]),
    ], 'Maker setup required'),
    c('foundry-agent-service', 'Azure AI Foundry Agent Service', 'Microsoft', 'Project MCP connection with delegated authentication.', 'https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/mcp-authentication', [
      r('developer', 'Developer setup', [s('Configure an agent connection', 'Add this remote MCP endpoint to a Foundry project/agent and configure delegated authentication and consent using the linked guide.'), endpoint(url), s('Check roles and tools', 'User and project tenant roles matter for OAuth. Test the consent link and a harmless tool call in the intended agent.')]),
    ], 'Project integration required'),
    c('gemini-apps', 'Gemini Apps personal', 'Google', 'Eligible personal accounts can add a custom app URL on Gemini web.', 'https://support.google.com/gemini/answer/17209137', [
      r('in-app', 'In app', [s('Add a custom app', 'On Gemini web, open Connected Apps → Custom apps and enter the server name and URL.'), endpoint(url), s('Authorize', 'Complete the browser OAuth flow, then enable the app in a conversation and check a harmless tool call.')]),
    ], 'First-pass scope: US adults using personal accounts in English'),
    c('gemini-cli', 'Gemini CLI', 'Google', 'CLI remote HTTP MCP with browser OAuth.', 'https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md', [
      r('terminal', 'Terminal', [s('Add HTTP server', 'Run this in a terminal. Choose a name not already present in your Gemini CLI settings.', { value: `gemini mcp add --transport http ${name} '${url}'`, copyLabel: 'Copy command' }), s('Authorize', 'In Gemini CLI, use /mcp auth for the server if authorization has not started automatically.'), check('Gemini CLI')]),
    ]),
    c('gemini-enterprise', 'Gemini Enterprise', 'Google', 'Administrator-created custom MCP data store.', 'https://docs.cloud.google.com/gemini/enterprise/docs/connectors/custom-mcp-server/set-up-custom-mcp-server', [
      r('admin', 'Admin console', [s('Create custom MCP server data store', 'In the Google Cloud console, open Data stores → Custom MCP Server → Add MCP server. Supply the HTTPS URL and configure OAuth and organization policy.'), endpoint(url), s('Verify access', 'After admin setup and user authorization, test a harmless Dollhouse tool in the target Gemini Enterprise app.')]),
    ], 'Admin and organization policy required'),
    c('gemini-agent-platform', 'Gemini Enterprise Agent Platform', 'Google', 'Developer agent/tool integration with delegated authentication.', 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/build/managed-agents/create-manage', [
      r('developer', 'Developer setup', [s('Add a remote MCP toolset', 'Configure this URL in the managed agent or toolset, then use Agent Platform authentication management for delegated user access.'), endpoint(url), s('Test the agent', 'Confirm consent and invoke a harmless Dollhouse tool in the deployed agent.')]),
    ], 'Project integration required'),
    c('google-ai-studio', 'Google AI Studio', 'Google', 'Native custom MCP installation in AI Studio has not been verified.', 'https://ai.google.dev/gemini-api/docs/ai-studio-quickstart', [
      r('availability', 'Availability', [s('AI Studio route unverified', 'Gemini API remote MCP support is a developer API feature. It does not establish a custom MCP installer in the AI Studio browser interface. Use a supported client or follow the Gemini API documentation for an application integration.')]),
    ], 'No verified AI Studio MCP route'),
    c('antigravity', 'Google Antigravity', 'Google', 'Custom remote MCP through Antigravity config; store installs require listing.', 'https://www.antigravity.google/docs/mcp', [
      r('config', 'Config file', [s('Merge into mcp_config.json', 'Add this entry under mcpServers in Antigravity’s MCP configuration. Preserve existing entries. The custom remote key is serverUrl.', { value: JSON.stringify({ mcpServers: { [name]: { serverUrl: url } } }, null, 2), copyLabel: 'Copy JSON entry' }), s('Authorize', 'Use Antigravity’s MCP manager to authorize with browser OAuth, then check a real tool call.')]),
    ]),
  ];
}
