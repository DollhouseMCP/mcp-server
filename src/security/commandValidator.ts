import { spawn, SpawnOptions } from 'child_process';
import path from 'path';

const ALLOWED_COMMANDS = {
  git: ['pull', 'status', 'log', 'rev-parse', 'branch', 'checkout'],
  npm: ['install', 'run', 'audit', 'ci', '--version'],
  node: ['--version'],
  npx: ['--version']
};

export class CommandValidator {
  static sanitizeCommand(cmd: string, args: string[]): void {
    if (!ALLOWED_COMMANDS[cmd]) {
      throw new Error(`Command not allowed: ${cmd}`);
    }
    
    const allowedArgs = ALLOWED_COMMANDS[cmd];
    for (const arg of args) {
      // Check if it's in allowed list or matches safe pattern
      if (!allowedArgs.includes(arg) && !this.isSafeArgument(arg)) {
        throw new Error(`Argument not allowed: ${arg}`);
      }
    }
  }

  private static isSafeArgument(arg: string): boolean {
    // Allow alphanumeric, dash, underscore, dot
    return /^[a-zA-Z0-9\-_.]+$/.test(arg);
  }

  static async secureExec(command: string, args: string[], options?: SpawnOptions): Promise<string> {
    this.sanitizeCommand(command, args);
    
    const safeOptions: SpawnOptions = {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin:/usr/local/bin' // Restrict PATH
      },
      cwd: options?.cwd || process.cwd(),
      timeout: options?.timeout || 30000 // 30 second default
    };
    
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, safeOptions);
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout?.on('data', (data) => stdout += data);
      proc.stderr?.on('data', (data) => stderr += data);
      
      proc.on('exit', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Command failed (${code}): ${stderr}`));
        }
      });
      
      proc.on('error', reject);
    });
  }
}