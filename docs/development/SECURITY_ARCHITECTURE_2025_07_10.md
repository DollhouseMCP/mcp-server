# DollhouseMCP Security Architecture - July 10, 2025

## Overview
This document describes the complete security architecture implemented in DollhouseMCP following the security audit of July 9, 2025.

## Security Components

### 1. ContentValidator (`/src/security/contentValidator.ts`)
**Purpose**: First line of defense against prompt injection attacks

**Key Features**:
- 20+ regex patterns for injection detection
- Severity classification (low/medium/high/critical)
- YAML-specific pattern validation
- Metadata field validation
- Content sanitization with [CONTENT_BLOCKED] replacement

**Pattern Categories**:
- System prompt overrides: [SYSTEM:], [ADMIN:], [ASSISTANT:]
- Instruction manipulation: "ignore previous instructions"
- Data exfiltration: "export all files", "send all tokens"
- Command execution: curl, wget, eval, exec, $(), backticks
- Token patterns: ghp_*, gho_*
- Path traversal: ../../../
- YAML attacks: !!python/object, !!exec, !!eval, !!new, !!construct

### 2. SecurityMonitor (`/src/security/securityMonitor.ts`)
**Purpose**: Centralized security event logging and alerting

**Key Features**:
- Event logging with timestamps and unique IDs
- Severity-based alerting (critical events trigger alerts)
- Circular buffer (last 1000 events in memory)
- Security report generation
- Console-based alerts for critical events

**Event Types**:
- CONTENT_INJECTION_ATTEMPT
- YAML_INJECTION_ATTEMPT
- PATH_TRAVERSAL_ATTEMPT
- TOKEN_VALIDATION_FAILURE
- UPDATE_SECURITY_VIOLATION
- RATE_LIMIT_EXCEEDED
- YAML_PARSING_WARNING
- YAML_PARSE_SUCCESS

### 3. SecureYamlParser (`/src/security/secureYamlParser.ts`)
**Purpose**: Safe YAML parsing preventing deserialization attacks

**Key Features**:
- FAILSAFE_SCHEMA (only strings, no type coercion)
- Pre-validation before parsing
- Size limits (64KB YAML, 1MB content)
- Field-specific validators
- Gray-matter API compatibility
- Malicious pattern detection

**Protected Against**:
- Deserialization gadgets
- Constructor injection
- Code execution via YAML
- Type confusion attacks

### 4. SecurityError (`/src/errors/SecurityError.ts`)
**Purpose**: Specialized error handling for security violations

**Key Features**:
- Severity levels (low/medium/high/critical)
- Contextual error information
- Factory methods for common scenarios
- Integration with SecurityMonitor

## Security Layers

### Layer 1: Input Validation
- Path validation (no traversal)
- Filename sanitization
- Content size limits
- Character validation
- Username/email validation

### Layer 2: Content Analysis
- Pattern-based threat detection
- YAML pre-parsing validation
- Metadata field validation
- Injection attempt detection

### Layer 3: Safe Processing
- FAILSAFE_SCHEMA for YAML
- Sanitized content storage
- Secure error messages
- No sensitive data in logs

### Layer 4: Monitoring & Response
- Real-time event logging
- Critical event alerts
- Security metrics tracking
- Audit trail maintenance

## Integration Points

### Persona Operations
1. **Loading** (`PersonaLoader`)
   - SecureYamlParser.safeMatter()
   - Error handling for security threats
   - Skips malicious personas

2. **Installation** (`PersonaInstaller`)
   - Content validation before download
   - Secure parsing after download
   - Metadata validation
   - Sanitized storage

3. **Creation/Editing** (`create_persona`, `edit_persona`)
   - Input validation
   - Content sanitization
   - Metadata checks
   - Version bumping

4. **Marketplace** (`browse_marketplace`, `submit_persona`)
   - Content warnings for malicious personas
   - Submission blocking for threats
   - Safe viewing with sanitization

## Security Workflows

### Persona Installation Flow
```
User Request → Path Validation → GitHub Download → 
Content Validation → YAML Parsing → Metadata Validation → 
Sanitized Storage → Success Response
```

### Content Validation Flow
```
Raw Content → Size Check → Pattern Detection → 
Severity Assessment → Sanitization/Rejection → 
Event Logging → Result
```

### YAML Parsing Flow
```
YAML Content → Size Validation → Pattern Pre-check → 
FAILSAFE Parse → Type Validation → Field Validation → 
Safe Object
```

## Security Configurations

### Size Limits
- Max persona size: 2MB
- Max YAML size: 64KB
- Max content size: 1MB
- Max path length: 260 chars
- Max field lengths: Various (100-500 chars)

### Validation Rules
- Usernames: 3-20 chars, alphanumeric + dash/underscore
- Emails: RFC 5321 compliant
- Versions: Semantic versioning with pre-release
- Categories: Predefined list
- Prices: 'free' or $X.XX format

### Pattern Detection
- Case-insensitive matching
- Global pattern search
- Early exit on first match
- Severity-based handling

## Testing Strategy

### Security Test Coverage
1. **Injection Tests** (32+ tests)
   - All pattern types
   - Case variations
   - Encoding attempts
   - Edge cases

2. **YAML Security Tests** (33+ tests)
   - Deserialization attacks
   - Constructor injection
   - Malformed YAML
   - Size limits

3. **Integration Tests**
   - End-to-end workflows
   - Error handling
   - Security event logging
   - Performance impact

### Test Principles
- Positive and negative cases
- Edge case coverage
- Performance benchmarks
- Security regression tests

## Monitoring and Alerts

### Event Monitoring
- All security events logged
- Critical events trigger console alerts
- Event buffering for analysis
- Structured logging format

### Metrics Tracked
- Event counts by type
- Event frequency
- Pattern detection rates
- Performance metrics

### Alert Conditions
- Critical severity events
- Repeated attack attempts
- New pattern detections
- System errors

## Future Enhancements

### Planned Improvements
1. Unicode normalization (#162)
2. ReDoS protection (#163)
3. Enhanced YAML patterns (#164)
4. Input length validation (#165)
5. Persistent logging (#166)
6. Context-aware validation (#167)
7. Security dashboard (#168)
8. Rate limiting (#169)

### Research Areas
1. AI-assisted pattern discovery (#157)
2. Behavioral anomaly detection (#158)
3. AI transcription fingerprinting (#159)

## Security Posture Summary

**Current State**: Significantly enhanced security with multi-layered defenses

**Protected Against**:
- Prompt injection attacks
- YAML deserialization attacks
- Path traversal attempts
- Command execution attempts
- Data exfiltration attempts
- Token exposure

**Monitoring**: Comprehensive event logging and alerting

**Testing**: 65+ security-specific tests, 437 total tests

**Performance Impact**: Minimal (<100ms for typical operations)

This architecture provides defense-in-depth protection while maintaining usability and performance.