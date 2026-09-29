import { DOLLHOUSE_MCP_SERVER_NAMES } from './constants.js';
import { env } from './env.js';

/** Keep configured spelling for host permission patterns; local comparisons ignore case. */
export function getDollhouseMcpServerNames(): readonly string[] {
  return [...new Set<string>([
    ...DOLLHOUSE_MCP_SERVER_NAMES,
    ...(env.DOLLHOUSE_MCP_SERVER_NAME ? [env.DOLLHOUSE_MCP_SERVER_NAME] : []),
  ])];
}

export function isDollhouseMcpServerName(name: string): boolean {
  return getDollhouseMcpServerNames().some(ownName => ownName.toLowerCase() === name.toLowerCase());
}
