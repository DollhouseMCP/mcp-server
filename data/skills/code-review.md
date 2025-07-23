---
name: "Code Review"
description: "Systematic code analysis for quality, security, and best practices"
type: "skill"
version: "1.0.0"
author: "DollhouseMCP"
created: "2025-07-23"
category: "development"
tags: ["code-quality", "security", "best-practices", "review"]
proficiency_levels:
  beginner: "Basic syntax and style checking"
  intermediate: "Design patterns and architecture review"
  advanced: "Security vulnerabilities and performance optimization"
parameters:
  language:
    type: "string"
    description: "Programming language to review"
    required: false
    default: "auto-detect"
  focus_areas:
    type: "array"
    description: "Specific areas to focus on"
    default: ["security", "performance", "maintainability", "testing"]
  severity_threshold:
    type: "string"
    description: "Minimum severity to report"
    default: "info"
    enum: ["error", "warning", "info", "style"]
---

# Code Review Skill

This skill provides systematic code analysis capabilities for identifying issues, suggesting improvements, and ensuring code quality.

## Core Capabilities

### 1. Security Analysis
- SQL injection vulnerabilities
- XSS and CSRF risks
- Authentication/authorization flaws
- Sensitive data exposure
- Dependency vulnerabilities

### 2. Code Quality
- SOLID principles adherence
- Design pattern usage
- Code duplication detection
- Complexity analysis
- Naming conventions

### 3. Performance Review
- Algorithm efficiency
- Database query optimization
- Memory usage patterns
- Caching opportunities
- Async/await patterns

### 4. Best Practices
- Error handling patterns
- Logging practices
- Documentation completeness
- Test coverage analysis
- Configuration management

## Review Process

### Step 1: Initial Scan
Quick overview identifying:
- Language and framework
- Project structure
- Key dependencies
- Test presence

### Step 2: Deep Analysis
Detailed examination of:
- Critical paths
- Security boundaries
- Data flow
- Error scenarios

### Step 3: Recommendations
Prioritized suggestions for:
- Critical fixes (security/bugs)
- Important improvements
- Nice-to-have enhancements
- Future considerations

## Output Format

Reviews are structured as:
1. **Executive Summary** - High-level findings
2. **Critical Issues** - Must-fix problems
3. **Recommendations** - Suggested improvements
4. **Positive Findings** - What's done well
5. **Metrics** - Code quality scores

## Example Usage

When activated, this skill enhances the AI's ability to:
- Spot subtle bugs and vulnerabilities
- Suggest idiomatic improvements
- Identify performance bottlenecks
- Recommend testing strategies
- Ensure security best practices

## Integration Notes

This skill works well with:
- Debug Detective persona for deep debugging
- Technical Analyst persona for architecture review
- Security-focused agents for vulnerability scanning
- Documentation templates for review reports