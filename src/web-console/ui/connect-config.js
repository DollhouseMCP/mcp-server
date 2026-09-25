/** Pure connection configuration; native formats stay separate from UI and permission evaluation. */

export const DEFAULT_CONNECTION_NAME = 'dollhouse-beta';

export function validateConnectionName(value) {
  const match = typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.exec(value);
  // JavaScript's $ anchor also matches just before a final newline.
  if (!match || match[0] !== value) {
    throw new Error('Use 1–64 letters, numbers, hyphens or underscores, starting with a letter or number.');
  }
  return value;
}

export function hostedConnectionProfile(endpoint, pageOrigin, connectionName = DEFAULT_CONNECTION_NAME) {
  return Object.freeze({
    schemaVersion: 1,
    connectionName: validateConnectionName(connectionName),
    endpoint: validateHostedMcpEndpoint(endpoint, pageOrigin),
    transport: 'streamable-http',
  });
}

export function validateHostedMcpEndpoint(value, pageOrigin) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Connection metadata did not include an MCP endpoint.');
  if (unsafeEndpointText(value)) {
    throw new Error('Connection metadata did not provide a safe endpoint for this deployment.');
  }
  let endpoint;
  let origin;
  try {
    endpoint = new URL(value);
    origin = new URL(pageOrigin);
  } catch {
    throw new Error('Connection metadata included an invalid MCP endpoint.');
  }
  if (unsafeEndpointText(endpoint.href)) {
    throw new Error('Connection metadata did not provide a safe endpoint for this deployment.');
  }
  const loopbackHttp = endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname);
  if ((endpoint.protocol !== 'https:' && !loopbackHttp)
      || endpoint.origin !== origin.origin
      || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash) {
    throw new Error('Connection metadata did not provide a safe endpoint for this deployment.');
  }
  return endpoint.href;
}

function unsafeEndpointText(value) {
  return value.includes("'") || value.includes('\\') || [...value].some(character => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 32 || codePoint === 127;
  });
}

function base64Utf8(value) {
  // Endpoint validation and URL canonicalization constrain this JSON to ASCII.
  return btoa(value);
}

export function connectionArtifacts(endpoint, pageOrigin, connectionName = DEFAULT_CONNECTION_NAME) {
  const profile = hostedConnectionProfile(endpoint, pageOrigin, connectionName);
  const safeEndpoint = profile.endpoint;
  const cursorLinkConfig = JSON.stringify({ url: safeEndpoint });
  const cursorConfig = JSON.stringify({ mcpServers: { [profile.connectionName]: { url: safeEndpoint } } }, null, 2);
  return Object.freeze({
    profile,
    endpoint: safeEndpoint,
    claudeAdd: `claude mcp add --transport http --scope user ${profile.connectionName} '${safeEndpoint}'`,
    claudeLogin: `claude mcp login ${profile.connectionName}`,
    codexAdd: `codex mcp add ${profile.connectionName} --url '${safeEndpoint}'`,
    codexLogin: `codex mcp login ${profile.connectionName}`,
    cursorLink: `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(profile.connectionName)}&config=${encodeURIComponent(base64Utf8(cursorLinkConfig))}`,
    cursorConfig,
    vscodeLink: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: profile.connectionName, type: 'http', url: safeEndpoint }))}`,
    vscodeConfig: JSON.stringify({ servers: { [profile.connectionName]: { type: 'http', url: safeEndpoint } } }, null, 2),
  });
}
