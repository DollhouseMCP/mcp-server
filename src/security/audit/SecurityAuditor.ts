/**
 * Security Auditor - Core orchestrator for security scanning
 * Implements automated security auditing for DollhouseMCP (Issue #53)
 */

import { SecurityMonitor } from '../securityMonitor.js';
import type { 
  SecurityAuditConfig, 
  ScanContext, 
  ScanResult, 
  SecurityFinding, 
  SecurityScanner,
  SeverityLevel 
} from './types.js';
import { CodeScanner } from './scanners/CodeScanner.js';
import { DependencyScanner } from './scanners/DependencyScanner.js';
import { ConfigurationScanner } from './scanners/ConfigurationScanner.js';
import { ConsoleReporter } from './reporters/ConsoleReporter.js';
import { MarkdownReporter } from './reporters/MarkdownReporter.js';
import { JsonReporter } from './reporters/JsonReporter.js';
import path from 'path';
import fs from 'fs/promises';

export class SecurityAuditor {
  private config: SecurityAuditConfig;
  private scanners: SecurityScanner[] = [];
  private suppressions: Map<string, Set<string>> = new Map();

  constructor(config: SecurityAuditConfig) {
    this.config = config;
    this.initializeScanners();
    this.loadSuppressions();
  }

  /**
   * Initialize enabled scanners based on configuration
   */
  private initializeScanners(): void {
    if (this.config.scanners.code.enabled) {
      this.scanners.push(new CodeScanner(this.config.scanners.code));
    }
    
    if (this.config.scanners.dependencies.enabled) {
      this.scanners.push(new DependencyScanner(this.config.scanners.dependencies));
    }
    
    if (this.config.scanners.configuration.enabled) {
      this.scanners.push(new ConfigurationScanner(this.config.scanners.configuration));
    }

    SecurityMonitor.logSecurityEvent({
      type: 'SECURITY_AUDIT_INITIALIZED',
      severity: 'INFO',
      source: 'security_auditor',
      details: `Initialized ${this.scanners.length} security scanners`
    });
  }

  /**
   * Load suppression rules from configuration
   */
  private loadSuppressions(): void {
    if (!this.config.suppressions) return;

    for (const suppression of this.config.suppressions) {
      const key = suppression.file || '*';
      if (!this.suppressions.has(key)) {
        this.suppressions.set(key, new Set());
      }
      this.suppressions.get(key)!.add(suppression.rule);
    }
  }

