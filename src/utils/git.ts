/**
 * Git-related utility functions
 */

import * as child_process from 'child_process';
import { promisify } from 'util';
import { CommandValidator } from '../security/commandValidator.js';

const exec = promisify(child_process.exec);

/**
 * Execute a command safely using CommandValidator
 */
export async function safeExec(
  command: string, 
  args: string[], 
  options: { cwd?: string; timeout?: number } = {}
): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await CommandValidator.secureExec(command, args, {
      cwd: options.cwd,
      timeout: options.timeout || 30000
    });
    
    return { stdout: result, stderr: '' };
  } catch (error) {
    // Convert to expected format with stderr
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(errorMessage);
  }
}

/**
 * Execute a command using exec (use only for trusted input)
 */
export { exec };

/**
 * Get current git branch
 */
export async function getCurrentGitBranch(cwd: string): Promise<string> {
  try {
    const { stdout } = await safeExec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    return stdout.trim();
  } catch (error) {
    throw new Error(`Failed to get current git branch: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get current git commit hash
 */
export async function getCurrentGitCommit(cwd: string): Promise<string> {
  try {
    const { stdout } = await safeExec('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim();
  } catch (error) {
    throw new Error(`Failed to get current git commit: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Check if git repository has uncommitted changes
 */
export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await safeExec('git', ['status', '--porcelain'], { cwd });
    return stdout.trim().length > 0;
  } catch (error) {
    throw new Error(`Failed to check git status: ${error instanceof Error ? error.message : String(error)}`);
  }
}