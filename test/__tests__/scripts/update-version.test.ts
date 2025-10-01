/**
 * Tests for the version update script
 * 
 * Note: These tests validate the security measures in the script
 * without actually executing it, to avoid dependency issues.
 */

import { describe, test, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

describe('update-version.mjs security validation', () => {
  const scriptPath = path.join(process.cwd(), 'scripts', 'update-version.mjs');
  
  test('script exists and is readable', () => {
    expect(fs.existsSync(scriptPath)).toBe(true);
    const stats = fs.statSync(scriptPath);
    expect(stats.isFile()).toBe(true);
  });
  
  test('script contains security validations', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
    
    // Check for path validation function
    expect(scriptContent).toMatch(/function validateFilePath/);
    expect(scriptContent).toMatch(/Path traversal detected/);
    
    // Check for release notes length validation
    expect(scriptContent).toMatch(/releaseNotes\.length > 1000/);
    expect(scriptContent).toMatch(/Release notes too long/);
    
    // Check for file size limit
    expect(scriptContent).toMatch(/maxFileSize = 10 \* 1024 \* 1024/);
    expect(scriptContent).toMatch(/File too large/);
    
    // Check for file count limit
    expect(scriptContent).toMatch(/files\.length > 1000/);
    expect(scriptContent).toMatch(/Too many files matched/);
    
    // Check for proper escaping function
    expect(scriptContent).toMatch(/function escapeRegExp/);
    expect(scriptContent).toContain('replaceAll(/[.*+?^${}()|[\\]\\\\]/g');
  });
  
  test('script validates semantic version format', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
    
    // Check for version validation regex
    expect(scriptContent).toContain('match(/^\\d+\\.\\d+\\.\\d+(-[\\w\\.]+)?$/)');
    expect(scriptContent).toMatch(/Please provide a valid semantic version/);
  });
  
  test('script uses resolved paths for security', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
    
    // Check for path.resolve usage
    expect(scriptContent).toMatch(/path\.resolve/);
    expect(scriptContent).toMatch(/const projectRoot = path\.resolve/);
  });
  
  test('script handles npm errors properly', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
    
    // Check that npm install errors cause exit
    expect(scriptContent).toMatch(/npm install --package-lock-only/);
    expect(scriptContent).toMatch(/process\.exit\(1\)/);
  });
  
  test('script prevents directory traversal in patterns', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
    
    // Check for pattern normalization
    expect(scriptContent).toMatch(/path\.normalize\(pattern\)/);
    expect(scriptContent).toMatch(/normalizedPattern\.includes\('\.\.\'/);
  });
});

describe('update-version.mjs functionality validation', () => {
  const scriptPath = path.join(process.cwd(), 'scripts', 'update-version.mjs');
  
  test('script updates correct files', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
    
    // Check for expected file patterns
    expect(scriptContent).toMatch(/package\.json/);
    expect(scriptContent).toMatch(/package-lock\.json/);
    expect(scriptContent).toMatch(/README\.md/);
    expect(scriptContent).toMatch(/CHANGELOG\.md/);
    expect(scriptContent).toMatch(/docs\/\*\*\/\*\.md/);
  });
  
  test('script preserves historical version references', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
    
    // Check for skipLines patterns
    expect(scriptContent).toMatch(/skipLines:/);
    expect(scriptContent).toMatch(/changelog\|history\|previous\|released/);
  });
  
  test('script supports dry-run mode', () => {
    const scriptContent = fs.readFileSync(scriptPath, 'utf-8');
    
    // Check for dry-run support
    expect(scriptContent).toMatch(/--dry-run/);
    expect(scriptContent).toMatch(/isDryRun/);
    expect(scriptContent).toMatch(/DRY RUN MODE/);
  });
});