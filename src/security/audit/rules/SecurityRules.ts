/**
 * Security Rules - Defines security patterns and checks
 * Based on OWASP Top 10, CWE Top 25, and DollhouseMCP-specific security requirements
 */

import type { SecurityRule, SecurityFinding } from '../types.js';

type QuoteCharacter = '"' | "'" | '`';
type LexicalMode = QuoteCharacter | 'line-comment' | 'block-comment';

interface LexicalState {
  mode?: LexicalMode;
  escaped: boolean;
}

const HTTP_INPUT_PROPERTY = /^(?:(?:body|query|params)\b|(['"])(?:body|query|params)\1|\[\s*(['"])(?:body|query|params)\2\s*\])/;
const LEADING_TRIVIA = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*/;

function isQuoteCharacter(character: string | undefined): character is QuoteCharacter {
  return character === '"' || character === "'" || character === '`';
}

function consumeNonCode(
  state: LexicalState,
  character: string | undefined,
  nextCharacter: string | undefined
): number | undefined {
  if (state.mode === 'line-comment') {
    if (character === '\n') {
      state.mode = undefined;
    }
    return 0;
  }

  if (state.mode === 'block-comment') {
    if (character === '*' && nextCharacter === '/') {
      state.mode = undefined;
      return 1;
    }
    return 0;
  }

  if (isQuoteCharacter(state.mode)) {
    if (state.escaped) {
      state.escaped = false;
    } else if (character === '\\') {
      state.escaped = true;
    } else if (character === state.mode) {
      state.mode = undefined;
    }
    return 0;
  }

  if (isQuoteCharacter(character)) {
    state.mode = character;
    return 0;
  }

  if (character === '/' && nextCharacter === '/') {
    state.mode = 'line-comment';
    return 1;
  }

  if (character === '/' && nextCharacter === '*') {
    state.mode = 'block-comment';
    return 1;
  }

  return undefined;
}

function buildCodePositionMask(content: string): boolean[] {
  const codePositions = Array.from<boolean>({ length: content.length }).fill(true);
  const lexicalState: LexicalState = { escaped: false };

  for (let index = 0; index < content.length; index += 1) {
    const skippedCharacters = consumeNonCode(lexicalState, content[index], content[index + 1]);
    if (skippedCharacters === undefined) {
      continue;
    }

    codePositions[index] = false;
    if (skippedCharacters === 1) {
      codePositions[index + 1] = false;
      index += 1;
    }
  }

  return codePositions;
}

function patternMatchesCode(content: string, pattern: RegExp, codePositions: boolean[]): boolean {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    if (codePositions[match.index]) {
      return true;
    }
  }
  return false;
}

function findClosingBrace(content: string, openingBrace: number): number {
  let depth = 0;
  const lexicalState: LexicalState = { escaped: false };

  for (let index = openingBrace; index < content.length; index += 1) {
    const character = content[index];
    const skippedCharacters = consumeNonCode(lexicalState, character, content[index + 1]);

    if (skippedCharacters !== undefined) {
      index += skippedCharacters;
      continue;
    }

    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function segmentReadsHttpInput(segment: string): boolean {
  const trimmed = segment.replace(LEADING_TRIVIA, '');
  const propertyMatch = HTTP_INPUT_PROPERTY.exec(trimmed);
  if (!propertyMatch) {
    return false;
  }

  const remainder = trimmed.slice(propertyMatch[0].length).trimStart();
  return remainder === '' || remainder.startsWith(':') || remainder.startsWith('=');
}

function bindingReadsHttpInput(binding: string): boolean {
  let depth = 0;
  let segmentStart = 0;
  const lexicalState: LexicalState = { escaped: false };

  for (let index = 0; index <= binding.length; index += 1) {
    const character = binding[index];
    const skippedCharacters = consumeNonCode(lexicalState, character, binding[index + 1]);

    if (skippedCharacters !== undefined) {
      index += skippedCharacters;
      continue;
    }

    if (character === '{' || character === '[' || character === '(') {
      depth += 1;
    } else if (character === '}' || character === ']' || character === ')') {
      depth -= 1;
    } else if ((character === ',' && depth === 0) || index === binding.length) {
      if (segmentReadsHttpInput(binding.slice(segmentStart, index))) {
        return true;
      }
      segmentStart = index + 1;
    }
  }

  return false;
}

function hasDestructuredHttpInputAccess(content: string, codePositions: boolean[]): boolean {
  const bindingPattern = /\b(?:const|let|var)\s*\{|\(\s*\{/g;
  let binding: RegExpExecArray | null;

  while ((binding = bindingPattern.exec(content)) !== null) {
    const openingBrace = content.indexOf('{', binding.index);
    bindingPattern.lastIndex = openingBrace + 1;
    if (!codePositions[binding.index]) {
      continue;
    }

    const closingBrace = findClosingBrace(content, openingBrace);
    if (closingBrace < 0) {
      continue;
    }

    const assignment = content.slice(closingBrace + 1);
    if (/^\s*(?::[^=;\n]+)?=\s*(?:req|request)\b/.test(assignment)
      && bindingReadsHttpInput(content.slice(openingBrace + 1, closingBrace))) {
      return true;
    }

  }

  return false;
}

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
        pattern: /(?:api[_-]?key|secret|password|token|private[_-]?key)\s*[:=]\s*["'][a-zA-Z0-9+/=_-]{10,}["']/gi,
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
        pattern: /(?:exec|spawn|execSync|spawnSync)\s*\([^)]*(?:\$\{[^}]+\}|\+\s*[a-zA-Z_]\w*)/g,
        remediation: 'Validate and sanitize all user input before using in system commands',
        references: ['https://owasp.org/Top10/A03_2021-Injection/']
      },
      {
        id: 'OWASP-A03-003',
        name: 'Path Traversal',
        description: 'Potential path traversal vulnerability',
        severity: 'high',
        category: 'code',
        pattern: /(?:readFile|writeFile|readdir|mkdir|rm|unlink)[^(]*\([^)]*(?:\.\.[/\\].*\+|\+.*\.\.[/\\])/g,
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
        pattern: /["'`].*(?:SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER).*["'`]\s*\+\s*\w+/gi,
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
        pattern: /(?:getToken|useToken|token\.use)\s*\([^)]*\)(?!.*(?:validate|verify|check))/gi,
        remediation: 'Always validate tokens using TokenManager.validateToken()',
        references: ['DollhouseMCP Security Guidelines']
      },
      {
        id: 'DMCP-SEC-003',
        name: 'Rate Limiting Missing',
        description: 'API endpoint without rate limiting',
        severity: 'medium',
        category: 'custom',
        check: (content, _context) => {
          const findings: SecurityFinding[] = [];
          // Check for MCP tool handlers without rate limiting
          const toolPattern = /name:\s*["']([^"']+)["'].*handle:/gs;
          const hasRateLimit = /rateLimiter|checkRateLimit|tokenBucket/i.test(content);
          
          if (toolPattern.test(content) && !hasRateLimit) {
            findings.push({
              ruleId: 'DMCP-SEC-003',
              severity: 'medium' as const,
              message: 'MCP tool handler without rate limiting',
              remediation: 'Add rate limiting to prevent abuse',
              confidence: 'high' as const
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
        check: (content, _context) => {
          const findings: SecurityFinding[] = [];
          // Restrict this heuristic to HTTP request-boundary access. Generic names
          // such as `content`, `body`, or `params` do not establish user input.
          const directInputPattern = /\b(?:req|request)\s*(?:(?:\?\s*)?\.\s*(?:body|query|params)\b|(?:\?\s*\.)?\s*\[\s*(['"])(?:body|query|params)\1\s*\])/g;
          const codePositions = buildCodePositionMask(content);
          const accessesHttpInput = patternMatchesCode(content, directInputPattern, codePositions)
            || hasDestructuredHttpInputAccess(content, codePositions);
          const hasUnicodeCheck = /UnicodeValidator|normalizeUnicode|\.normalize\(\s*['"]NFC['"]\s*\)/i.test(content);
          
          if (accessesHttpInput && !hasUnicodeCheck) {
            findings.push({
              ruleId: 'DMCP-SEC-004',
              severity: 'medium' as const,
              message: 'User input processed without Unicode normalization',
              remediation: 'Use UnicodeValidator.normalize() on all user input',
              confidence: 'medium' as const
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
        check: (content, _context) => {
          const findings: SecurityFinding[] = [];

          // FIX: Only flag files with actual executable code
          // Skip files that are pure type definitions (interfaces, types only)
          const hasExecutableCode =
            /(?:^|\n)\s*(?:export\s+)?(?:function|class|const\s+\w+\s*=\s*(?:async\s+)?\(|async\s+function)/m.test(content) ||
            /(?:^|\n)\s*(?:public|private|protected|async)\s+\w+\s*\(/m.test(content);

          if (!hasExecutableCode) {
            return findings; // Skip pure type definition files
          }

          // Remove comments and strings to avoid false positives on keywords in documentation
          // FIX: Preserve ${...} expressions in template literals to avoid false negatives
          // When scanning for security calls like authenticate(`user-${id}`), we must preserve
          // both the function call (authenticate) and the expression inside ${} (id).
          // Otherwise we get false negatives where security-sensitive calls are missed.
          const codeOnly = content
            .replace(/\/\/.*$/gm, '') // Remove single-line comments
            .replace(/\/\*[\s\S]*?\*\//g, '') // Remove multi-line comments
            .replace(/'(?:[^'\\]|\\.)*'/g, '') // Remove single-quoted strings
            .replace(/"(?:[^"\\]|\\.)*"/g, '') // Remove double-quoted strings
            // For template literals: remove string content but preserve ${...} expressions
            .replace(/`([^`]*)`/g, (_match, inner: string) => {
              // Extract ${...} expressions and keep their content
              const expressions = inner.match(/\$\{([^}]+)\}/g);
              if (expressions) {
                return expressions.map((e: string) => e.replace(/\$\{([^}]+)\}/, '$1')).join(' ');
              }
              return ''; // No expressions, remove the whole template literal
            });

          // Check for actual security operation function CALLS (not just keywords in text)
          // Match: authenticate(...), validate(...), etc. - not just the words
          const securityOpCalls = /\b(?:authenticate|authorize|validate|sanitize|encrypt|decrypt)\s*\(/i;
          const hasLogging = /SecurityMonitor\.log|logSecurityEvent/i.test(content);

          if (securityOpCalls.test(codeOnly) && !hasLogging) {
            findings.push({
              ruleId: 'DMCP-SEC-006',
              severity: 'low' as const,
              message: 'Security operation without audit logging',
              remediation: 'Add SecurityMonitor.logSecurityEvent() for audit trail',
              confidence: 'medium' as const
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
