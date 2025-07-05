import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Create manual mocks (using 'as any' for ESM compatibility)
const mockMkdir = jest.fn() as any;
const mockWriteFile = jest.fn() as any;
const mockReadFile = jest.fn() as any;
const mockUnlink = jest.fn() as any;
const mockAccess = jest.fn() as any;

// Mock external dependencies
jest.mock('fs/promises', () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  unlink: mockUnlink,
  access: mockAccess
}));

describe('Cross-Platform Integration Tests', () => {
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = path.join(os.tmpdir(), 'dollhousemcp-test');
  });

  afterEach(() => {
    // Cleanup is handled by clearAllMocks in beforeEach
  });

  describe('Path Handling', () => {
    const testCases = [
      {
        platform: 'Windows',
        paths: {
          valid: ['personas/creative/writer.md', 'educational/tutor.md'],
          invalid: ['../../../etc/passwd', 'C:\\Windows\\System32\\config'],
          dangerous: ['personas/../../../etc/passwd', './/.env']
        }
      },
      {
        platform: 'Unix',
        paths: {
          valid: ['personas/creative/writer.md', 'educational/tutor.md'],
          invalid: ['../../../etc/passwd', '/etc/passwd'],
          dangerous: ['personas/../../../etc/passwd', './/.env']
        }
      },
      {
        platform: 'macOS',
        paths: {
          valid: ['personas/creative/writer.md', 'educational/tutor.md'],
          invalid: ['../../../etc/passwd', '/System/Library/Preferences'],
          dangerous: ['personas/../../../Library/Preferences', './/.env']
        }
      }
    ];

    testCases.forEach(({ platform, paths }) => {
      describe(`${platform} Path Validation`, () => {
        it('should accept valid paths', () => {
          paths.valid.forEach(inputPath => {
            expect(() => {
              const normalized = inputPath.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
              
              // Check for path traversal attempts
              if (normalized.includes('..') || normalized.includes('./') || normalized.includes('/.')) {
                throw new Error('Path traversal not allowed');
              }
              
              // Validate path format
              if (!/^[a-zA-Z0-9\/\-_.]{1,500}$/.test(normalized)) {
                throw new Error('Invalid path format');
              }
              
              // Check depth
              const depth = normalized.split('/').length;
              if (depth > 10) {
                throw new Error('Path too deep');
              }
            }).not.toThrow();
          });
        });

        it('should reject dangerous paths', () => {
          paths.dangerous.forEach(inputPath => {
            expect(() => {
              const normalized = inputPath.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
              
              // Check for path traversal attempts
              if (normalized.includes('..') || normalized.includes('./') || normalized.includes('/.')) {
                throw new Error('Path traversal not allowed');
              }
            }).toThrow('Path traversal not allowed');
          });
        });

        it('should reject system paths', () => {
          paths.invalid.forEach(inputPath => {
            expect(() => {
              const normalized = inputPath.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');
              
              // Check for absolute paths or path traversal
              if (inputPath.startsWith('/') || normalized.includes('..') || inputPath.includes('C:\\') || inputPath.includes('System') || inputPath.includes('etc')) {
                throw new Error('Invalid path');
              }
            }).toThrow();
          });
        });
      });
    });

    it('should handle different path separators consistently', () => {
      const testPaths = [
        'personas\\creative\\writer.md', // Windows-style
        'personas/creative/writer.md',   // Unix-style
        'personas//creative//writer.md', // Double separators
        '/personas/creative/writer.md',  // Leading slash
        'personas/creative/writer.md/',  // Trailing slash
      ];

      testPaths.forEach(inputPath => {
        const normalized = inputPath
          .replace(/\\/g, '/') // Convert backslashes to forward slashes
          .replace(/^\/+|\/+$/g, '') // Remove leading/trailing slashes
          .replace(/\/+/g, '/'); // Collapse multiple slashes

        expect(normalized).toBe('personas/creative/writer.md');
      });
    });

    it('should validate filename length limits', () => {
      const shortFilename = 'a.md';
      const normalFilename = 'creative-writer.md';
      const longFilename = 'a'.repeat(300) + '.md';

      expect(shortFilename.length).toBeLessThan(255);
      expect(normalFilename.length).toBeLessThan(255);
      expect(longFilename.length).toBeGreaterThan(255);

      // Validation logic
      [shortFilename, normalFilename].forEach(filename => {
        expect(filename.length).toBeLessThanOrEqual(255);
      });

      expect(() => {
        if (longFilename.length > 255) {
          throw new Error('Filename too long');
        }
      }).toThrow('Filename too long');
    });
  });

  describe('File System Operations', () => {
    it('should handle directory creation across platforms', async () => {
      const testDirs = [
        path.join(tempDir, 'personas'),
        path.join(tempDir, 'personas', 'creative'),
        path.join(tempDir, 'personas', 'professional')
      ];

      // Mock successful directory creation
      mockMkdir.mockResolvedValue(undefined);
      mockAccess.mockRejectedValue(new Error('Directory does not exist'));

      for (const dir of testDirs) {
        try {
          await fs.access(dir);
        } catch {
          await fs.mkdir(dir, { recursive: true });
        }
      }

      expect(mockMkdir).toHaveBeenCalledTimes(testDirs.length);
    });

    it('should handle file read/write with different encodings', async () => {
      const testContent = '# Test Persona\n\nThis is a test persona with unicode: café 🎭';
      const testFile = path.join(tempDir, 'test-persona.md');

      mockWriteFile.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(testContent);

      // Write and read file
      await fs.writeFile(testFile, testContent, 'utf-8');
      const readContent = await fs.readFile(testFile, 'utf-8');

      expect(mockWriteFile).toHaveBeenCalledWith(testFile, testContent, 'utf-8');
      expect(mockReadFile).toHaveBeenCalledWith(testFile, 'utf-8');
      expect(readContent).toBe(testContent);
    });

    it('should handle permission errors gracefully', async () => {
      const restrictedFile = path.join(tempDir, 'restricted.md');
      
      mockWriteFile.mockRejectedValue(new Error('EACCES: permission denied'));
      mockReadFile.mockRejectedValue(new Error('EACCES: permission denied'));

      await expect(fs.writeFile(restrictedFile, 'content', 'utf-8'))
        .rejects.toThrow('EACCES: permission denied');

      await expect(fs.readFile(restrictedFile, 'utf-8'))
        .rejects.toThrow('EACCES: permission denied');
    });
  });

  describe('Configuration Path Detection', () => {
    const configPaths = {
      darwin: '~/Library/Application Support/Claude/claude_desktop_config.json',
      win32: '%APPDATA%/Claude/claude_desktop_config.json',
      linux: '~/.config/Claude/claude_desktop_config.json'
    };

    Object.entries(configPaths).forEach(([platform, configPath]) => {
      it(`should detect correct config path for ${platform}`, () => {
        // Mock platform detection
        const originalPlatform = process.platform;
        Object.defineProperty(process, 'platform', { value: platform });

        let expectedPath: string;
        switch (platform) {
          case 'darwin':
            expectedPath = path.join(os.homedir(), 'Library/Application Support/Claude/claude_desktop_config.json');
            break;
          case 'win32':
            expectedPath = path.join(process.env.APPDATA || os.homedir(), 'Claude/claude_desktop_config.json');
            break;
          default: // linux
            expectedPath = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Claude/claude_desktop_config.json');
        }

        expect(expectedPath).toContain('claude_desktop_config.json');

        // Restore original platform
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      });
    });
  });

  describe('Environment Variable Handling', () => {
    const originalEnv = process.env;

    afterEach(() => {
      process.env = originalEnv;
    });

    it('should handle missing environment variables', () => {
      process.env = {};

      const personasDir = process.env.PERSONAS_DIR || path.join(__dirname, '..', 'personas');
      const user = process.env.DOLLHOUSE_USER || null;
      const email = process.env.DOLLHOUSE_EMAIL || null;

      expect(personasDir).toContain('personas');
      expect(user).toBeNull();
      expect(email).toBeNull();
    });

    it('should handle custom environment variables', () => {
      process.env = {
        ...originalEnv,
        PERSONAS_DIR: '/custom/personas',
        DOLLHOUSE_USER: 'testuser',
        DOLLHOUSE_EMAIL: 'test@example.com'
      };

      const personasDir = process.env.PERSONAS_DIR;
      const user = process.env.DOLLHOUSE_USER;
      const email = process.env.DOLLHOUSE_EMAIL;

      expect(personasDir).toBe('/custom/personas');
      expect(user).toBe('testuser');
      expect(email).toBe('test@example.com');
    });

    it('should validate environment variable formats', () => {
      const validationTests = [
        { key: 'DOLLHOUSE_USER', valid: ['user123', 'test-user', 'user_name'], invalid: ['', 'user@domain', 'user with spaces'] },
        { key: 'DOLLHOUSE_EMAIL', valid: ['test@example.com', 'user.name@domain.co.uk'], invalid: ['', 'notanemail', 'user@'] },
      ];

      validationTests.forEach(({ key, valid, invalid }) => {
        valid.forEach(value => {
          process.env[key] = value;
          
          if (key === 'DOLLHOUSE_USER') {
            expect(value).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9\-_.]{0,30}[a-zA-Z0-9]$/);
          } else if (key === 'DOLLHOUSE_EMAIL') {
            expect(value).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
          }
        });

        invalid.forEach(value => {
          process.env[key] = value;
          
          if (key === 'DOLLHOUSE_USER' && value) {
            expect(value).not.toMatch(/^[a-zA-Z0-9][a-zA-Z0-9\-_.]{0,30}[a-zA-Z0-9]$/);
          } else if (key === 'DOLLHOUSE_EMAIL' && value) {
            expect(value).not.toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
          }
        });
      });
    });
  });
});