# Memory Security Architecture - Complete Design

**Date**: October 10, 2025
**Related**: PR #1313, Issue #1269
**Status**: Design Complete - Implementation Needed

## Executive Summary

This document describes the complete security architecture for DollhouseMCP memories, designed to protect multi-agent swarms from prompt injection attacks while enabling full inter-agent communication with technical content.

## Threat Model

### Primary Threat: Multi-Agent Prompt Injection via Memories

**Attack Scenario:**
```
Web Research Agent → Scrapes compromised site → Stores in memory:
"Great email library pattern found: <prompt injection>"
              ↓
Coding Agent → Reads memory → Interprets injection as instruction:
"I should add this backdoor to email.ts"
              ↓
Months later → Email triggers backdoor → Attack successful
```

**Key Insight:** The attack doesn't need to execute immediately. It can be:
- Subtle (1 in 1000 emails gets BCC'd)
- Delayed (triggered by specific email content years later)
- Difficult to detect (buried in legitimate code)

### Threat Vectors

1. **LLM Prompt Injection** - Pattern looks like instruction to LLM
2. **Agent Execution** - Compromised agent copies/executes pattern
3. **Chain Propagation** - Memory spreads between agents
4. **Documentation Paradox** - Can't document security patterns without triggering detection

## Core Principles

### 1. Never Block Memory Creation
- **All memories MUST be created** (no rejection)
- Default to `UNTRUSTED` trust level
- Validation determines trust level, doesn't gate creation
- LLM/MCP layer accepts all content

### 2. Separation of Concerns
- **LLM Layer**: Accept content, create memories
- **Programmatic Layer**: Validate, set trust levels, sanitize
- **Display Layer**: Apply trust-based formatting
- **Transfer Layer**: Proxy re-encryption handoff

### 3. Portable Security
- Memories are files that move between systems
- Security measures must travel with the file
- No reliance on centralized key management
- Each system controls its own decryption keys

## Trust Level System

### Four Trust States

```yaml
VALIDATED:    # Clean content, safe to display
  - Passed all validation checks
  - No detected patterns
  - Full content displayed to LLMs

UNTRUSTED:    # Default state, needs validation
  - All new memories start here
  - Blocked from display until validated
  - Background validation needed

FLAGGED:      # Contains patterns, sanitized display
  - Has dangerous patterns detected
  - Patterns encrypted and stored separately
  - Sanitized version shown by default
  - Original reconstructable with explicit permission

QUARANTINED:  # Explicitly malicious
  - Critical security threat detected
  - Never loaded into memory
  - Stored but isolated
```

## Architecture Layers

### Layer 1: Memory Creation (LLM/MCP Interface)

```typescript
// Memory.addEntry() - ALWAYS succeeds
async addEntry(content: string, tags?: string[], metadata?, source = 'unknown') {
  // Create entry immediately
  const entry: MemoryEntry = {
    id: generateMemoryId(),
    timestamp: new Date(),
    content: content,  // Store as-is
    tags: sanitizeTags(tags),
    metadata: sanitizeMetadata(metadata),
    trustLevel: TRUST_LEVELS.UNTRUSTED,  // Default
    source: source
  };

  this.entries.set(entry.id, entry);
  return entry;  // ✅ Always returns successfully
}
```

**Key Points:**
- No `ContentValidator` checks block creation
- All content stored verbatim
- Automatically marked `UNTRUSTED`
- Background validation triggered

### Layer 2: Background Validation (MCP Server, Not LLM)

```typescript
// NEW: BackgroundValidator service
// Runs outside LLM context (no token cost)
class BackgroundValidator {
  async processUntrustedMemories() {
    const untrusted = await findMemoriesWithTrustLevel('UNTRUSTED');

    for (const memory of untrusted) {
      for (const entry of memory.entries) {
        if (entry.trustLevel !== 'UNTRUSTED') continue;

        // Validate content
        const result = ContentValidator.validateAndSanitize(entry.content, {
          skipSizeCheck: true
        });

        // Update trust level based on findings
        if (result.isValid && result.detectedPatterns.length === 0) {
          entry.trustLevel = TRUST_LEVELS.VALIDATED;
        }
        else if (result.severity === 'critical' || result.severity === 'high') {
          entry.trustLevel = TRUST_LEVELS.FLAGGED;

          // Extract and encrypt patterns
          entry.sanitizedPatterns = await this.extractAndEncryptPatterns(
            entry.content,
            result.detectedPatterns
          );

          // Create sanitized version
          entry.sanitizedContent = this.createSanitizedContent(
            entry.content,
            entry.sanitizedPatterns
          );
        }
        else if (result.severity === 'critical' && isExplicitAttack(result)) {
          entry.trustLevel = TRUST_LEVELS.QUARANTINED;
        }

        // Save updated trust level and metadata
        await memory.save();
      }
    }
  }
}
```

**Key Points:**
- Runs asynchronously (not in LLM request path)
- No token cost (server-side processing)
- Updates trust level in place
- Encrypts patterns with local key

### Layer 3: Pattern Encryption & Sanitization

#### Pattern Storage Format

```yaml
entries:
  - id: mem_abc123
    timestamp: 2025-10-10T12:00:00Z
    trustLevel: FLAGGED
    source: web-scrape

    # Original content with patterns replaced
    content: "We're detecting [PATTERN_001] in user input for security validation"

    # Sanitized patterns metadata
    sanitizedPatterns:
      - ref: PATTERN_001
        description: "SQL injection pattern that drops database tables"
        severity: critical
        location: "offset 14, length 24"

        # Encrypted original pattern (AES-256-GCM)
        encryptedPattern: "U2FsdGVkX1+vupppZksvRf5pq5g5XjFRlipRkwB0K1Y="
        algorithm: aes-256-gcm
        iv: "5c3a3b8e9f4c7d2e1a6b9c8d"

        # Safety instruction embedded
        safetyInstruction: "DO NOT EXECUTE - This is a malicious pattern for detection purposes only"
```

#### Encryption Details

**Algorithm:** AES-256-GCM (Authenticated Encryption)
- Industry standard
- Provides both confidentiality and integrity
- Prevents tampering

**Key Derivation:**
```typescript
// Derive encryption key from system secret + memory-specific salt
const key = crypto.pbkdf2Sync(
  SYSTEM_SECRET,           // Environment variable
  memory.id + pattern.ref, // Unique per pattern
  100000,                  // Iterations
  32,                      // Key length (256 bits)
  'sha256'
);
```

**Why This Works:**
- System secret unique per installation
- Pattern ref makes each key unique
- No keys stored in file
- Keys regenerated on demand

### Layer 4: Proxy Re-Encryption Transfer Protocol

When transferring memories between systems (User A → User B or User → Collection):

```
Step 1: User B receives memory file
  Has: Encrypt(pattern, Key_A)
  Metadata indicates encrypted chunks

Step 2: User B re-encrypts WITHOUT decrypting
  Result: Encrypt(Encrypt(pattern, Key_A), Key_B)
  Pattern now double-encrypted

Step 3: User A sends Key_A via secure channel
  Separate from file transfer

Step 4: User B decrypts User A's layer
  Decrypt(outer_layer, Key_A)
  Result: Encrypt(pattern, Key_B)

Step 5: User B securely deletes Key_A
  Now owns: Encrypt(pattern, Key_B)
  Full control with own key
```

**Security Properties:**
- ✅ Pattern never unencrypted during transfer
- ✅ No centralized key management
- ✅ Each system controls own keys
- ✅ Collection can validate (receives key after handoff)
- ✅ Portable files work across systems

**Technical Basis:** This is **Proxy Re-Encryption (PRE)**, an established cryptographic technique used in:
- Cloud storage (Dropbox, Google Drive)
- Blockchain data sharing
- Secure email forwarding
- Enterprise data protection

### Layer 5: Display & Retrieval

#### Default Display (Sanitized)

```typescript
Memory.content getter:

if (entry.trustLevel === 'VALIDATED') {
  return entry.content  // Full content
}

if (entry.trustLevel === 'UNTRUSTED') {
  throw Error("Memory needs validation before display")
}

if (entry.trustLevel === 'FLAGGED') {
  if (config.allowDangerousPatterns) {
    return entry.content + "\n\n⚠️ WARNING: Contains encrypted dangerous patterns"
  } else {
    return entry.sanitizedContent || entry.content  // Safe version
  }
}

if (entry.trustLevel === 'QUARANTINED') {
  throw Error("Quarantined memory cannot be loaded")
}
```

#### Explicit Pattern Retrieval

```typescript
// Requires explicit permission and safety context
async getPatternWithSafety(memoryId: string, patternRef: string, confirmToken: string) {
  // Verify confirmation token (prevents accidental calls)
  if (!validateConfirmToken(confirmToken)) {
    throw Error("Invalid confirmation token")
  }

  // Check configuration
  if (!config.allowDangerousPatternDecryption) {
    throw Error("Dangerous pattern decryption disabled in config")
  }

  // Get encrypted pattern
  const pattern = await getEncryptedPattern(memoryId, patternRef);

  // Decrypt using local key
  const decrypted = await decryptPattern(pattern);

  // Return with safety wrapper
  return `
⚠️  SECURITY PATTERN - FOR REFERENCE ONLY
DO NOT EXECUTE - This is a malicious pattern for detection purposes only

Description: ${pattern.description}
Severity: ${pattern.severity}
Pattern: ${decrypted}

This pattern should only be used for:
- Security validation code
- Pattern detection rules
- Documentation purposes

Never use this in actual code execution.
  `;
}
```

### Layer 6: Load-Time Quarantine

```typescript
Memory.deserialize():

for (const entry of entries) {
  // Read trust level from metadata (already set by validation)
  const trustLevel = entry.trustLevel || TRUST_LEVELS.UNTRUSTED;

  if (trustLevel === TRUST_LEVELS.QUARANTINED) {
    // Don't load quarantined entries
    quarantinedCount++;
    logger.warn(`Skipping quarantined entry: ${entry.id}`);
    continue;
  }

  // Load all other entries (VALIDATED, UNTRUSTED, FLAGGED)
  this.entries.set(entry.id, entry);
}

if (quarantinedCount > 0) {
  logger.warn(`Quarantined ${quarantinedCount} entries from memory`);
}
```

## Configuration

### System-Level Settings

```yaml
# ~/.dollhouse/config.yaml
security:
  # Pattern decryption (default: false for safety)
  allowDangerousPatternDecryption: false

  # Require plan mode when decrypting (Claude Code specific)
  requirePlanModeForPatterns: true

  # Log all pattern access
  logPatternAccess: true

  # Background validation
  backgroundValidation:
    enabled: true
    intervalSeconds: 300  # Check every 5 minutes
    batchSize: 10         # Process 10 untrusted memories at a time
```

### Environment Variables

```bash
# System encryption secret (REQUIRED)
DOLLHOUSE_ENCRYPTION_SECRET="generated-secret-key-here"

# Optional: Disable validation for development
DOLLHOUSE_SKIP_VALIDATION=false
```

## Implementation Phases

### Phase 1: Trust Level Infrastructure ✅ PARTIAL
- [x] Trust level constants defined
- [x] Trust level field in MemoryEntry
- [ ] FLAGGED trust level (needs adding)
- [ ] Background validation service
- [ ] Pattern extraction logic

### Phase 2: Encryption System
- [ ] AES-256-GCM encryption utilities
- [ ] Key derivation from system secret
- [ ] Pattern encryption in validation
- [ ] Pattern decryption with safety wrapper
- [ ] Sanitized content generation

### Phase 3: Proxy Re-Encryption
- [ ] Transfer protocol implementation
- [ ] Double-encryption handoff
- [ ] Key exchange mechanism
- [ ] Collection integration
- [ ] Portfolio sync updates

### Phase 4: Display & Configuration
- [ ] Trust-based display logic
- [ ] Explicit decryption tool
- [ ] Configuration system
- [ ] Plan mode integration (Claude Code)
- [ ] Audit logging

## What Needs to Change from PR #1313

### ❌ Remove: Blocking Validation

**Current Code (lines 342-357 in Memory.ts):**
```typescript
if (isCriticalThreat) {
  this.logSecurityThreat(validationResult, content);
  throw new Error(  // ❌ BLOCKS memory creation
    `Cannot add memory content: ${validationResult.severity} security threat...`
  );
}
```

**New Code:**
```typescript
if (isCriticalThreat) {
  this.logSecurityThreat(validationResult, content);
  logger.info('Memory created with threat detected - marked UNTRUSTED', {
    patterns: validationResult.detectedPatterns
  });
  // Don't throw - just log and mark as UNTRUSTED
}
```

### ✅ Keep: Telemetry & Logging

- SecurityTelemetry class is excellent - keep all of it
- Logging infrastructure works perfectly
- Pattern detection is accurate - just needs different handling

### ➕ Add: Missing Components

1. **FLAGGED trust level**
2. **Background validation service**
3. **Pattern encryption utilities**
4. **Sanitized content generation**
5. **Proxy re-encryption protocol**
6. **Explicit decryption tool**

## Testing Strategy

### Unit Tests Needed

1. **Trust level transitions**
   - UNTRUSTED → VALIDATED (clean content)
   - UNTRUSTED → FLAGGED (patterns detected)
   - UNTRUSTED → QUARANTINED (critical threat)

2. **Pattern encryption**
   - Encrypt patterns with AES-256-GCM
   - Decrypt with correct key
   - Fail decrypt with wrong key
   - Verify no plaintext in encrypted output

3. **Sanitized content generation**
   - Replace patterns with descriptions
   - Maintain content structure
   - Preserve non-pattern content
   - Reconstruct from encrypted patterns

4. **Proxy re-encryption**
   - Double-encrypt handoff
   - Key exchange protocol
   - Pattern stays encrypted throughout
   - Each system controls own keys

### Integration Tests Needed

1. **End-to-end memory lifecycle**
   - Create → Validate → Display → Transfer → Reload

2. **Multi-agent scenario**
   - Agent A creates memory with pattern
   - Background validation flags it
   - Agent B reads sanitized version
   - Agent C explicitly decrypts (with permission)

3. **Collection round-trip**
   - User A creates flagged memory
   - Uploads to collection (proxy re-encrypt)
   - User B downloads
   - User B can decrypt with own key

## Security Audit Checklist

- [ ] No patterns stored in plaintext anywhere
- [ ] Encryption keys never in files
- [ ] Pattern never unencrypted during transfer
- [ ] LLMs can't accidentally see dangerous patterns
- [ ] Agents can't accidentally execute patterns
- [ ] Explicit confirmation required for decryption
- [ ] Audit log of all pattern access
- [ ] Configuration allows locking down decryption
- [ ] Works across different MCP clients
- [ ] Portable files maintain security

## References

### Cryptographic Techniques
- **Proxy Re-Encryption (PRE)**: Wikipedia, academic papers
- **Envelope Encryption**: AWS KMS, Google Cloud KMS
- **AES-256-GCM**: NIST standard for authenticated encryption

### Security Standards
- **YARA Format**: Industry standard for malware signatures
- **OWASP Cryptographic Storage**: Best practices guide
- **MCP Security**: Model Context Protocol security considerations

## Glossary

- **Trust Level**: Classification of memory content safety
- **Proxy Re-Encryption**: Cryptographic technique for secure data transfer
- **Envelope Encryption**: Layered encryption with data keys and master keys
- **Sanitized Content**: Version with patterns replaced by descriptions
- **Pattern Encryption**: AES-256-GCM encryption of dangerous patterns
- **Background Validation**: Server-side async validation outside LLM context

---

**Document Version**: 1.0
**Last Updated**: October 10, 2025
**Next Review**: After Phase 1 implementation
