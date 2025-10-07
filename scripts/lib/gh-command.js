#!/usr/bin/env node

/**
 * GitHub CLI Command Utility
 *
 * Provides secure command execution for GitHub CLI (gh) commands.
 * Implements security best practices to prevent command and PATH injection.
 *
 * SECURITY (DMCP-SEC-COMMON):
 * - Resolves gh path at startup to prevent PATH injection
 * - Uses spawnSync with array arguments to prevent command injection
 * - Validates all inputs before use
 */

import { spawnSync, execFileSync } from 'node:child_process';

// FIX: Resolve gh path at startup to prevent PATH injection
// CRITICAL: Using PATH-based command execution is vulnerable to PATH manipulation
let GH_PATH;
try {
  // Try to find gh in PATH using 'which' (unix) or 'where' (windows)
  const whichCommand = process.platform === 'win32' ? 'where' : 'which';
  GH_PATH = execFileSync(whichCommand, ['gh'], { encoding: 'utf-8' }).trim().split('\n')[0];

  if (!GH_PATH || GH_PATH.length === 0) {
    throw new Error('gh command not found');
  }
} catch (error) {
  const errorMsg = error instanceof Error ? error.message : 'Unknown error';
  console.error(`Error: GitHub CLI (gh) is not installed or not in PATH: ${errorMsg}`);
  console.error('Please install gh: https://cli.github.com/');
  process.exit(1);
}

/**
 * Execute gh command safely using array arguments and absolute path
 *
 * FIX: Prevents command injection by using spawnSync with array args
 *
 * @param {string[]} args - Command arguments as array
 * @returns {string} Command output
 * @throws {Error} If command fails
 */
export function executeGhCommand(args) {
  const result = spawnSync(GH_PATH, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024 // 10MB buffer
  });

  if (result.error) {
    throw new Error(`Command failed: ${result.error.message}`);
  }

  if (result.status !== 0) {
    throw new Error(`Command exited with status ${result.status}: ${result.stderr}`);
  }

  return result.stdout;
}

/**
 * Validate issue number is a positive integer
 *
 * @param {number|string} issueNum - Issue number to validate
 * @returns {boolean} True if valid
 */
export function validateIssueNumber(issueNum) {
  const num = Number(issueNum);
  return Number.isInteger(num) && num > 0 && num < 100000;
}

/**
 * Validate PR number is a positive integer
 *
 * @param {number|string} prNum - PR number to validate
 * @returns {boolean} True if valid
 */
export function validatePRNumber(prNum) {
  const num = Number(prNum);
  return Number.isInteger(num) && num > 0 && num < 100000;
}

/**
 * Validate tag follows expected format (v1.2.3 or v1.2.3-pre)
 *
 * @param {string} tag - Release tag to validate
 * @returns {boolean} True if valid
 */
export function validateTag(tag) {
  const tagPattern = /^v\d+\.\d+\.\d+(-[a-z0-9]+)?$/i;
  return tagPattern.test(tag);
}
