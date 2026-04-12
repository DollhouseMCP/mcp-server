#!/usr/bin/env node

/**
 * CLI commands for console token management (#1790).
 *
 * Usage:
 *   dollhouse console token show [--json]
 *   dollhouse console token rotate [--json]
 *   dollhouse console token revoke [--id <uuid>] [--json]
 *
 * Exit codes:
 *   0 — success
 *   1 — user error (missing file, invalid args)
 *   2 — auth/confirmation failure (wrong TOTP code, not enrolled)
 *
 * @since v2.1.0 — Issue #1790
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  ConsoleTokenStore,
  readTokenFileRaw,
  TotpError,
  DEFAULT_TOKEN_FILE,
  type ConsoleTokenFile,
  type RotationResult,
} from '../web/console/consoleToken.js';
import { env } from '../config/env.js';

/** Resolve the token file path from env or default. */
function resolveTokenFilePath(): string {
  return env.DOLLHOUSE_CONSOLE_TOKEN_FILE || DEFAULT_TOKEN_FILE;
}

/** Read token file or exit with error. */
async function readFileOrExit(filePath: string): Promise<ConsoleTokenFile> {
  const data = await readTokenFileRaw(filePath);
  if (!data) {
    console.error(chalk.red('Token file not found or corrupt: ' + filePath));
    console.error(chalk.gray('The token file is created automatically when the server starts.'));
    process.exit(1);
  }
  return data;
}

/** Prompt the user for a TOTP code on stdin. */
async function promptTotpCode(): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const code = await rl.question(chalk.cyan('Enter TOTP code (or backup code): '));
    // Strip whitespace and dashes — users may type backup codes as "XXXX-XXXX"
    const trimmed = code.trim().replaceAll(/[\s-]/g, '');
    if (!trimmed) {
      console.error(chalk.red('No confirmation code provided.'));
      process.exit(2);
    }
    // Accept 6-digit TOTP codes or 8-char alphanumeric backup codes
    if (!/^\d{6}$/.test(trimmed) && !/^[0-9A-Za-z]{8}$/.test(trimmed)) {
      console.error(chalk.red('Invalid code format. Enter a 6-digit TOTP code or an 8-character backup code.'));
      process.exit(2);
    }
    return trimmed;
  } finally {
    rl.close();
  }
}

/**
 * Shared rotation logic for both `rotate` and `revoke` commands.
 * Initializes the store, checks TOTP enrollment, obtains the confirmation
 * code (from --code flag or interactive prompt), and calls rotatePrimary.
 *
 * @param operation - 'rotation' or 'revocation' for user-facing messages
 */
async function executeRotation(
  options: { json?: boolean; code?: string },
  operation: 'rotation' | 'revocation',
): Promise<RotationResult> {
  const filePath = resolveTokenFilePath();
  const store = new ConsoleTokenStore(filePath);
  await store.ensureInitialized('CLI');

  if (!store.isTotpEnrolled()) {
    if (options.json) {
      console.log(JSON.stringify({ error: 'TOTP enrollment required', code: 'TOTP_REQUIRED' }));
    } else {
      console.error(chalk.red(`Token ${operation} requires TOTP enrollment.`));
      console.error(chalk.gray('Enroll via the Security tab or the TOTP enrollment API.'));
    }
    process.exit(2);
  }

  const code = options.code || await promptTotpCode();

  try {
    return await store.rotatePrimary(code);
  } catch (err) {
    if (err instanceof TotpError) {
      if (options.json) {
        console.log(JSON.stringify({ error: err.message, code: err.code }));
      } else {
        console.error(chalk.red(`${operation.charAt(0).toUpperCase() + operation.slice(1)} failed: ${err.message}`));
      }
      process.exit(2);
    }
    console.error(chalk.red(`Unexpected error during ${operation}: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

/**
 * Format and print the result of a rotation/revocation operation.
 * Handles both JSON and human-readable output for rotate and revoke.
 */
function printRotationResult(
  result: RotationResult,
  options: { json?: boolean },
  operation: 'rotation' | 'revocation',
): void {
  if (options.json) {
    const output = operation === 'rotation'
      ? { token: result.token, rotatedAt: result.rotatedAt, graceUntil: result.graceUntil }
      : { revoked: true, newToken: result.token, rotatedAt: result.rotatedAt };
    console.log(JSON.stringify(output, null, 2));
  } else {
    const successMsg = operation === 'rotation'
      ? 'Token rotated successfully.'
      : 'Token revoked. A new token has been issued.';
    const statusMsg = operation === 'rotation'
      ? `Old token valid until: ${new Date(result.graceUntil).toISOString()}`
      : 'All sessions using the old token will lose access after the grace window.';
    console.log(chalk.green(successMsg));
    console.log(result.token);
    console.log(chalk.gray(`Rotated at: ${result.rotatedAt}`));
    console.log(chalk.gray(statusMsg));
  }
}

// ── Program ─────────────────────────────────────────────────────────────

const program = new Command();

program
  .name('dollhouse console token')
  .description('Manage console authentication tokens');

// ── show ────────────────────────────────────────────────────────────────

program
  .command('show')
  .description('Print the current primary console token')
  .option('--json', 'Output as JSON for scripted consumption')
  .option('--masked', 'Show masked token instead of full value')
  .action(async (options: { json?: boolean; masked?: boolean }) => {
    const filePath = resolveTokenFilePath();
    const data = await readFileOrExit(filePath);
    const primary = data.tokens[0];
    if (!primary) {
      console.error(chalk.red('No tokens found in the token file.'));
      process.exit(1);
    }

    if (options.json) {
      const output: Record<string, unknown> = {
        id: primary.id,
        name: primary.name,
        kind: primary.kind,
        token: options.masked ? primary.token.slice(0, 8) + '...' : primary.token,
        scopes: primary.scopes,
        createdAt: primary.createdAt,
        lastUsedAt: primary.lastUsedAt,
        createdVia: primary.createdVia,
        filePath,
        totpEnrolled: data.totp.enrolled,
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      const tokenDisplay = options.masked
        ? primary.token.slice(0, 8) + chalk.gray('•'.repeat(56))
        : primary.token;
      console.log(tokenDisplay);
    }
  });

// ── rotate ──────────────────────────────────────────────────────────────

program
  .command('rotate')
  .description('Rotate the primary console token (requires TOTP confirmation)')
  .option('--json', 'Output as JSON for scripted consumption')
  .option('--code <code>', 'TOTP confirmation code (prompts if omitted)')
  .action(async (options: { json?: boolean; code?: string }) => {
    const result = await executeRotation(options, 'rotation');
    printRotationResult(result, options, 'rotation');
  });

// ── revoke ──────────────────────────────────────────────────────────────

program
  .command('revoke')
  .description('Revoke a token — rotates the primary to invalidate the current value')
  .option('--json', 'Output as JSON for scripted consumption')
  .option('--code <code>', 'TOTP confirmation code (prompts if omitted)')
  .action(async (options: { json?: boolean; code?: string }) => {
    // For Phase 2 with a single primary token, revoke == rotate.
    // When multi-device tokens land, --id <uuid> removes a specific
    // non-primary token from the store.
    const result = await executeRotation(options, 'revocation');
    printRotationResult(result, options, 'revocation');
  });

program.parse(process.argv);
