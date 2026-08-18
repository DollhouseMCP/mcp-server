/**
 * Security Rules - Defines security patterns and checks
 * Based on OWASP Top 10, CWE Top 25, and DollhouseMCP-specific security requirements
 */

import { createRequire } from 'node:module';
import type { SecurityRule, SecurityFinding } from '../types.js';

type TypeScriptApi = typeof import('typescript');
type TsExpression = import('typescript').Expression;
type TsNode = import('typescript').Node;
type TsPropertyName = import('typescript').PropertyName;

const require = createRequire(import.meta.url);
const HTTP_INPUT_PROPERTIES = new Set(['body', 'query', 'params']);
let cachedTypeScript: TypeScriptApi | null | undefined;

function loadTypeScript(): TypeScriptApi | undefined {
  if (cachedTypeScript === undefined) {
    try {
      cachedTypeScript = require('typescript') as TypeScriptApi;
    } catch {
      cachedTypeScript = null;
    }
  }
  return cachedTypeScript ?? undefined;
}

function unwrapExpression(ts: TypeScriptApi, expression: TsExpression): TsExpression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isRequestIdentifier(ts: TypeScriptApi, expression: TsExpression): boolean {
  const candidate = unwrapExpression(ts, expression);
  return ts.isIdentifier(candidate) && (candidate.text === 'req' || candidate.text === 'request');
}

function propertyNameText(ts: TypeScriptApi, name: TsPropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

function bindingPatternReadsHttpInput(
  ts: TypeScriptApi,
  pattern: import('typescript').ObjectBindingPattern
): boolean {
  return pattern.elements.some(element => {
    if (element.dotDotDotToken) {
      return false;
    }
    let propertyName: string | undefined;
    if (element.propertyName) {
      propertyName = propertyNameText(ts, element.propertyName);
    } else if (ts.isIdentifier(element.name)) {
      propertyName = element.name.text;
    }
    return propertyName !== undefined && HTTP_INPUT_PROPERTIES.has(propertyName);
  });
}

function assignmentPatternReadsHttpInput(
  ts: TypeScriptApi,
  expression: import('typescript').ObjectLiteralExpression
): boolean {
  return expression.properties.some(property => {
    if (ts.isShorthandPropertyAssignment(property)) {
      return HTTP_INPUT_PROPERTIES.has(property.name.text);
    }
    if (ts.isPropertyAssignment(property)) {
      const propertyName = propertyNameText(ts, property.name);
      return propertyName !== undefined && HTTP_INPUT_PROPERTIES.has(propertyName);
    }
    return false;
  });
}

function nodeReadsHttpInput(ts: TypeScriptApi, node: TsNode): boolean {
  if (ts.isPropertyAccessExpression(node)) {
    return isRequestIdentifier(ts, node.expression) && HTTP_INPUT_PROPERTIES.has(node.name.text);
  }

  if (ts.isElementAccessExpression(node) && isRequestIdentifier(ts, node.expression)) {
    const argument = node.argumentExpression;
    return argument !== undefined && ts.isStringLiteralLike(argument)
      && HTTP_INPUT_PROPERTIES.has(argument.text);
  }

  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
    return isRequestIdentifier(ts, node.initializer) && bindingPatternReadsHttpInput(ts, node.name);
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && isRequestIdentifier(ts, node.right)) {
    const left = unwrapExpression(ts, node.left);
    return ts.isObjectLiteralExpression(left) && assignmentPatternReadsHttpInput(ts, left);
  }

  return false;
}