  /**
   * Run security audit on the project
   */
  async audit(projectRoot: string = process.cwd()): Promise<ScanResult> {
    const startTime = Date.now();
    const context: ScanContext = { projectRoot };
    const allFindings: SecurityFinding[] = [];
    const errors: string[] = [];
    const scannedFilesSet = new Set<string>();

    SecurityMonitor.logSecurityEvent({
      type: 'SECURITY_AUDIT_STARTED',
      severity: 'INFO',
      source: 'security_auditor',
      details: `Starting security audit of ${projectRoot}`
    });

    // Run all enabled scanners
    for (const scanner of this.scanners) {
      try {
        const findings = await scanner.scan(context);
        const filteredFindings = this.filterSuppressions(findings);
        allFindings.push(...filteredFindings);
        // Track unique files that were scanned
        for (const finding of findings) {
          if (finding.file) {
            scannedFilesSet.add(finding.file);
          }
        }
      } catch (error) {
        const errorMessage = `Scanner ${scanner.name} failed: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(errorMessage);
        SecurityMonitor.logSecurityEvent({
          type: 'SECURITY_AUDIT_ERROR',
          severity: 'MEDIUM',
          source: 'security_auditor',
          details: errorMessage
        });
      }
    }

    const duration = Date.now() - startTime;
    const result = this.createScanResult(allFindings, duration, scannedFilesSet.size, errors);

    // Log audit completion
    SecurityMonitor.logSecurityEvent({
      type: 'SECURITY_AUDIT_COMPLETED',
      severity: result.summary.critical > 0 ? 'CRITICAL' : 'INFO',
      source: 'security_auditor',
      details: `Audit completed: ${result.summary.total} findings in ${duration}ms`
    });

    // Generate reports
    await this.generateReports(result);

    // Check if build should fail
    if (this.shouldFailBuild(result)) {
      throw new Error(`Security audit failed: ${result.summary.bySeverity.critical} critical, ${result.summary.bySeverity.high} high severity issues found`);
    }

    return result;
  }

  /**
   * Filter out suppressed findings
   */
  private filterSuppressions(findings: SecurityFinding[]): SecurityFinding[] {
    return findings.filter(finding => {
      // Check global suppressions
      const globalSuppressions = this.suppressions.get('*');
      if (globalSuppressions?.has(finding.ruleId)) {
        return false;
      }

      // Check file-specific suppressions
      if (finding.file) {
        const fileSuppressions = this.suppressions.get(finding.file);
        if (fileSuppressions?.has(finding.ruleId)) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Create scan result summary
   */
  private createScanResult(
    findings: SecurityFinding[], 
    duration: number, 
    scannedFiles: number,
    errors: string[]
  ): ScanResult {
    const bySeverity: Record<SeverityLevel, number> = {
      info: 0,
      low: 0,
      medium: 0,
      high: 0,
      critical: 0
    };

    const byCategory: Record<string, number> = {};

    for (const finding of findings) {
      bySeverity[finding.severity]++;
      
      // Extract category from ruleId (e.g., SEC-CODE-001 -> CODE)
      const category = finding.ruleId.split('-')[1] || 'OTHER';
      byCategory[category] = (byCategory[category] || 0) + 1;
    }

    return {
      timestamp: new Date(),
      duration,
      scannedFiles,
      findings,
      summary: {
        total: findings.length,
        bySeverity,
        byCategory
      },
      errors: errors.length > 0 ? errors : undefined
    };
  }

  /**
   * Generate reports in configured formats
   */
  private async generateReports(result: ScanResult): Promise<void> {
    for (const format of this.config.reporting.formats) {
      try {
        switch (format) {
          case 'console':
            const consoleReporter = new ConsoleReporter(result);
            console.log(consoleReporter.generate());
            break;
            
          case 'markdown':
            const markdownReporter = new MarkdownReporter(result);
            const mdReport = markdownReporter.generate() as string;
            await fs.writeFile('security-audit-report.md', mdReport);
            break;
            
          case 'json':
            const jsonReporter = new JsonReporter(result);
            const jsonReport = JSON.stringify(jsonReporter.generate(), null, 2);
            await fs.writeFile('security-audit-report.json', jsonReport);
            break;
            
          // SARIF format would be implemented similarly
        }
      } catch (error) {
        SecurityMonitor.logSecurityEvent({
          type: 'SECURITY_AUDIT_ERROR',
          severity: 'LOW',
          source: 'security_auditor',
          details: `Failed to generate ${format} report: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  }

  /**
   * Determine if the build should fail based on findings
   */
  private shouldFailBuild(result: ScanResult): boolean {
    const thresholds: Record<SeverityLevel, number> = {
      info: 5,
      low: 4,
      medium: 3,
      high: 2,
      critical: 1
    };

    const failThreshold = thresholds[this.config.reporting.failOnSeverity];
    
    for (const [severity, count] of Object.entries(result.summary.bySeverity)) {
      if (count > 0 && thresholds[severity as SeverityLevel] <= failThreshold) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get default configuration
   */
  static getDefaultConfig(): SecurityAuditConfig {
    return {
      enabled: true,
      scanners: {
        code: {
          enabled: true,
          rules: ['OWASP-Top-10', 'CWE-Top-25', 'DollhouseMCP-Security'],
          exclude: ['node_modules/**', 'dist/**', 'coverage/**']
        },
        dependencies: {
          enabled: true,
          severityThreshold: 'high',
          checkLicenses: true,
          allowedLicenses: ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'AGPL-3.0']
        },
        configuration: {
          enabled: true,
          checkFiles: ['*.yml', '*.yaml', '*.json', '.env.example']
        }
      },
      reporting: {
        formats: ['console', 'markdown'],
        createIssues: true,
        commentOnPr: true,
        failOnSeverity: 'high'
      },
      suppressions: [
        {
          rule: 'SEC-TEST-001',
          file: '__tests__/**/*',
          reason: 'Test files may contain security test patterns'
        }
      ]
    };
  }
}