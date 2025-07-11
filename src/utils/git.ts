/**
 * Git-related utility functions
 */

import * as child_process from 'child_process';
import { promisify } from 'util';

const exec = promisify(child_process.exec);

const ALLOWED_COMMANDS = {
  git: ['pull', 'status', 'log', 'rev-parse', 'branch', 'checkout', 'fetch', '--abbrev-ref', 'HEAD', '--porcelain'],
  npm: ['install', 'run', 'audit', 'ci', '--version', 'build'],
  node: ['--version'],
  npx: ['--version']
};

/**
 * Validate command arguments for safety
 */
function validateCommand(cmd: string, args: string[]): void {
  if (!ALLOWED_COMMANDS[cmd]) {
    throw new Error(`Command not allowed: ${cmd}`);
  }
  
  const allowedArgs = ALLOWED_COMMANDS[cmd];
  for (const arg of args) {
    // Check if it's in allowed list or matches safe pattern
    if (!allowedArgs.includes(arg) && !isSafeArgument(arg)) {
      throw new Error(`Argument not allowed: ${arg}`);
    }
  }
}

/**
 * Check if an argument is safe (alphanumeric, dash, underscore, dot)
 */
function isSafeArgument(arg: string): boolean {
  return /^[a-zA-Z0-9\-_.\/]+$/.test(arg);
}

/**
 * Execute a command safely using spawn to prevent command injection
 */
export function safeExec(
  command: string, 
  args: string[], 
  options: { cwd?: string } = {}
): Promise<{ stdout: string; stderr: string }> {
  // Validate command and arguments
  validateCommand(command, args);
  
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn(command, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin:/usr/local/bin' // Restrict PATH
      }
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${stderr}`));
      }
    });
    
    proc.on('error', (error) => {
      reject(error);
    });
  });
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