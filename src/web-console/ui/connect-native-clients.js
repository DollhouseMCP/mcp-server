/** Setup guides for native clients. Import handoff is distinct from OAuth and tool-call qualification. */

import { hostedConnectionProfile } from './connect-config.js';
import { nativeLinkArtifacts } from './connect-native-config.js';

const oauthStep = Object.freeze({
  title: 'Authorize and verify',
  text: 'When prompted, sign in with this Dollhouse account and approve OAuth in the browser. Ask the client to list your Dollhouse personas, then refresh Connected apps here. A saved import or listed session alone does not prove a tool call worked.',
});

function validatedArtifacts(profile, pageOrigin) {
  if (!profile || profile.schemaVersion !== 1 || profile.transport !== 'streamable-http') {
    throw new Error('Unsupported hosted connection profile.');
  }
  const validated = hostedConnectionProfile(profile.endpoint, pageOrigin, profile.connectionName);
  if (validated.endpoint !== profile.endpoint) throw new Error('Non-canonical hosted connection profile.');
  return nativeLinkArtifacts(validated.endpoint, pageOrigin, validated.connectionName);
}

export function nativeConnectionClients(profile, pageOrigin = globalThis.location?.origin) {
  const links = validatedArtifacts(profile, pageOrigin);
  const name = links.profile.connectionName;
  const endpoint = links.profile.endpoint;
  return [
    {
      id: 'kiro', label: 'Kiro IDE', group: 'Developer tools',
      summary: 'Add this hosted MCP server to Kiro IDE.',
      docsUrl: 'https://kiro.dev/docs/mcp/servers/',
      availability: 'Documented import link; Dollhouse OAuth and tool calls need live-client qualification.',
      routes: [
        { id: 'native', label: 'Open in Kiro IDE', steps: [
          { title: 'Review the import', text: 'Open Kiro IDE and review the server name and URL before accepting. This link contains only the hosted endpoint and name.', href: links.kiroLink, linkLabel: 'Open in Kiro IDE' },
          oauthStep,
        ] },
        { id: 'manual', label: 'Add manually', steps: [
          { title: 'Open MCP configuration', text: 'In Kiro IDE, open MCP Servers and add a remote server. Use a free name so existing connections remain intact.' },
          { title: 'Use this configuration', text: `Merge the ${name} entry into your Kiro mcpServers configuration; preserve your other entries.`, value: links.kiroConfig, copyLabel: 'Copy Kiro JSON' },
          oauthStep,
        ] },
      ],
    },
    {
      id: 'lm-studio', label: 'LM Studio', group: 'Desktop apps',
      summary: 'Add the hosted MCP server to LM Studio.',
      docsUrl: 'https://lmstudio.ai/docs/app/mcp/deeplink',
      availability: 'Documented import link; Dollhouse OAuth and tool calls need live-client qualification.',
      routes: [
        { id: 'native', label: 'Open in LM Studio', steps: [
          { title: 'Review the import', text: 'Open LM Studio and review the server URL and name before accepting.', href: links.lmStudioLink, linkLabel: 'Open in LM Studio' },
          oauthStep,
        ] },
        { id: 'manual', label: 'Add manually', steps: [
          { title: 'Open MCP settings', text: 'In LM Studio, open the MCP server settings and add a remote server. Preserve any existing servers.' },
          { title: 'Use this configuration', text: `Add the ${name} entry to mcpServers.`, value: links.lmStudioConfig, copyLabel: 'Copy LM Studio JSON' },
          oauthStep,
        ] },
      ],
    },
    {
      id: 'goose', label: 'Goose Desktop', group: 'Desktop apps',
      summary: 'Configure a remote Streamable HTTP extension in Goose.',
      docsUrl: 'https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/using-extensions.md',
      availability: 'Manual setup available; documented import link and Dollhouse OAuth need live-client qualification.',
      routes: [
        { id: 'manual', label: 'Add manually', steps: [
          { title: 'Add a custom extension', text: 'In Goose Desktop, open Extensions → Add custom extension and choose Remote Extension (Streamable HTTP).' },
          { title: 'Enter the endpoint', text: `Use ${name} as the ID and name, and paste this URL. Keep other extensions.`, value: endpoint, copyLabel: 'Copy endpoint' },
          oauthStep,
        ] },
      ],
    },
    {
      id: 'cherry-studio', label: 'Cherry Studio', group: 'Desktop apps',
      summary: 'Configure a remote Streamable HTTP MCP server in Cherry Studio.',
      docsUrl: 'https://github.com/CherryHQ/cherry-studio/blob/main/src/shared/data/types/mcpProtocolInstall.ts',
      availability: 'Guide only: import protocol is source-confirmed but needs released-version and Dollhouse OAuth qualification.',
      routes: [
        { id: 'manual', label: 'Add manually', steps: [
          { title: 'Add a remote MCP server', text: 'In Cherry Studio MCP settings, add a server using Streamable HTTP transport.' },
          { title: 'Enter the endpoint', text: `Use ${name} as the server name and paste this base URL. Preserve other servers.`, value: endpoint, copyLabel: 'Copy endpoint' },
          oauthStep,
        ] },
      ],
    },
  ];
}