function hasHttpInputAccess(content: string): boolean {
  const ts = loadTypeScript();
  if (!ts) {
    const readsProperty = /\b(?:req|request)\s*\??\.\s*(?:body|query|params)\b/.test(content);
    const readsBracket = /\b(?:req|request)\s*\??\.\s*\[\s*['"](?:body|query|params)['"]\s*\]/.test(content);
    return readsProperty || readsBracket;
  }

  const source = ts.createSourceFile('security-audit-input.tsx', content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  let found = false;
  const visit = (node: TsNode): void => {
    if (found) {
      return;
    }
    found = nodeReadsHttpInput(ts, node);
    if (!found) {
      ts.forEachChild(node, visit);
    }
  };
  visit(source);
  return found;
}

function objectHasStaticToolName(ts: TypeScriptApi, node: import('typescript').ObjectLiteralExpression): boolean {
  return node.properties.some(property => ts.isPropertyAssignment(property)
    && propertyNameText(ts, property.name) === 'name'
    && ts.isStringLiteralLike(unwrapExpression(ts, property.initializer)));
}

function objectHasCallableHandle(
  ts: TypeScriptApi,
  node: import('typescript').ObjectLiteralExpression,
  callableIdentifiers: ReadonlySet<string>,
  callableNamespaces: ReadonlySet<string>,
  callableMembers: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  return node.properties.some(property => {
    if (ts.isMethodDeclaration(property)) {
      return propertyNameText(ts, property.name) === 'handle';
    }
    if (!ts.isPropertyAssignment(property) || propertyNameText(ts, property.name) !== 'handle') {
      return false;
    }
    return isCallableHandleExpression(
      ts,
      property.initializer,
      callableIdentifiers,
      callableNamespaces,
      callableMembers,
    );
  });
}

function isCallableHandleExpression(
  ts: TypeScriptApi,
  expression: TsExpression,
  callableIdentifiers: ReadonlySet<string>,
  callableNamespaces: ReadonlySet<string>,
  callableMembers: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const candidate = unwrapExpression(ts, expression);
  if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate) || ts.isCallExpression(candidate)) {
    return true;
  }
  if (ts.isIdentifier(candidate)) {
    return callableIdentifiers.has(candidate.text);
  }
  if (ts.isPropertyAccessExpression(candidate) && ts.isIdentifier(candidate.expression)) {
    return callableNamespaces.has(candidate.expression.text)
      || callableMembers.get(candidate.expression.text)?.has(candidate.name.text) === true;
  }
  if (ts.isElementAccessExpression(candidate)
    && ts.isIdentifier(candidate.expression)
    && candidate.argumentExpression
    && ts.isStringLiteralLike(candidate.argumentExpression)) {
    return callableNamespaces.has(candidate.expression.text)
      || callableMembers.get(candidate.expression.text)?.has(candidate.argumentExpression.text) === true;
  }
  if (ts.isConditionalExpression(candidate)) {
    return isCallableHandleExpression(
      ts,
      candidate.whenTrue,
      callableIdentifiers,
      callableNamespaces,
      callableMembers,
    ) && isCallableHandleExpression(
      ts,
      candidate.whenFalse,
      callableIdentifiers,
      callableNamespaces,
      callableMembers,
    );
  }
  return false;
}

function collectObjectCallableMembers(
  ts: TypeScriptApi,
  object: import('typescript').ObjectLiteralExpression,
): {
  readonly direct: ReadonlySet<string>;
  readonly pending: readonly { readonly memberName: string; readonly initializer: TsExpression }[];
} {
  const members = new Set<string>();
  const pending: Array<{ readonly memberName: string; readonly initializer: TsExpression }> = [];
  for (const property of object.properties) {
    if (ts.isMethodDeclaration(property)) {
      const name = propertyNameText(ts, property.name);
      if (name) members.add(name);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      pending.push({ memberName: property.name.text, initializer: property.name });
    } else if (ts.isPropertyAssignment(property)) {
      const initializer = unwrapExpression(ts, property.initializer);
      const name = propertyNameText(ts, property.name);
      if (name && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
        members.add(name);
      } else if (name) {
        pending.push({ memberName: name, initializer });
      }
    }
  }
  return { direct: members, pending };
}

type CallableAlias = { readonly name: string; readonly initializer: TsExpression };
type CallableMemberAlias = {
  readonly objectName: string;
  readonly memberName: string;
  readonly initializer: TsExpression;
};

function collectCallableBinding(
  ts: TypeScriptApi,
  name: string,
  initializerExpression: TsExpression,
  callable: Set<string>,
  namespaces: Set<string>,
  members: Map<string, Set<string>>,
  aliases: CallableAlias[],
  memberAliases: CallableMemberAlias[],
): void {
  const initializer = unwrapExpression(ts, initializerExpression);
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    callable.add(name);
    return;
  }
  if (ts.isCallExpression(initializer)) {
    // Without inter-module type resolution a factory may return either the
    // handler itself or an object containing handler methods. Preserve both
    // conservative interpretations for security-audit coverage.
    callable.add(name);
    namespaces.add(name);
    return;
  }
  if (ts.isNewExpression(initializer)) {
    // The scanner does not resolve class declarations or imported types. A
    // constructed instance can expose callable prototype methods, so treat
    // its members conservatively in the same way as a namespace import.
    namespaces.add(name);
    return;
  }
  if (!ts.isObjectLiteralExpression(initializer)) {
    aliases.push({ name, initializer });
    return;
  }

  const callableObjectMembers = collectObjectCallableMembers(ts, initializer);
  if (callableObjectMembers.direct.size > 0) {
    members.set(name, new Set(callableObjectMembers.direct));
  }
  for (const member of callableObjectMembers.pending) {
    memberAliases.push({ objectName: name, ...member });
  }
}

