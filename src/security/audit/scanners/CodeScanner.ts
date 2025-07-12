/**
 * Code Scanner - Static code analysis for security vulnerabilities
 * Detects common security issues in source code
 */

import type { SecurityScanner, SecurityFinding, ScanContext, SecurityRule } from '../types.js';
import { SecurityRules } from '../rules/SecurityRules.js';
import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';

interface CodeScannerConfig {
  enabled: boolean;
  rules: string[];
  exclude?: string[];
}

export class CodeScanner implements SecurityScanner {
  name = 'CodeScanner';
  private config: CodeScannerConfig;
  private rules: SecurityRule[] = [];

  constructor(config: CodeScannerConfig) {
    this.config = config;
    this.loadRules();
  }

  /**
   * Load security rules based on configuration
   */
  private loadRules(): void {
    const ruleLoader = new SecurityRules();
    
    for (const ruleSet of this.config.rules) {
      switch (ruleSet) {
        case 'OWASP-Top-10':
          this.rules.push(...ruleLoader.getOWASPRules());
          break;
        case 'CWE-Top-25':
          this.rules.push(...ruleLoader.getCWERules());
          break;
        case 'DollhouseMCP-Security':
          this.rules.push(...ruleLoader.getDollhouseMCPRules());
          break;
        default:
          // Custom rule sets can be added here
          break;
      }
    }
  }

  /**
   * Scan files for security vulnerabilities
   */
  async scan(context: ScanContext): Promise<SecurityFinding[]> {
    const findings: SecurityFinding[] = [];
    const files = await this.getFilesToScan(context.projectRoot);

    for (const file of files) {
      try {
        const content = await fs.readFile(file, 'utf-8');
        const fileFindings = await this.scanFile(file, content, context);
        findings.push(...fileFindings);
      } catch (error) {
        // Skip files that can't be read
        continue;
      }
    }

    return findings;
  }

  /**
   * Get list of files to scan
   */
  private async getFilesToScan(projectRoot: string): Promise<string[]> {
    const patterns = ['**/*.ts', '**/*.js', '**/*.jsx', '**/*.tsx', '**/*.json', '**/*.yml', '**/*.yaml'];
    const ignore = this.config.exclude || ['node_modules/**', 'dist/**', 'coverage/**'];
    
    const files: string[] = [];
    for (const pattern of patterns) {
      const matches = await glob(pattern, {
        cwd: projectRoot,
        ignore,
        absolute: true
      });
      files.push(...matches);
    }
    
    return files;
  }

  /**
   * Scan a single file for vulnerabilities
   */
  private async scanFile(
    filePath: string, 
    content: string, 
    context: ScanContext
  ): Promise<SecurityFinding[]> {
    const findings: SecurityFinding[] = [];
    const lines = content.split('\n');
    const fileContext = {
      ...context,
      fileType: path.extname(filePath),
      isTest: filePath.includes('test') || filePath.includes('spec')
    };

    for (const rule of this.rules) {
      // Skip test-specific rules in non-test files
      if (rule.tags?.includes('test-only') && !fileContext.isTest) {
        continue;
      }

      // Pattern-based detection
      if (rule.pattern) {
        const matches = this.findPatternMatches(content, lines, rule);
        for (const match of matches) {
          findings.push({
            ruleId: rule.id,
            severity: rule.severity,
            message: `${rule.name}: ${match.message}`,
            file: filePath,
            line: match.line,
            column: match.column,
            code: match.code,
            remediation: rule.remediation,
            confidence: this.calculateConfidence(match, rule, fileContext)
          });
        }
      }

      // Custom check function
      if (rule.check) {
        const customFindings = rule.check(content, fileContext);
        findings.push(...customFindings.map(f => ({
          ...f,
          file: filePath
        })));
      }
    }

    return findings;
  }

  /**
   * Find pattern matches in content
   */
  private findPatternMatches(
    content: string, 
    lines: string[], 
    rule: SecurityRule
  ): Array<{line: number; column: number; code: string; message: string}> {
    const matches: Array<{line: number; column: number; code: string; message: string}> = [];
    
    if (!rule.pattern) return matches;

    // Reset regex state
    rule.pattern.lastIndex = 0;
    
    let match;
    while ((match = rule.pattern.exec(content)) !== null) {
      const position = this.getLineAndColumn(content, match.index);
      const code = lines[position.line - 1]?.trim() || '';
      
      matches.push({
        line: position.line,
        column: position.column,
        code: code.substring(0, 100), // Limit code snippet length
        message: rule.description
      });
    }

    return matches;
  }

  /**
   * Convert string index to line and column
   */
  private getLineAndColumn(content: string, index: number): {line: number; column: number} {
    const lines = content.substring(0, index).split('\n');
    return {
      line: lines.length,
      column: lines[lines.length - 1].length + 1
    };
  }

  /**
   * Calculate confidence level for a finding
   */
  private calculateConfidence(
    match: any, 
    rule: SecurityRule, 
    context: ScanContext
  ): 'low' | 'medium' | 'high' {
    // High confidence for exact pattern matches
    if (rule.tags?.includes('high-confidence')) {
      return 'high';
    }

    // Low confidence in test files
    if (context.isTest) {
      return 'low';
    }

    // Check for common false positive indicators
    const code = match.code.toLowerCase();
    if (code.includes('example') || code.includes('test') || code.includes('demo')) {
      return 'low';
    }

    return 'medium';
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }
}