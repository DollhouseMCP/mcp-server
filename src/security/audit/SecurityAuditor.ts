/**
 * Security Auditor - Core orchestrator for security scanning
 * Implements automated security auditing for DollhouseMCP (Issue #53)
 */

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
import { ErrorHandler } from '../../utils/ErrorHandler.js';
import * as path from 'node:path';
import type { IFileOperationsService } from '../../services/FileOperationsService.js';

function logLevelForSeverity(severity: SeverityLevel): 'error' | 'warn' | 'info' {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'medium') return 'warn';
  return 'info';
}

interface SuppressionDecision {
  suppressed: boolean;
  reason?: string;
}

interface SuppressedFinding {
  rule: string;
  file?: string;
  reason?: string;
}

export class SecurityAuditor {
  private readonly config: SecurityAuditConfig;
  private readonly scanners: SecurityScanner[] = [];
  private readonly suppressions: Map<string, Set<string>> = new Map();
  private readonly fileOperations: IFileOperationsService;
  private logListener?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;

  addLogListener(fn: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void): void {
    this.logListener = fn;
  }

  constructor(config: SecurityAuditConfig, fileOperations: IFileOperationsService) {
    this.config = config;
    this.fileOperations = fileOperations;
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
      let suppressedRules = this.suppressions.get(key);
      if (!suppressedRules) {
        suppressedRules = new Set();
        this.suppressions.set(key, suppressedRules);
      }
      suppressedRules.add(suppression.rule);
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
    this.logListener?.('info', 'Start security audit', { projectRoot });

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

    // Notify listener per finding
    for (const finding of allFindings) {
      const findingLevel = logLevelForSeverity(finding.severity);
      this.logListener?.(findingLevel, finding.message, {
        ruleId: finding.ruleId,
        severity: finding.severity,
        file: finding.file,
        line: finding.line,
      });
    }
    this.logListener?.('info', 'Complete security audit', {
      total: result.summary.total,
      duration,
      bySeverity: result.summary.bySeverity,
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
    const suppressedFindings: SuppressedFinding[] = [];
    const filtered = findings.filter(finding =>
      this.shouldRetainFinding(finding, suppressedFindings)
    );
    
    // Log suppression summary if verbose and suppressions were applied
    if (this.config.reporting.verbose && suppressedFindings.length > 0) {
      logger.debug(`SecurityAuditor: Suppressed ${suppressedFindings.length} findings:`);
      suppressedFindings.forEach(s => {
        const reasonSuffix = s.reason ? ` (${s.reason})` : '';
        logger.debug(`  - ${s.rule} in ${s.file || 'global'}${reasonSuffix}`);
      });
    }
    
    return filtered;
  }

  private shouldRetainFinding(
    finding: SecurityFinding,
    suppressedFindings: SuppressedFinding[]
  ): boolean {
    try {
      const decision = this.getSuppressionDecision(finding);
      if (!decision.suppressed) return true;

      if (this.config.reporting.verbose) {
        suppressedFindings.push({
          rule: finding.ruleId,
          file: finding.file,
          reason: decision.reason
        });
      }
      return false;
    } catch (error) {
      // If suppression check fails, log error but don't suppress the finding
      ErrorHandler.logError('SecurityAuditor.applySuppression', error, {
        ruleId: finding.ruleId,
        file: finding.file
      });
      return true;
    }
  }

  private getSuppressionDecision(finding: SecurityFinding): SuppressionDecision {
    // Check comprehensive suppressions (includes both file-based and pattern-based)
    if (shouldSuppress(finding.ruleId, finding.file)) {
      return { suppressed: true };
    }

    // Check legacy config-based suppressions if they exist. This maintains backward compatibility.
    if (!this.config.suppressions?.length) return { suppressed: false };

    const globalSuppressions = this.suppressions.get('*');
    if (globalSuppressions?.has(finding.ruleId)) {
      return { suppressed: true, reason: 'Config-based global suppression' };
    }

    if (!finding.file) return { suppressed: false };
    const fileSuppressions = this.suppressions.get(finding.file);
    const suppressedForFile = fileSuppressions?.has(finding.ruleId)
      || this.matchesConfiguredSuppression(finding);
    return suppressedForFile
      ? { suppressed: true, reason: 'Config-based file suppression' }
      : { suppressed: false };
  }

  private matchesConfiguredSuppression(finding: SecurityFinding): boolean {
    if (!finding.file || !this.config.suppressions?.length) return false;
    const findingFile = finding.file;

    return this.config.suppressions.some(suppression => {
      if (suppression.rule !== '*' && suppression.rule !== finding.ruleId) return false;
      if (!suppression.file) return true;
      return configuredSuppressionFileMatches(suppression.file, findingFile);
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
          case 'console': {
            const consoleReporter = new ConsoleReporter(result);
            // Console reporter output is meant to be shown directly to user
            // Using console.log here is intentional for formatting
            console.log(consoleReporter.generate());
            break;
          }

          case 'markdown': {
            const markdownReporter = new MarkdownReporter(result);
            const mdReport = markdownReporter.generate();
            await this.fileOperations.writeFile('security-audit-report.md', mdReport, {
              source: 'SecurityAuditor.generateReports'
            });
            break;
          }

          case 'json': {
            const jsonReporter = new JsonReporter(result);
            const jsonReport = JSON.stringify(jsonReporter.generate(), null, 2);
            await this.fileOperations.writeFile('security-audit-report.json', jsonReport, {
              source: 'SecurityAuditor.generateReports'
            });
            break;
          }

          case 'sarif':
            // Reserved configuration value; no reporter exists yet.
            break;
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
  static async getDefaultConfig(fileOperations: IFileOperationsService): Promise<SecurityAuditConfig> {
    // Load suppressions from file if it exists
    let customSuppressions: any[] = [];
    const ops = fileOperations;

    try {
      const projectRoot = process.cwd();
      const suppressionsPath = path.join(projectRoot, 'src', 'security', 'audit', 'config', 'security-suppressions.json');

      if (await ops.exists(suppressionsPath)) {
        const suppressionsContent = await ops.readFile(suppressionsPath, {
          source: 'SecurityAuditor.getDefaultConfig'
        });
        const suppressionsData = JSON.parse(suppressionsContent);
        // Convert relative paths to patterns for matching
        customSuppressions = (suppressionsData.suppressions || []).map((s: any) => ({
          ...s,
          // Convert file path to a pattern that works with minimatch
          file: s.file?.includes('/') ? `**/${s.file}` : s.file
        }));
      }
    } catch {
      // Suppressions file doesn't exist or is invalid - that's OK
    }

    return {
      enabled: true,
      scanners: {
        code: {
          enabled: true,
          rules: ['OWASP-Top-10', 'CWE-Top-25', 'DollhouseMCP-Security'],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/coverage/**',
            'src/web-console/ui/vendor/purify.min.js',
            'src/web-console/ui/vendor/marked.min.js',
            'src/web-console/ui/vendor/js-yaml.min.js'
          ]
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

function configuredSuppressionFileMatches(pattern: string, filePath: string): boolean {
  const normalizedPattern = normalizeAuditPath(pattern);
  const normalizedFile = normalizeAuditPath(filePath);
  const relativeFile = toProjectRelativeAuditPath(normalizedFile);
  const candidates = new Set([normalizedFile, relativeFile]);

  for (const candidate of candidates) {
    if (candidate === normalizedPattern) return true;
    if (normalizedPattern.includes('*') && globPatternToRegex(normalizedPattern).test(candidate)) {
      return true;
    }
  }
  return false;
}

function normalizeAuditPath(value: string): string {
  return value.replaceAll('\\', '/').replaceAll(/\/+/g, '/').replace(/\/$/, '');
}

function toProjectRelativeAuditPath(filePath: string): string {
  if (!path.isAbsolute(filePath)) return filePath;
  const relative = normalizeAuditPath(path.relative(process.cwd(), filePath));
  return relative.startsWith('..') ? filePath : relative;
}

function globPatternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replaceAll(/[\\^$.()+?{}[\]|]/g, String.raw`\$&`)
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('\0/', '(?:.*/)?')
    .replaceAll('\0', '.*');
  return new RegExp(`^${escaped}$`);
}
