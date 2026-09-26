/** Additional hosted MCP connection guides. Each route describes one client surface. */

import { hostedConnectionProfile } from './connect-config.js';
import { developerClients } from './connect-extra-developer.js';
import { microsoftGoogleClients } from './connect-extra-platforms.js';
import { appClients } from './connect-extra-apps.js';

export function additionalConnectionClients(profile, pageOrigin = globalThis.location?.origin) {
  // Revalidate even when a caller supplies an object that resembles a profile.
  if (!profile || profile.schemaVersion !== 1 || profile.transport !== 'streamable-http') {
    throw new Error('A hosted connection profile is required.');
  }
  if (typeof pageOrigin !== 'string' || !pageOrigin) throw new Error('The deployment origin is required.');
  const safe = hostedConnectionProfile(profile.endpoint, pageOrigin, profile.connectionName);
  if (safe.endpoint !== profile.endpoint) throw new Error('A canonical hosted MCP endpoint is required.');
  return [...developerClients(safe), ...microsoftGoogleClients(safe), ...appClients(safe)];
}