function collectCallableVariable(
  ts: TypeScriptApi,
  node: import('typescript').VariableDeclaration,
  callable: Set<string>,
  namespaces: Set<string>,
  members: Map<string, Set<string>>,
  aliases: CallableAlias[],
  memberAliases: CallableMemberAlias[],
): void {
  if (!ts.isIdentifier(node.name) || !node.initializer) return;
  collectCallableBinding(ts, node.name.text, node.initializer, callable, namespaces, members, aliases, memberAliases);
}

function callableMemberAssignmentTarget(
  ts: TypeScriptApi,
  expression: TsExpression,
): { readonly objectName: string; readonly memberName: string } | null {
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return { objectName: expression.expression.text, memberName: expression.name.text };
  }
  if (ts.isElementAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)) {
    return { objectName: expression.expression.text, memberName: expression.argumentExpression.text };
  }
  return null;
}

function collectCallableAssignment(
  ts: TypeScriptApi,
  node: import('typescript').BinaryExpression,
  callable: Set<string>,
  namespaces: Set<string>,
  members: Map<string, Set<string>>,
  aliases: CallableAlias[],
  memberAliases: CallableMemberAlias[],
): void {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
  const left = unwrapExpression(ts, node.left);
  if (ts.isIdentifier(left)) {
    collectCallableBinding(ts, left.text, node.right, callable, namespaces, members, aliases, memberAliases);
    return;
  }
  const target = callableMemberAssignmentTarget(ts, left);
  if (target) {
    memberAliases.push({ ...target, initializer: unwrapExpression(ts, node.right) });
  }
}

function collectCallableNode(
  ts: TypeScriptApi,
  node: TsNode,
  callable: Set<string>,
  namespaces: Set<string>,
  members: Map<string, Set<string>>,
  aliases: CallableAlias[],
  memberAliases: CallableMemberAlias[],
): void {
  if (ts.isFunctionDeclaration(node) && node.name) {
    callable.add(node.name.text);
  } else if (ts.isClassDeclaration(node) && node.name) {
    namespaces.add(node.name.text);
  } else if (ts.isImportClause(node) && node.name) {
    // Default imports are opaque without resolving another module. Treat
    // them conservatively when assigned to a tool's handle property.
    callable.add(node.name.text);
    namespaces.add(node.name.text);
  } else if (ts.isImportSpecifier(node)) {
    callable.add(node.name.text);
    namespaces.add(node.name.text);
  } else if (ts.isNamespaceImport(node)) {
    namespaces.add(node.name.text);
  } else if (ts.isVariableDeclaration(node)) {
    collectCallableVariable(ts, node, callable, namespaces, members, aliases, memberAliases);
  } else if (ts.isBinaryExpression(node)) {
    collectCallableAssignment(ts, node, callable, namespaces, members, aliases, memberAliases);
  }
}

