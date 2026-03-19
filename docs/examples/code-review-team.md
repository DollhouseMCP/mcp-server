---
name: Code Review Team
description: Comprehensive code review workflow with technical analysis, security auditing, and documentation
version: 1.0.0
author: DollhouseMCP
created: 2025-01-15T00:00:00.000Z
tags:
  - code-review
  - development
  - security
  - documentation

# Activation settings
activationStrategy: sequential
conflictResolution: last-write
contextSharing: full

# Resource limits
resourceLimits:
  maxActiveElements: 10
  maxExecutionTimeMs: 60000

# Elements in this ensemble (sequential with dependencies)
elements:
  - name: technical-analyst
    type: persona
    role: primary
    priority: 100
    activation: always
    purpose: Initial technical analysis and code structure review

  - name: code-reviewer
    type: skill
    role: primary
    priority: 90
    activation: always
    dependencies:
      - technical-analyst
    purpose: Detailed code review with best practices check

  - name: security-auditor
    type: persona
    role: support
    priority: 85
    activation: always
    dependencies:
      - code-reviewer
    purpose: Security vulnerability analysis and threat detection

  - name: documentation-writer
    type: skill
    role: support
    priority: 80
    activation: always
    dependencies:
      - code-reviewer
    purpose: Generate or update documentation based on code changes
---

# Code Review Team Ensemble

A comprehensive code review ensemble that coordinates multiple specialists to provide thorough analysis of code changes. This ensemble uses **sequential activation** with dependencies to ensure each review stage builds on the previous one.

## Workflow

This ensemble follows a structured review pipeline:

1. **Technical Analyst** (runs first)
   - Performs initial code structure analysis
   - Identifies architectural patterns and anti-patterns
   - Sets context for downstream reviewers

2. **Code Reviewer** (depends on Technical Analyst)
   - Detailed line-by-line review
   - Checks coding standards and best practices
   - Identifies potential bugs and improvements

3. **Security Auditor** (depends on Code Reviewer)
   - Scans for security vulnerabilities
   - Validates input sanitization and authentication
   - Checks for common security flaws (SQL injection, XSS, etc.)

4. **Documentation Writer** (depends on Code Reviewer)
   - Updates or generates documentation
   - Ensures code comments are clear and accurate
   - Creates usage examples if needed

## Usage

Activate this ensemble when conducting code reviews:

```typescript
activate_element name="Code-Review-Team" type="ensembles"
```

The ensemble will activate all elements sequentially, ensuring each stage completes before the next begins.

## Configuration Notes

- **Strategy**: Sequential - Elements activate one by one in dependency order
- **Conflict Resolution**: Last-write - If multiple elements modify the same context, the last write wins
- **Context Sharing**: Full - All elements have access to the complete shared context
- **Timeout**: 60 seconds - Enough time for thorough analysis

## Best Practices

1. Use this ensemble for pull requests and major code changes
2. Review the output from each stage before proceeding
3. The sequential flow ensures comprehensive coverage without overlap
4. All findings are aggregated in the shared context

## Example Output

After activation, you'll receive:
- Technical architecture assessment
- Code quality metrics and suggestions
- Security vulnerability report
- Updated or new documentation

## Dependencies

This ensemble expects the following elements to exist in your portfolio:
- `technical-analyst` (persona)
- `code-reviewer` (skill)
- `security-auditor` (persona)
- `documentation-writer` (skill)
