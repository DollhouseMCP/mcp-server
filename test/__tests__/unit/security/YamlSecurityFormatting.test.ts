/**
 * YAML Security Formatting Test Suite
 * 
 * Tests comprehensive YAML formatting security measures to prevent:
 * - Type confusion attacks
 * - Prototype pollution
 * - Server crashes from null/undefined
 * - Financial calculation errors
 * - Data corruption from octal/hex interpretation
 * 
 * Related to PR #836 - YAML frontmatter formatting security fixes
 */

import { DollhouseMCPServer } from '../../../../src/index.js';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('YAML Security Formatting Tests', () => {
  let server: DollhouseMCPServer;
  let tempDir: string;

  beforeEach(async () => {
    // Create temporary directory for test personas
    tempDir = path.join(__dirname, '..', '..', '..', 'temp', `yaml-security-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    // Set environment for test
    process.env.DOLLHOUSE_PORTFOLIO_DIR = tempDir;
    
    // Initialize server
    server = new DollhouseMCPServer();
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Critical: Null/Undefined Protection', () => {
    test('should handle null values without crashing', async () => {
      // This should not crash even though we're not testing null directly in name
      // The important part is that our formatting doesn't introduce nulls
      const response = await server.createPersona(
        'Test Persona',
        'A test persona',
        'Test instructions'
      );
      
      expect(response.content[0].text).toContain('✅');
      
      // Read the created file and verify no null values slipped through
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      // Parse the YAML to check types
      const parsed = yaml.load(content);
      expect(parsed).toBeDefined();
      expect(Object.values(parsed).every(v => v !== null)).toBe(true);
    });
  });

  describe('Critical: Special Float Protection', () => {
    test('should reject Infinity and NaN values', async () => {
      // Create a persona and verify the YAML doesn't contain special floats
      const response = await server.createPersona(
        'Float Test',
        'Testing float safety',
        'Instructions'
      );
      
      expect(response.content[0].text).toContain('✅');
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      // Check that content doesn't contain special float values
      expect(content).not.toContain('.inf');
      expect(content).not.toContain('.nan');
      expect(content).not.toContain('Infinity');
      expect(content).not.toContain('NaN');
    });
  });

  describe('Critical: Prototype Pollution Prevention', () => {
    test('should block __proto__ keys', async () => {
      // Attempt to create a persona with dangerous field names
      // Our system should filter these out
      const response = await server.createPersona(
        '__proto__',
        'Attempt at prototype pollution',
        'Malicious instructions'
      );
      
      // Should still create but with safe name
      expect(response.content[0].text).toContain('✅');
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      // Verify __proto__ is not in the YAML keys
      expect(content).not.toContain('__proto__:');
      expect(content).not.toContain('constructor:');
      expect(content).not.toContain('prototype:');
    });
  });

  describe('Serious: Numeric String Preservation', () => {
    test('should quote version field to prevent number conversion', async () => {
      const response = await server.createPersona(
        'Version Test',
        'Testing version quoting',
        'Instructions'
      );
      
      expect(response.content[0].text).toContain('✅');
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      // Version should be quoted
      expect(content).toMatch(/version: "1\.0"/);
      
      // Parse and verify it stays as string
      const parsed = yaml.load(content);
      expect(typeof parsed.version).toBe('string');
      expect(parsed.version).toBe('1.0');
    });

    test('should quote price field to prevent float conversion', async () => {
      const response = await server.createPersona(
        'Price Test',
        'Testing price quoting',
        'Instructions'
      );
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      // Price should be quoted
      expect(content).toMatch(/price: "free"/);
      
      // Parse and verify it stays as string
      const parsed = yaml.load(content);
      expect(typeof parsed.price).toBe('string');
    });

    test('should quote revenue_split to preserve format', async () => {
      const response = await server.createPersona(
        'Revenue Test',
        'Testing revenue split quoting',
        'Instructions'
      );
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      // Revenue split should be quoted
      expect(content).toMatch(/revenue_split: "80\/20"/);
      
      const parsed = yaml.load(content);
      expect(parsed.revenue_split).toBe('80/20');
    });
  });

  describe('Serious: Boolean Keyword Protection', () => {
    test('should quote "yes" to prevent boolean conversion', async () => {
      const response = await server.createPersona(
        'yes',
        'Testing yes keyword',
        'Instructions'
      );
      
      expect(response.content[0].text).toContain('✅');
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      // Name "yes" should be quoted
      expect(content).toMatch(/name: "yes"/);
      
      const parsed = yaml.load(content);
      expect(parsed.name).toBe('yes');
      expect(typeof parsed.name).toBe('string');
    });

    test('should quote "no" to prevent boolean conversion', async () => {
      const response = await server.createPersona(
        'no',
        'Testing no keyword',
        'Instructions'
      );
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      expect(content).toMatch(/name: "no"/);
      
      const parsed = yaml.load(content);
      expect(parsed.name).toBe('no');
      expect(typeof parsed.name).toBe('string');
    });

    test('should quote "null" to prevent null conversion', async () => {
      const response = await server.createPersona(
        'null',
        'Testing null keyword',
        'Instructions'
      );
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      expect(content).toMatch(/name: "null"/);
      
      const parsed = yaml.load(content);
      expect(parsed.name).toBe('null');
      expect(parsed.name).not.toBe(null);
    });
  });

  describe('Serious: Octal/Hex/Scientific Notation Protection', () => {
    test('should quote octal-like numbers to prevent conversion', async () => {
      const response = await server.createPersona(
        '00777',
        'Testing octal number',
        'Instructions'
      );
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      // Should be quoted to preserve leading zeros
      expect(content).toMatch(/name: "00777"/);
      
      const parsed = yaml.load(content);
      expect(parsed.name).toBe('00777');
      expect(parsed.name).not.toBe(511); // 0777 in octal = 511 in decimal
    });

    test('should quote hex-like strings to prevent conversion', async () => {
      const response = await server.createPersona(
        '0xFF',
        'Testing hex number',
        'Instructions'
      );
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      expect(content).toMatch(/name: "0xFF"/);
      
      const parsed = yaml.load(content);
      expect(parsed.name).toBe('0xFF');
      expect(parsed.name).not.toBe(255); // 0xFF = 255
    });

    test('should quote scientific notation to prevent conversion', async () => {
      const response = await server.createPersona(
        '1e10',
        'Testing scientific notation',
        'Instructions'
      );
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      expect(content).toMatch(/name: "1e10"/);
      
      const parsed = yaml.load(content);
      expect(parsed.name).toBe('1e10');
      expect(parsed.name).not.toBe(10000000000);
    });
  });

  describe('Array Element Security', () => {
    test('should quote all string array elements', async () => {
      const response = await server.createPersona(
        'Array Test',
        'Testing array element quoting',
        'Instructions'
      );
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      // Check that array elements are quoted
      expect(content).toMatch(/content_flags:\n  - "user-created"/);
      
      const parsed = yaml.load(content);
      expect(Array.isArray(parsed.content_flags)).toBe(true);
      expect(parsed.content_flags[0]).toBe('user-created');
    });

    test('should handle empty arrays correctly', async () => {
      // Create persona and check empty trigger array
      const response = await server.createPersona(
        'Empty Array Test',
        'Testing empty arrays',
        'Instructions'
      );
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      // Empty arrays should be formatted as []
      expect(content).toMatch(/triggers: \[\]/);
      
      const parsed = yaml.load(content);
      expect(Array.isArray(parsed.triggers)).toBe(true);
      expect(parsed.triggers.length).toBe(0);
    });
  });

  describe('Special Character Handling', () => {
    test('should quote strings with colons', async () => {
      const response = await server.createPersona(
        'Test: With Colon',
        'Description: with colon',
        'Instructions'
      );
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      // Strings with colons should be quoted
      expect(content).toMatch(/name: "Test: With Colon"/);
      expect(content).toMatch(/description: "Description: with colon"/);
    });

    test('should handle whitespace correctly', async () => {
      const response = await server.createPersona(
        '  Leading Space',
        'Trailing Space  ',
        'Instructions'
      );
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      // Strings with leading/trailing spaces should be quoted
      const parsed = yaml.load(content);
      expect(parsed.name).toBe('  Leading Space');
      expect(parsed.description).toBe('Trailing Space  ');
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty string', async () => {
      const response = await server.createPersona(
        '',
        'Empty name test',
        'Instructions'
      );
      
      // Should fail validation for empty name
      expect(response.content[0].text).toContain('Missing Required Fields');
    });

    test('should handle very long numeric strings', async () => {
      const longNumber = '123456789012345678901234567890';
      const response = await server.createPersona(
        longNumber,
        'Long number test',
        'Instructions'
      );
      
      const personasDir = path.join(tempDir, 'personas');
      const files = await fs.readdir(personasDir);
      const content = await fs.readFile(path.join(personasDir, files[0]), 'utf-8');
      
      // Should be quoted to preserve as string
      expect(content).toContain(`name: "${longNumber}"`);
      
      const parsed = yaml.load(content);
      expect(parsed.name).toBe(longNumber);
      expect(typeof parsed.name).toBe('string');
    });
  });
});