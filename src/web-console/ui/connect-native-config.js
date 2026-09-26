/** Product-specific import payloads. Only validated, non-secret hosted connection data enters links. */

import { DEFAULT_CONNECTION_NAME, hostedConnectionProfile } from './connect-config.js';

function base64Json(value) {
  // hostedConnectionProfile limits the dynamic values to canonical URL ASCII and an ASCII name.
  return btoa(JSON.stringify(value));
}

export function nativeLinkArtifacts(endpoint, pageOrigin, connectionName = DEFAULT_CONNECTION_NAME) {
  const profile = hostedConnectionProfile(endpoint, pageOrigin, connectionName);
  const name = profile.connectionName;
  const url = profile.endpoint;
  const kiroEntry = { url, disabled: false, autoApprove: [] };
  const lmStudioEntry = { url };
  const cherryEntry = { name, type: 'streamableHttp', baseUrl: url };

  return Object.freeze({
    profile,
    kiroLink: `https://kiro.dev/launch/mcp/add?name=${encodeURIComponent(name)}&config=${encodeURIComponent(JSON.stringify(kiroEntry))}`,
    kiroConfig: JSON.stringify({ mcpServers: { [name]: kiroEntry } }, null, 2),
    lmStudioLink: `lmstudio://add_mcp?name=${encodeURIComponent(name)}&config=${encodeURIComponent(base64Json(lmStudioEntry))}`,
    lmStudioConfig: JSON.stringify({ mcpServers: { [name]: lmStudioEntry } }, null, 2),
    gooseLink: `goose://extension?url=${encodeURIComponent(url)}&type=streamable_http&id=${encodeURIComponent(name)}&name=${encodeURIComponent(name)}&description=${encodeURIComponent('DollhouseMCP hosted server')}`,
    cherryStudioLink: `cherrystudio://mcp/install?servers=${encodeURIComponent(base64Json({ mcpServers: { [name]: cherryEntry } }))}`,
    cherryStudioConfig: JSON.stringify({ mcpServers: { [name]: cherryEntry } }, null, 2),
  });
}