function resolveCallableAliases(
  ts: TypeScriptApi,
  callable: Set<string>,
  namespaces: Set<string>,
  members: Map<string, Set<string>>,
  aliases: readonly CallableAlias[],
  memberAliases: readonly CallableMemberAlias[],
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of aliases) {
      const initializer = unwrapExpression(ts, alias.initializer);
      if (ts.isIdentifier(initializer) && namespaces.has(initializer.text) && !namespaces.has(alias.name)) {
        namespaces.add(alias.name);
        changed = true;
      }
      if (!callable.has(alias.name) && isCallableHandleExpression(
        ts,
        alias.initializer,
        callable,
        namespaces,
        members,
      )) {
        callable.add(alias.name);
        changed = true;
      }
    }
    for (const memberAlias of memberAliases) {
      const objectMembers = members.get(memberAlias.objectName) ?? new Set<string>();
      if (!objectMembers.has(memberAlias.memberName) && isCallableHandleExpression(
        ts,
        memberAlias.initializer,
        callable,
        namespaces,
        members,
      )) {
        objectMembers.add(memberAlias.memberName);
        members.set(memberAlias.objectName, objectMembers);
        changed = true;
      }
    }
  }
}

function collectCallableIdentifiers(
  ts: TypeScriptApi,
  source: import('typescript').SourceFile,
): {
  readonly identifiers: ReadonlySet<string>;
  readonly namespaces: ReadonlySet<string>;
  readonly members: ReadonlyMap<string, ReadonlySet<string>>;
} {
  const callable = new Set<string>();
  const namespaces = new Set<string>();
  const members = new Map<string, Set<string>>();
  const aliases: CallableAlias[] = [];
  const memberAliases: CallableMemberAlias[] = [];
  const visit = (node: TsNode): void => {
    collectCallableNode(ts, node, callable, namespaces, members, aliases, memberAliases);
    ts.forEachChild(node, visit);
  };
  visit(source);
  resolveCallableAliases(ts, callable, namespaces, members, aliases, memberAliases);
  return { identifiers: callable, namespaces, members };
}

function hasMcpToolHandler(content: string): boolean {
  const ts = loadTypeScript();
  if (!ts) {
    const lines = content.split('\n');
    return lines.some((line, index) => {
      if (!/\bname\s*:/.test(line)) return false;
      // The fallback is deliberately bounded; production scans load TypeScript
      // and use object-local AST analysis below.
      return lines.slice(index, index + 20).some(candidate => /\bhandle\s*[:(]/.test(candidate));
    });
  }

  const source = ts.createSourceFile('security-audit-tools.tsx', content, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const callableBindings = collectCallableIdentifiers(ts, source);
  let found = false;
  const visit = (node: TsNode): void => {
    if (found) return;
    if (ts.isObjectLiteralExpression(node)
      && objectHasStaticToolName(ts, node)
      && objectHasCallableHandle(
        ts,
        node,
        callableBindings.identifiers,
        callableBindings.namespaces,
        callableBindings.members,
      )) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
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
          const hasRateLimit = /rateLimiter|checkRateLimit|tokenBucket/i.test(content);
          
          if (hasMcpToolHandler(content) && !hasRateLimit) {
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
          // Parse JavaScript/TypeScript syntax so comments, regex literals, template
          // expressions, and destructuring aliases are classified accurately.
          const accessesHttpInput = hasHttpInputAccess(content);
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
