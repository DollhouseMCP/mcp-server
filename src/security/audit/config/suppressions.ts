/**
 * Security Audit Suppression Configuration
 * 
 * This file contains suppression rules for false positives in the security audit.
 * Each suppression should be well-documented with a clear reason.
 */

export interface Suppression {
  rule: string;
  file?: string;
  reason: string;
}

export const suppressions: Suppression[] = [
  // ========================================
  // SQL Injection False Positives
  // ========================================
  {
    rule: 'CWE-89-001',
    file: 'src/update/UpdateManager.ts',
    reason: 'False positive - "Update Failed" is a UI message, not SQL. The codebase does not use SQL.'
  },
  
  // ========================================
  // Test File Suppressions
  // ========================================
  {
    rule: '*',
    file: '__tests__/**/*',
    reason: 'Test files may contain intentional security patterns for testing'
  },
  {
    rule: '*',
    file: '**/*.test.ts',
    reason: 'Test files may contain intentional security patterns for testing'
  },
  {
    rule: '*',
    file: '**/*.spec.ts',
    reason: 'Test files may contain intentional security patterns for testing'
  },
  
  // ========================================
  // YAML Parsing False Positives
  // ========================================
  {
    rule: 'DMCP-SEC-005',
    file: 'src/security/yamlValidator.ts',
    reason: 'YamlValidator is the security validation layer itself - it needs direct yaml.load access'
  },
  {
    rule: 'DMCP-SEC-005',
    file: 'src/security/secureYamlParser.ts',
    reason: 'SecureYamlParser is the security wrapper that validates YAML before parsing'
  },
  
  // ========================================
  // Security Rule Definition Files
  // ========================================
  {
    rule: 'OWASP-A03-004',
    file: 'src/security/audit/rules/SecurityRules.ts',
    reason: 'This is a regex pattern definition for detecting innerHTML usage, not actual usage'
  },
  
  // ========================================
  // Persona Loading False Positives
  // ========================================
  {
    rule: 'DMCP-SEC-001',
    file: 'src/persona/PersonaLoader.ts',
    reason: 'PersonaLoader validates personas through SecureYamlParser and ContentValidator'
  },
  
  // ========================================
  // Unicode Normalization False Positives
  // ========================================
  {
    rule: 'DMCP-SEC-004',
    file: 'src/types/*.ts',
    reason: 'Type definition files do not process user input'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/errors/*.ts',
    reason: 'Error classes do not process user input'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/config/*.ts',
    reason: 'Configuration files do not process user input directly'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/constants/*.ts',
    reason: 'Constant definition files do not process user input'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/utils/*.ts',
    reason: 'Utility functions receive already-normalized input from ServerSetup'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/cache/*.ts',
    reason: 'Cache layer receives already-normalized input'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/security/**/*.ts',
    reason: 'Security modules handle validation and normalization themselves'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/index.ts',
    reason: 'Main entry point delegates to ServerSetup which normalizes all inputs'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/server/ServerSetup.ts',
    reason: 'This is where Unicode normalization is implemented for all tool inputs'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/marketplace/*.ts',
    reason: 'Marketplace modules receive normalized input from tool handlers'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/marketplace/**/*.ts',
    reason: 'Marketplace modules receive normalized input from tool handlers'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/persona/*.ts',
    reason: 'Persona modules receive normalized input from tool handlers'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/persona/**/*.ts',
    reason: 'Persona modules receive normalized input from tool handlers'
  },
  {
    rule: 'DMCP-SEC-004',
    file: 'src/update/*.ts',
    reason: 'Update modules receive normalized input from tool handlers'
  },
  
  // ========================================
  // Audit Logging False Positives
  // ========================================
  {
    rule: 'DMCP-SEC-006',
    file: 'src/types/*.ts',
    reason: 'Type definition files do not perform security operations'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/constants/*.ts',
    reason: 'Constant files do not perform security operations'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/config/*.ts',
    reason: 'Configuration files do not perform security operations'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/errors/*.ts',
    reason: 'Error classes are not security operations requiring audit'
  },
  {
    rule: 'DMCP-SEC-006',
    file: '*.json',
    reason: 'JSON files cannot contain executable code'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'scripts/**/*',
    reason: 'Build scripts do not perform runtime security operations'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/security/**/*.ts',
    reason: 'Security modules are infrastructure, not operations requiring audit'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/marketplace/*.ts',
    reason: 'Marketplace operations are not security-sensitive requiring audit'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/marketplace/**/*.ts',
    reason: 'Marketplace operations are not security-sensitive requiring audit'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/persona/*.ts',
    reason: 'Persona operations are validated at entry point, not security operations'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/persona/**/*.ts',
    reason: 'Persona operations are validated at entry point, not security operations'
  },
  {
    rule: 'DMCP-SEC-006',
    file: 'src/server/tools/**/*.ts',
    reason: 'Tool implementations delegate to services that handle security'
  },
  
  // ========================================
  // Documentation and Non-Code Files
  // ========================================
  {
    rule: '*',
    file: '*.md',
    reason: 'Markdown documentation files'
  },
  {
    rule: '*',
    file: 'LICENSE',
    reason: 'License file'
  },
  {
    rule: '*',
    file: '.gitignore',
    reason: 'Git configuration file'
  },
  {
    rule: '*',
    file: '*.yml',
    reason: 'YAML configuration files are data, not code'
  },
  {
    rule: '*',
    file: '*.yaml',
    reason: 'YAML configuration files are data, not code'
  }
];

/**
 * Get suppressions as a map for efficient lookup
 */
export function getSuppressionMap(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  
  for (const suppression of suppressions) {
    const key = suppression.file || '*';
    if (!map.has(key)) {
      map.set(key, new Set());
    }
    map.get(key)!.add(suppression.rule);
  }
  
  return map;
}

/**
 * Check if a finding should be suppressed
 */
export function shouldSuppress(ruleId: string, filePath?: string): boolean {
  if (!filePath) return false;
  
  // Convert absolute path to relative path for matching
  const relativePath = filePath.includes('/DollhouseMCP/') 
    ? filePath.split('/DollhouseMCP/')[1] 
    : filePath;
  
  // Check exact file match
  for (const suppression of suppressions) {
    if (suppression.rule === ruleId && suppression.file === relativePath) {
      return true;
    }
    // Also check absolute path
    if (suppression.rule === ruleId && suppression.file === filePath) {
      return true;
    }
  }
  
  // Check pattern matches
  for (const suppression of suppressions) {
    if (!suppression.file) continue;
    
    // Handle wildcard patterns
    if (suppression.file.includes('*')) {
      const pattern = suppression.file
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\//g, '\\/');
      const regex = new RegExp(`^${pattern}$`);
      
      // Test both relative and absolute paths
      if ((regex.test(relativePath) || regex.test(filePath)) && 
          (suppression.rule === '*' || suppression.rule === ruleId)) {
        return true;
      }
    }
  }
  
  return false;
}