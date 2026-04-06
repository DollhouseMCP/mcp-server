/**
 * OSV Scanner Configuration Validation Tests
 *
 * Validates that osv-scanner.toml is well-formed and all entries
 * follow the expected structure. Catches manual edit mistakes before
 * they silently break OpenSSF Scorecard triage.
 */

import { describe, expect, it, beforeAll } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';

const OSV_SCANNER_PATH = path.join(process.cwd(), 'osv-scanner.toml');

describe('OSV Scanner Configuration', () => {
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(OSV_SCANNER_PATH, 'utf-8');
  });

  it('should exist at the repo root', () => {
    expect(fs.existsSync(OSV_SCANNER_PATH)).toBe(true);
  });

  it('should be valid TOML with only [[IgnoredVulns]] blocks', () => {
    // Every non-comment, non-blank line should be either a section header or a key = value
    const lines = content.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));

    for (const line of lines) {
      const trimmed = line.trim();
      const isSection = trimmed === '[[IgnoredVulns]]';
      const isKeyValue = /^(id|reason)\s*=\s*".*"$/.test(trimmed);
      expect(isSection || isKeyValue).toBe(true);
    }
  });

  it('should have valid GHSA ID format for every entry', () => {
    const idMatches = content.match(/^id\s*=\s*"(.+)"/gm) || [];
    expect(idMatches.length).toBeGreaterThan(0);

    for (const match of idMatches) {
      const id = match.replace(/^id\s*=\s*"/, '').replace(/"$/, '');
      expect(id).toMatch(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
    }
  });

  it('should have a reason for every GHSA entry', () => {
    const ids = (content.match(/^id\s*=\s*"/gm) || []).length;
    const reasons = (content.match(/^reason\s*=\s*"/gm) || []).length;
    expect(ids).toBe(reasons);
  });

  it('should have each [[IgnoredVulns]] block contain exactly one id and one reason', () => {
    // Split by section headers and validate each block
    const blocks = content.split('[[IgnoredVulns]]').slice(1); // skip header
    expect(blocks.length).toBeGreaterThan(0);

    for (const block of blocks) {
      const lines = block.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
      const idLines = lines.filter(l => l.trim().startsWith('id'));
      const reasonLines = lines.filter(l => l.trim().startsWith('reason'));

      expect(idLines).toHaveLength(1);
      expect(reasonLines).toHaveLength(1);
    }
  });

  it('should have no duplicate GHSA IDs', () => {
    const idMatches = content.match(/^id\s*=\s*"(.+)"/gm) || [];
    const ids = idMatches.map(m => m.replace(/^id\s*=\s*"/, '').replace(/"$/, ''));
    const unique = new Set(ids);
    expect(ids.length).toBe(unique.size);
  });

  it('should have a header with analysis date and issue reference', () => {
    expect(content).toContain('Analysis date:');
    expect(content).toContain('Related issue:');
    expect(content).toContain('issues/1800');
  });
});
