/**
 * Markdown Reporter - Generates markdown reports for GitHub
 * Placeholder implementation - to be completed
 */

import type { SecurityReport, ScanResult, SecurityFinding } from '../types.js';

export class MarkdownReporter implements SecurityReport {
  private result: ScanResult;

  constructor(result: ScanResult) {
    this.result = result;
  }

  generate(): string {
    // TODO: Implement markdown report generation
    return `# Security Audit Report\n\nTotal findings: ${this.result.findings.length}`;
  }

  getSummary(): string {
    return `Found ${this.result.findings.length} security issues`;
  }

  getFindings(): SecurityFinding[] {
    return this.result.findings;
  }
}