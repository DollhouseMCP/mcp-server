#!/usr/bin/env ts-node

/**
 * Generate Authentication Token
 *
 * Creates a signed JWT for use with DollhouseMCP's local dev auth provider.
 * The token is printed to stdout for easy piping into config files.
 *
 * Usage:
 *   npx tsx scripts/generate-auth-token.ts --sub todd
 *   npx tsx scripts/generate-auth-token.ts --sub todd --ttl 3600
 *   npx tsx scripts/generate-auth-token.ts --sub todd --email todd@example.com
 *   npx tsx scripts/generate-auth-token.ts --sub todd --display-name "Todd D"
 *
 * Options:
 *   --sub <username>       Subject (required) — the user identity
 *   --display-name <name>  Human-readable display name
 *   --email <email>        Email address
 *   --ttl <seconds>        Token lifetime in seconds (default: 86400 = 24h)
 *   --key-file <path>      Override key pair file location
 */

import * as path from 'node:path';
import os from 'node:os';
import { LocalDevAuthProvider } from '../src/auth/LocalDevAuthProvider.js';

const args = process.argv.slice(2);

function getArgValue(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const sub = getArgValue('--sub');
  if (!sub) {
    console.error('Usage: npx tsx scripts/generate-auth-token.ts --sub <username> [options]');
    console.error();
    console.error('Options:');
    console.error('  --sub <username>       Subject identity (required)');
    console.error('  --display-name <name>  Display name');
    console.error('  --email <email>        Email address');
    console.error('  --ttl <seconds>        Token lifetime (default: 86400)');
    console.error('  --key-file <path>      Key pair file location');
    process.exit(1);
  }

  const displayName = getArgValue('--display-name');
  const email = getArgValue('--email');
  const ttlStr = getArgValue('--ttl');
  const ttlSeconds = ttlStr ? Number.parseInt(ttlStr, 10) : 86400;

  const homeDir = process.env.DOLLHOUSE_HOME_DIR || os.homedir();
  const keyFilePath = getArgValue('--key-file')
    || process.env.DOLLHOUSE_AUTH_LOCAL_KEY_FILE
    || path.join(homeDir, '.dollhouse', 'run', 'auth-keypair.json');

  const provider = new LocalDevAuthProvider({ keyFilePath });
  const token = await provider.issue(sub, { displayName, email, ttlSeconds });

  // Print only the token to stdout (for piping)
  process.stdout.write(token + '\n');

  // Print usage info to stderr (doesn't interfere with piping)
  process.stderr.write(`\nToken generated for '${sub}' (TTL: ${ttlSeconds}s)\n`);
  process.stderr.write(`Key file: ${keyFilePath}\n\n`);
  process.stderr.write(`Use in MCP client config:\n`);
  process.stderr.write(`  "headers": { "Authorization": "Bearer ${token}" }\n\n`);
}

try {
  await main();
} catch (err) {
  console.error('Fatal error:', err);
  process.exit(1);
}
