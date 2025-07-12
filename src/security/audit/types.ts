/**
 * Security Audit Types and Interfaces
 * Part of the Security Audit Automation system (Issue #53)
 */

export type SeverityLevel = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface SecurityRule {
  id: string;
  name: string;
  description: string;
  severity: SeverityLevel;
  category: 'code' | 'dependency' | 'configuration' | 'custom';
  pattern?: RegExp;
  check?: (content: string, context?: ScanContext) => SecurityFinding[];
  remediation: string;
  references?: string[];
  tags?: string[];
}

export interface SecurityFinding {
  ruleId: string;
  severity: SeverityLevel;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  code?: string;
  remediation: string;
  confidence: 'low' | 'medium' | 'high';
  falsePositive?: boolean;
}

export interface ScanContext {
  projectRoot: string;
  fileType?: string;
  isTest?: boolean;
  metadata?: Record<string, any>;
}

export interface ScanResult {
  timestamp: Date;
  duration: number;
  scannedFiles: number;
  findings: SecurityFinding[];
  summary: {
    total: number;
    bySeverity: Record<SeverityLevel, number>;
    byCategory: Record<string, number>;
  };
  errors?: string[];
}

export interface SecurityAuditConfig {
  enabled: boolean;
  scanners: {
    code: {
      enabled: boolean;
      rules: string[];
      exclude?: string[];
    };
    dependencies: {
      enabled: boolean;
      severityThreshold: SeverityLevel;
      checkLicenses: boolean;
      allowedLicenses?: string[];
    };
    configuration: {
      enabled: boolean;
      checkFiles: string[];
    };
    custom?: {
      enabled: boolean;
      rules: SecurityRule[];
    };
  };
  reporting: {
    formats: ('console' | 'markdown' | 'json' | 'sarif')[];
    createIssues: boolean;
    commentOnPr: boolean;
    failOnSeverity: SeverityLevel;
  };
  suppressions?: {
    rule: string;
    file?: string;
    reason: string;
  }[];
}

export interface SecurityReport {
  generate(): string | object;
  getSummary(): string;
  getFindings(): SecurityFinding[];
}

export interface SecurityScanner {
  name: string;
  scan(context: ScanContext): Promise<SecurityFinding[]>;
  isEnabled(): boolean;
}