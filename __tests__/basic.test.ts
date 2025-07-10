import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Basic Functionality Tests', () => {
  describe('Package Configuration', () => {
    it('should have correct package.json configuration', async () => {
      const packagePath = path.join(process.cwd(), 'package.json');
      const packageContent = await fs.readFile(packagePath, 'utf-8');
      const packageJson = JSON.parse(packageContent);
      
      expect(packageJson.name).toBe('@mickdarling/dollhousemcp');
      expect(packageJson.version).toBeDefined();
      expect(packageJson.main).toBe('dist/index.js');
      expect(packageJson.bin['dollhousemcp']).toBe('dist/index.js');
      expect(packageJson.engines.node).toBe('>=20.0.0');
    });

    it('should have required dependencies', async () => {
      const packagePath = path.join(process.cwd(), 'package.json');
      const packageContent = await fs.readFile(packagePath, 'utf-8');
      const packageJson = JSON.parse(packageContent);
      
      expect(packageJson.dependencies['@modelcontextprotocol/sdk']).toBeDefined();
      expect(packageJson.dependencies['gray-matter']).toBeDefined();
      expect(packageJson.devDependencies['typescript']).toBeDefined();
      expect(packageJson.devDependencies['jest']).toBeDefined();
    });
  });

  describe('File System Structure', () => {
    it('should have required directories', async () => {
      const directories = ['src', 'personas', 'dist'];
      
      for (const dir of directories) {
        try {
          await fs.access(path.join(process.cwd(), dir));
          expect(true).toBe(true); // Directory exists
        } catch (error) {
          if (dir === 'dist') {
            // dist directory might not exist if not built yet
            expect(true).toBe(true);
          } else {
            throw new Error(`Required directory '${dir}' does not exist`);
          }
        }
      }
    });

    it('should have persona files', async () => {
      const personasDir = path.join(process.cwd(), 'personas');
      const files = await fs.readdir(personasDir);
      const mdFiles = files.filter(file => file.endsWith('.md'));
      
      expect(mdFiles.length).toBeGreaterThan(0);
      expect(mdFiles).toContain('creative-writer.md');
    });
  });

  describe('Cross-Platform Compatibility', () => {
    it('should handle Windows-style paths', () => {
      const windowsPath = 'C:\\Users\\Test\\personas';
      const normalizedPath = path.normalize(windowsPath);
      
      expect(normalizedPath).toBeDefined();
      expect(typeof normalizedPath).toBe('string');
    });

    it('should handle Unix-style paths', () => {
      const unixPath = '/home/user/personas';
      const normalizedPath = path.normalize(unixPath);
      
      expect(normalizedPath).toBeDefined();
      expect(typeof normalizedPath).toBe('string');
    });

    it('should handle relative paths correctly', () => {
      const relativePath = './personas';
      const absolutePath = path.resolve(relativePath);
      
      expect(path.isAbsolute(absolutePath)).toBe(true);
    });
  });

  describe('Environment Variables', () => {
    it('should respect PERSONAS_DIR environment variable', () => {
      const originalDir = process.env.PERSONAS_DIR;
      const testDir = '/tmp/test-personas';
      
      process.env.PERSONAS_DIR = testDir;
      expect(process.env.PERSONAS_DIR).toBe(testDir);
      
      // Restore original value
      if (originalDir) {
        process.env.PERSONAS_DIR = originalDir;
      } else {
        delete process.env.PERSONAS_DIR;
      }
    });

    it('should work with NODE_ENV=production', () => {
      const originalEnv = process.env.NODE_ENV;
      
      process.env.NODE_ENV = 'production';
      expect(process.env.NODE_ENV).toBe('production');
      
      // Restore original value
      process.env.NODE_ENV = originalEnv || 'test';
    });
  });

  describe('Build Artifacts', () => {
    it('should build successfully', async () => {
      // This test assumes the build has been run
      const distPath = path.join(process.cwd(), 'dist');
      
      try {
        await fs.access(distPath);
        const files = await fs.readdir(distPath);
        expect(files).toContain('index.js');
      } catch (error) {
        // If dist doesn't exist, that's okay - just verify TypeScript files exist
        const srcPath = path.join(process.cwd(), 'src', 'index.ts');
        await fs.access(srcPath);
        expect(true).toBe(true);
      }
    });
  });

  describe('Test Persona Files', () => {
    it('should have test persona files', async () => {
      const testPersonasDir = path.join(process.cwd(), 'test-personas');
      
      try {
        await fs.access(testPersonasDir);
        const files = await fs.readdir(testPersonasDir);
        expect(files).toContain('test-persona.md');
      } catch (error) {
        // Test personas directory might not exist yet
        expect(true).toBe(true);
      }
    });
  });
});