# Security Guide for Contributors

**Version:** 1.0.0
**Last Updated:** 2026-01-03

This guide outlines security requirements and best practices for contributing to DollhouseMCP.

## Security Model Overview

DollhouseMCP operates as a mediator between LLMs and target systems. Security is enforced at multiple layers:

```
┌─────────────────────────────────────────────────────────────┐
│                    Security Layers                          │
├─────────────────────────────────────────────────────────────┤
│  Layer 1: Input Validation                                  │
│    └── All user/LLM input validated before processing       │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: YAML/Content Parsing                              │
│    └── SecureYamlParser, ContentValidator                   │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Path/File Operations                              │
│    └── Sandboxed directories, no traversal                  │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Gatekeeper (Enterprise)                           │
│    └── Persona-based permissions, audit logging             │
└─────────────────────────────────────────────────────────────┘
```

## Required Security Utilities

### YAML Parsing

**Always use `SecureYamlParser`** - never use `yaml.load()` directly.

```typescript
// For markdown with frontmatter (personas, skills, templates)
import { SecureYamlParser } from '../security/secureYamlParser.js';
const result = SecureYamlParser.parse(markdownContent);

// For raw YAML content (export data, config snippets)
const data = SecureYamlParser.parseRawYaml(yamlString);
```

**Why:** Prevents deserialization attacks, enforces size limits, uses safe schema.

### Content Validation

```typescript
import { ContentValidator } from '../security/contentValidator.js';

// Validate user-provided content
const validation = ContentValidator.validateAndSanitize(userInput);
if (!validation.isValid) {
  throw new SecurityError(validation.message, validation.severity);
}
```

### File Operations

```typescript
import { FileGuard } from '../security/fileGuard.js';

// Check if path is within allowed directories
if (!FileGuard.isPathAllowed(filePath, allowedDirs)) {
  throw new SecurityError('Path outside allowed directories', 'high');
}

// Use FileTransaction for atomic writes
const transaction = new FileTransaction(filePath);
await transaction.write(content);
await transaction.commit();
```

### Error Handling

```typescript
import { SecurityError } from '../errors/SecurityError.js';

// Use SecurityError for security-related failures
throw new SecurityError('Invalid access attempt', 'high');

// Never expose internal paths or stack traces to users
// Use safeMessage for user-facing errors
```

## Security Checklist for PRs

Before submitting a PR, verify:

### Input Validation
- [ ] All user/LLM input is validated
- [ ] Parameter types are checked (not just trusted)
- [ ] Unknown properties trigger warnings (not silent ignore)
- [ ] Size limits enforced for strings/arrays

### YAML/JSON Parsing
- [ ] Using `SecureYamlParser` for all YAML
- [ ] Using `JSON.parse` with try/catch for JSON
- [ ] Not using `eval()`, `Function()`, or similar

### File System
- [ ] Paths validated against allowed directories
- [ ] No path traversal possible (`../` normalized and checked)
- [ ] Using `FileTransaction` for atomic writes
- [ ] File permissions set appropriately

### Error Handling
- [ ] Internal errors don't leak to users
- [ ] Stack traces not exposed in responses
- [ ] Security events logged via `SecurityMonitor`

### Dependencies
- [ ] No new dependencies with known vulnerabilities
- [ ] Dependencies pinned to specific versions
- [ ] `npm audit` passes

## Prototype Pollution Prevention

### Path Resolution

When resolving nested object paths (e.g., for parameter sources):

```typescript
// Always validate paths before accessing
const SAFE_PATH_PATTERN = /^[a-zA-Z_$][a-zA-Z0-9_$.]*$/;
const FORBIDDEN_PATHS = new Set(['__proto__', 'constructor', 'prototype']);

function getNestedValue(obj: unknown, path: string): unknown {
  // Validate path format
  if (!SAFE_PATH_PATTERN.test(path)) {
    throw new Error('Invalid property path format');
  }

  // Check each segment
  const segments = path.split('.');
  for (const segment of segments) {
    if (FORBIDDEN_PATHS.has(segment)) {
      throw new Error(`Forbidden path segment: ${segment}`);
    }
  }

  // Now safe to traverse
  // ...
}
```

### Object Spread

Be careful with object spread from untrusted sources:

```typescript
// UNSAFE - can inherit __proto__
const merged = { ...userInput, ...defaults };

// SAFER - validate keys first
const safeInput = Object.fromEntries(
  Object.entries(userInput).filter(([key]) => !FORBIDDEN_PATHS.has(key))
);
const merged = { ...safeInput, ...defaults };
```

## Multi-Adapter Security (Gatekeeper)

When DollhouseMCP acts as a mediator for multiple adapters:

### LLM as Relay Trust Model

The LLM relays messages between DollhouseMCP and adapters. We trust the LLM to:
- Not fabricate adapter responses
- Not skip permission checks
- Relay messages accurately

We **cannot** use cryptographic signing because:
- LLMs are not reliable transports for opaque byte sequences
- They may reformat, summarize, or slightly mangle content

Instead, we use:
- Clear, structured instructions LLMs handle reliably
- State tracking in DollhouseMCP (single source of truth)
- Acknowledgment protocols through LLM relay

### Element-Derived Permissions

Personas and other elements can define permissions:

```yaml
---
name: Junior Developer
type: persona
---

## Capabilities
- Create pull requests
- Run tests

## Boundaries
- Cannot merge without review
- Cannot access production
```

Gatekeeper reads these and enforces programmatically.

## Security Testing

### Required Tests

1. **Unit tests for security utilities**
   - SecureYamlParser edge cases
   - ContentValidator injection patterns
   - FileGuard path traversal attempts

2. **Integration tests for security boundaries**
   - Prototype pollution attempts blocked
   - Path injection attempts blocked
   - Size limit enforcement

3. **Security regression tests**
   ```bash
   npm run security:rapid    # Quick security smoke tests
   npm run security:all      # Full security coverage
   npm run security:audit    # Dependency audit
   ```

### Adding Security Tests

```typescript
describe('Security - prototype pollution', () => {
  it('should block __proto__ in path', () => {
    expect(() => getNestedValue(obj, '__proto__')).toThrow('Forbidden');
  });

  it('should block constructor in nested path', () => {
    expect(() => getNestedValue(obj, 'input.constructor')).toThrow('Forbidden');
  });
});
```

## Reporting Security Issues

**Do not** open public GitHub issues for security vulnerabilities.

Instead:
1. Email security@dollhousemcp.com (if available)
2. Use GitHub Security Advisories (private)
3. Contact maintainers directly via secure channel

Include:
- Description of vulnerability
- Steps to reproduce
- Potential impact assessment
- Suggested fix (if available)

## Security Audit Compliance

PRs must pass the security audit:

```bash
npm run pre-commit  # Includes security tests
```

The CI security audit checks:
- No high/critical severity issues
- Prototype pollution patterns
- YAML parsing safety
- Path injection vectors
- Unvalidated input usage

## Related Documentation

- [Security Checklist](./security-checklist.md)
- [Security Testing](./testing.md)
- [ADR-001: CRUDE Protocol](../architecture/ADR-001-CRUDE-PROTOCOL.md)
- [MCP-AQL Architecture](../architecture/MCP-AQL-ARCHITECTURE.md)
- [Gatekeeper Product Strategy](../architecture/GATEKEEPER_PRODUCT_STRATEGY.md)
