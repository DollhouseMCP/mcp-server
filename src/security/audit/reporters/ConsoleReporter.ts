/**
 * Console Reporter - Outputs security audit results to console
 * Provides colorized, human-readable output for CLI usage
 */

import type { SecurityReport, ScanResult, SecurityFinding, SeverityLevel } from '../types.js';
import chalk from 'chalk';

export class ConsoleReporter implements SecurityReport {
  private result: ScanResult;

  constructor(result: ScanResult) {
    this.result = result;
  }

  /**
   * Generate console output
   */
  generate(): string {
    const output: string[] = [];
    
    // Header
    output.push('');
    output.push(chalk.bold.blue('🔒 Security Audit Report'));
    output.push(chalk.gray('━'.repeat(60)));
    output.push('');
    
    // Summary
    output.push(this.getSummary());
    output.push('');
    
    // Findings by severity
    if (this.result.findings.length > 0) {
      output.push(chalk.bold('📋 Findings:'));
      output.push('');
      
      const findingsBySeverity = this.groupFindingsBySeverity();
      
      for (const [severity, findings] of Object.entries(findingsBySeverity)) {
        if (findings.length > 0) {
          output.push(this.formatSeveritySection(severity as SeverityLevel, findings));
        }
      }
    } else {
      output.push(chalk.green('✅ No security issues found!'));
      output.push('');
    }
    
    // Errors
    if (this.result.errors && this.result.errors.length > 0) {
      output.push(chalk.bold.red('❌ Errors:'));
      for (const error of this.result.errors) {
        output.push(`  • ${error}`);
      }
      output.push('');
    }
    
    // Footer
    output.push(chalk.gray('━'.repeat(60)));
    output.push(chalk.gray(`Scan completed in ${this.result.duration}ms`));
    output.push('');
    
    return output.join('\n');
  }

  /**
   * Get summary section
   */
  getSummary(): string {
    const summary = this.result.summary;
    const output: string[] = [];
    
    output.push(chalk.bold('📊 Summary:'));
    output.push(`  Total findings: ${this.formatCount(summary.total)}`);
    output.push(`  Files scanned: ${this.result.scannedFiles}`);
    output.push('');
    output.push('  By severity:');
    output.push(`    ${this.formatSeverity('critical')}: ${summary.bySeverity.critical}`);
    output.push(`    ${this.formatSeverity('high')}: ${summary.bySeverity.high}`);
    output.push(`    ${this.formatSeverity('medium')}: ${summary.bySeverity.medium}`);
    output.push(`    ${this.formatSeverity('low')}: ${summary.bySeverity.low}`);
    output.push(`    ${this.formatSeverity('info')}: ${summary.bySeverity.info}`);
    
    return output.join('\n');
  }

  /**
   * Get findings array
   */
  getFindings(): SecurityFinding[] {
    return this.result.findings;
  }

  /**
   * Group findings by severity
   */
  private groupFindingsBySeverity(): Record<SeverityLevel, SecurityFinding[]> {
    const grouped: Record<SeverityLevel, SecurityFinding[]> = {
      critical: [],
      high: [],
      medium: [],
      low: [],
      info: []
    };
    
    for (const finding of this.result.findings) {
      grouped[finding.severity].push(finding);
    }
    
    return grouped;
  }

  /**
   * Format a severity section
   */
  private formatSeveritySection(severity: SeverityLevel, findings: SecurityFinding[]): string {
    const output: string[] = [];
    const severityLabel = this.formatSeverity(severity);
    
    output.push(`${severityLabel} (${findings.length})`);
    output.push('');
    
    for (const finding of findings) {
      output.push(this.formatFinding(finding));
      output.push('');
    }
    
    return output.join('\n');
  }

  /**
   * Format individual finding
   */
  private formatFinding(finding: SecurityFinding): string {
    const output: string[] = [];
    const icon = this.getSeverityIcon(finding.severity);
    
    output.push(`  ${icon} ${chalk.bold(finding.message)}`);
    
    if (finding.file) {
      const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
      output.push(`     📁 ${chalk.cyan(location)}`);
    }
    
    if (finding.code) {
      output.push(`     📝 ${chalk.gray(finding.code)}`);
    }
    
    output.push(`     💡 ${chalk.yellow(finding.remediation)}`);
    output.push(`     🏷️  ${chalk.gray(finding.ruleId)} (${finding.confidence} confidence)`);
    
    return output.join('\n');
  }

  /**
   * Format severity label with color
   */
  private formatSeverity(severity: SeverityLevel): string {
    switch (severity) {
      case 'critical':
        return chalk.bgRed.white(' CRITICAL ');
      case 'high':
        return chalk.red('HIGH');
      case 'medium':
        return chalk.yellow('MEDIUM');
      case 'low':
        return chalk.blue('LOW');
      case 'info':
        return chalk.gray('INFO');
    }
  }

  /**
   * Get icon for severity
   */
  private getSeverityIcon(severity: SeverityLevel): string {
    switch (severity) {
      case 'critical':
        return '🔴';
      case 'high':
        return '🟠';
      case 'medium':
        return '🟡';
      case 'low':
        return '🔵';
      case 'info':
        return '⚪';
    }
  }

  /**
   * Format count with color
   */
  private formatCount(count: number): string {
    if (count === 0) {
      return chalk.green(count.toString());
    } else if (count < 10) {
      return chalk.yellow(count.toString());
    } else {
      return chalk.red(count.toString());
    }
  }
}