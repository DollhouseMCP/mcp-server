#!/usr/bin/env node

/**
 * Start the compiled MCP server from the repository working directory.
 *
 * External clients may need their own package directory as cwd. This small
 * adapter keeps the server's runtime path behavior identical to `npm start`
 * without relying on a platform-specific shell command.
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntryPoint = path.join(projectRoot, 'dist', 'index.js');

process.chdir(projectRoot);
// The server intentionally starts only when it is the process entry point.
// Preserve that guard while importing from this cwd adapter.
process.argv[1] = serverEntryPoint;
await import(pathToFileURL(serverEntryPoint).href);
