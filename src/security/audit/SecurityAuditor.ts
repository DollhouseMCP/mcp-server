/**
 * Security Auditor - Core orchestrator for security scanning
 * Implements automated security auditing for DollhouseMCP (Issue #53)
 */

// import { SecurityMonitor } from '../securityMonitor.js';
import { logger } from '../../utils/logger.js';
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
import { shouldSuppress } from './config/suppressions.js';
import { ErrorHandler, ErrorCategory } from '../../utils/ErrorHandler.js';
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

    // Audit logging would go here if SecurityMonitor supported audit events
    logger.info(`SecurityAuditor: Initialized ${this.scanners.length} security scanners`);
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

    logger.info(`SecurityAuditor: Starting security audit of ${projectRoot}`);

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
        ErrorHandler.logError('SecurityAuditor.auditProject', error, { projectRoot });
      }
    }

    const duration = Date.now() - startTime;
    const result = this.createScanResult(allFindings, duration, scannedFilesSet.size, errors);

    // Log audit completion
    logger.info(`SecurityAuditor: Audit completed: ${result.summary.total} findings in ${duration}ms`);

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
    const suppressedFindings: Array<{rule: string; file?: string; reason?: string}> = [];
    
    const filtered = findings.filter(finding => {
      try {
        // Check comprehensive suppressions (includes both file-based and pattern-based)
        if (shouldSuppress(finding.ruleId, finding.file)) {
          // Log suppression for audit trail if verbose mode is enabled
          if (this.config.reporting?.verbose) {
            suppressedFindings.push({
              rule: finding.ruleId,
              file: finding.file
            });
          }
          return false;
        }
        
        // Check legacy config-based suppressions if they exist
        // This maintains backward compatibility with existing configs
        if (this.config.suppressions && this.config.suppressions.length > 0) {
          const globalSuppressions = this.suppressions.get('*');
          if (globalSuppressions?.has(finding.ruleId)) {
            if (this.config.reporting?.verbose) {
              suppressedFindings.push({
                rule: finding.ruleId,
                file: finding.file,
                reason: 'Config-based global suppression'
              });
            }
            return false;
          }

          if (finding.file) {
            const fileSuppressions = this.suppressions.get(finding.file);
            if (fileSuppressions?.has(finding.ruleId)) {
              if (this.config.reporting?.verbose) {
                suppressedFindings.push({
                  rule: finding.ruleId,
                  file: finding.file,
                  reason: 'Config-based file suppression'
                });
              }
              return false;
            }
          }
        }

        return true;
      } catch (error) {
        // If suppression check fails, log error but don't suppress the finding
        ErrorHandler.logError('SecurityAuditor.applySuppression', error, { 
          ruleId: finding.ruleId, 
          file: finding.file 
        });
        return true;
      }
    });
    
    // Log suppression summary if verbose and suppressions were applied
    if (this.config.reporting?.verbose && suppressedFindings.length > 0) {
      logger.debug(`SecurityAuditor: Suppressed ${suppressedFindings.length} findings:`);
      suppressedFindings.forEach(s => {
        logger.debug(`  - ${s.rule} in ${s.file || 'global'}${s.reason ? ` (${s.reason})` : ''}`);
      });
    }
    
    return filtered;
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
            // Console reporter output is meant to be shown directly to user
            // Using console.log here is intentional for formatting
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
        ErrorHandler.logError('SecurityAuditor.generateReports', error, { format });
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
    // Load suppressions from file if it exists
    let customSuppressions: any[] = [];
    try {
      const fs = require('fs');
      const path = require('path');
      const projectRoot = process.cwd();
      const suppressionsPath = path.join(projectRoot, 'src', 'security', 'audit', 'config', 'security-suppressions.json');

      if (fs.existsSync(suppressionsPath)) {
        const suppressionsContent = fs.readFileSync(suppressionsPath, 'utf-8');
        const suppressionsData = JSON.parse(suppressionsContent);
        // Convert relative paths to patterns for matching
        customSuppressions = (suppressionsData.suppressions || []).map((s: any) => ({
          ...s,
          // Convert file path to a pattern that works with minimatch
          file: s.file?.includes('/') ? `**/${s.file}` : s.file
        }));
      }
    } catch (error) {
      // Suppressions file doesn't exist or is invalid - that's OK
    }

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
        },
        ...customSuppressions
      ]
    };
  }
}