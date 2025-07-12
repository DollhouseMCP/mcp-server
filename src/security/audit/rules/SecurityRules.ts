/**
 * Security Rules - Defines security patterns and checks
 * Based on OWASP Top 10, CWE Top 25, and DollhouseMCP-specific security requirements
 */

import type { SecurityRule } from '../types.js';

export class SecurityRules {
  /**
   * OWASP Top 10 security rules
   */
  getOWASPRules(): SecurityRule[] {
    return [
      {
        id: 'OWASP-A01-001',
        name: 'Hardcoded Secrets',
        description: 'Potential hardcoded secret or API key detected',
        severity: 'critical',
        category: 'code',
        pattern: /(?:api[_-]?key|secret|password|token|private[_-]?key)\s*[:=]\s*["'][a-zA-Z0-9+/=]{16,}["']/gi,
        remediation: 'Use environment variables or secure key management services instead of hardcoding secrets',
        references: ['https://owasp.org/Top10/A01_2021-Broken_Access_Control/'],
        tags: ['high-confidence']
      },
      {
        id: 'OWASP-A03-001',
        name: 'SQL Injection',
        description: 'Potential SQL injection vulnerability',
        severity: 'critical',
        category: 'code',
        pattern: /(?:query|execute)\s*\(\s*['"`].*\$\{[^}]+\}.*['"`]|['"`].*\+\s*[a-zA-Z_]\w*\s*\+.*['"`]\s*\)/g,
        remediation: 'Use parameterized queries or prepared statements',
        references: ['https://owasp.org/Top10/A03_2021-Injection/']
      },
      {
        id: 'OWASP-A03-002',
        name: 'Command Injection',
        description: 'Potential command injection vulnerability',
        severity: 'critical',
        category: 'code',
        pattern: /(?:exec|spawn|execSync|spawnSync)\s*\([^)]*\$\{[^}]+\}|(?:exec|spawn|execSync|spawnSync)\s*\([^)]*\+\s*[a-zA-Z_]\w*/g,
        remediation: 'Validate and sanitize all user input before using in system commands',
        references: ['https://owasp.org/Top10/A03_2021-Injection/']
      },
      {
        id: 'OWASP-A03-003',
        name: 'Path Traversal',
        description: 'Potential path traversal vulnerability',
        severity: 'high',
        category: 'code',
        pattern: /(?:readFile|writeFile|readdir|mkdir|rm|unlink).*\$\{[^}]+\}|\.\.\/|\.\.\\/g,
        remediation: 'Validate and sanitize file paths, use path.resolve() and check against allowed directories',
        references: ['https://owasp.org/Top10/A03_2021-Injection/']
      },
      {
        id: 'OWASP-A03-004',
        name: 'XSS - Direct HTML Injection',
        description: 'Potential XSS vulnerability through direct HTML injection',
        severity: 'high',
        category: 'code',
        pattern: /innerHTML\s*=\s*[^'"`]*\$\{|dangerouslySetInnerHTML/g,
        remediation: 'Use textContent or proper HTML escaping functions',
        references: ['https://owasp.org/Top10/A03_2021-Injection/']
      },
      {
        id: 'OWASP-A05-001',
        name: 'Insecure Configuration',
        description: 'Security-sensitive configuration detected',
        severity: 'medium',
        category: 'code',
        pattern: /(?:NODE_TLS_REJECT_UNAUTHORIZED|strictSSL|rejectUnauthorized)\s*[:=]\s*(?:false|0|["']false["']|["']0["'])/gi,
        remediation: 'Enable SSL/TLS certificate validation in production',
        references: ['https://owasp.org/Top10/A05_2021-Security_Misconfiguration/']
      },
      {
        id: 'OWASP-A07-001',
        name: 'Weak Authentication',
        description: 'Potential weak authentication mechanism',
        severity: 'high',
        category: 'code',
        pattern: /(?:md5|sha1)\s*\(/gi,
        remediation: 'Use strong hashing algorithms like bcrypt, scrypt, or Argon2 for passwords',
        references: ['https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/']
      }
    ];
  }

  /**
   * CWE Top 25 security rules
   */
  getCWERules(): SecurityRule[] {
    return [
      {
        id: 'CWE-79-001',
        name: 'Reflected XSS',
        description: 'User input reflected without encoding',
        severity: 'high',
        category: 'code',
        pattern: /res\.(?:send|write|end)\s*\([^)]*(?:req\.(?:query|params|body)|request\.)/g,
        remediation: 'Encode all user input before reflecting in responses',
        references: ['https://cwe.mitre.org/data/definitions/79.html']
      },
      {
        id: 'CWE-89-001',
        name: 'SQL String Concatenation',
        description: 'SQL query built using string concatenation',
        severity: 'critical',
        category: 'code',
        pattern: /["'](?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER).*["']\s*\+/gi,
        remediation: 'Use parameterized queries instead of string concatenation',
        references: ['https://cwe.mitre.org/data/definitions/89.html']
      },
      {
        id: 'CWE-22-001',
        name: 'Path Manipulation',
        description: 'File path constructed from user input',
        severity: 'high',
        category: 'code',
        pattern: /path\.join\s*\([^)]*(?:req\.|request\.|params|query|body)/g,
        remediation: 'Validate paths against a whitelist and use path.resolve()',
        references: ['https://cwe.mitre.org/data/definitions/22.html']
      },
      {
        id: 'CWE-798-001',
        name: 'Hardcoded Credentials',
        description: 'Credentials hardcoded in source',
        severity: 'critical',
        category: 'code',
        pattern: /(?:username|user|login)\s*[:=]\s*["'][^"']+["'].*(?:password|pass|pwd)\s*[:=]\s*["'][^"']+["']/gi,
        remediation: 'Store credentials in environment variables or secure vaults',
        references: ['https://cwe.mitre.org/data/definitions/798.html']
      }
    ];
  }

  /**
   * DollhouseMCP-specific security rules
   */
  getDollhouseMCPRules(): SecurityRule[] {
    return [
      {
        id: 'DMCP-SEC-001',
        name: 'Unsafe Persona Loading',
        description: 'Persona loaded without validation',
        severity: 'high',
        category: 'custom',
        pattern: /loadPersona\s*\([^)]*\)\s*(?!.*validate)/g,
        remediation: 'Always validate personas before loading using PersonaValidator',
        references: ['DollhouseMCP Security Guidelines']
      },
      {
        id: 'DMCP-SEC-002',
        name: 'Token Validation Bypass',
        description: 'Token used without validation',
        severity: 'critical',
        category: 'custom',
        pattern: /(?:token|auth)[^;]*[^;]*(?!validate|verify|check)/gi,
        remediation: 'Always validate tokens using TokenManager.validateToken()',
        references: ['DollhouseMCP Security Guidelines']
      },
      {
        id: 'DMCP-SEC-003',
        name: 'Rate Limiting Missing',
        description: 'API endpoint without rate limiting',
        severity: 'medium',
        category: 'custom',
        check: (content, context) => {
          const findings = [];
          // Check for MCP tool handlers without rate limiting
          const toolPattern = /name:\s*["']([^"']+)["'].*handle:/gs;
          const hasRateLimit = /rateLimiter|checkRateLimit|tokenBucket/i.test(content);
          
          if (toolPattern.test(content) && !hasRateLimit && !context?.isTest) {
            findings.push({
              ruleId: 'DMCP-SEC-003',
              severity: 'medium',
              message: 'MCP tool handler without rate limiting',
              remediation: 'Add rate limiting to prevent abuse',
              confidence: 'high'
            });
          }
          
          return findings;
        },
        remediation: 'Implement rate limiting for all MCP tools',
        references: ['Issue #174 - Rate Limiting Implementation']
      },
      {
        id: 'DMCP-SEC-004',
        name: 'Unicode Validation Missing',
        description: 'User input processed without Unicode normalization',
        severity: 'medium',
        category: 'custom',
        check: (content, context) => {
          const findings = [];
          // Check for user input processing without Unicode validation
          const inputPattern = /(?:req\.|request\.|params|query|body|content)/;
          const hasUnicodeCheck = /UnicodeValidator|normalizeUnicode/i.test(content);
          
          if (inputPattern.test(content) && !hasUnicodeCheck && !context?.isTest) {
            findings.push({
              ruleId: 'DMCP-SEC-004',
              severity: 'medium',
              message: 'User input processed without Unicode normalization',
              remediation: 'Use UnicodeValidator.normalize() on all user input',
              confidence: 'medium'
            });
          }
          
          return findings;
        },
        remediation: 'Apply Unicode normalization to prevent bypass attacks',
        references: ['Issue #162 - Unicode Normalization']
      },
      {
        id: 'DMCP-SEC-005',
        name: 'Unvalidated YAML Content',
        description: 'YAML content parsed without security validation',
        severity: 'high',
        category: 'custom',
        pattern: /yaml\.load\s*\(|parse\s*\([^)]*\.ya?ml/gi,
        remediation: 'Use SecureYamlParser for all YAML parsing',
        references: ['DollhouseMCP Security Guidelines']
      },
      {
        id: 'DMCP-SEC-006',
        name: 'Security Event Not Logged',
        description: 'Security-relevant operation without logging',
        severity: 'low',
        category: 'custom',
        check: (content, context) => {
          const findings = [];
          // Check for security operations without logging
          const securityOps = /(?:authenticate|authorize|validate|sanitize|encrypt|decrypt)/i;
          const hasLogging = /SecurityMonitor\.log|logSecurityEvent/i.test(content);
          
          if (securityOps.test(content) && !hasLogging && !context?.isTest) {
            findings.push({
              ruleId: 'DMCP-SEC-006',
              severity: 'low',
              message: 'Security operation without audit logging',
              remediation: 'Add SecurityMonitor.logSecurityEvent() for audit trail',
              confidence: 'medium'
            });
          }
          
          return findings;
        },
        remediation: 'Log all security-relevant operations for audit trail',
        references: ['DollhouseMCP Security Guidelines']
      }
    ];
  }
}