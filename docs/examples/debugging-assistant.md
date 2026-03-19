---
name: Debugging Assistant
description: Adaptive debugging ensemble that activates specialized tools based on issue type (conditional activation)
version: 1.0.0
author: DollhouseMCP
created: 2025-01-15T00:00:00.000Z
tags:
  - debugging
  - performance
  - security
  - memory

# Activation settings
activationStrategy: conditional
conflictResolution: merge
contextSharing: full

# Resource limits
resourceLimits:
  maxActiveElements: 10
  maxExecutionTimeMs: 90000

# Elements in this ensemble (conditional activation based on issue type)
elements:
  - name: error-detective
    type: persona
    role: primary
    priority: 100
    activation: always
    purpose: Core debugging personality - always active for all issues

  - name: performance-profiler
    type: skill
    role: support
    priority: 90
    activation: conditional
    condition: "context.needs_performance == true"
    purpose: Performance analysis and optimization (only when performance issue detected)

  - name: security-scanner
    type: skill
    role: support
    priority: 85
    activation: conditional
    condition: "context.security_review == true"
    purpose: Security vulnerability scanning (only when security issue suspected)

  - name: memory-analyzer
    type: skill
    role: support
    priority: 80
    activation: conditional
    condition: "context.has_memory_leak == true"
    purpose: Memory leak detection and analysis (only when memory issue present)
---

# Debugging Assistant Ensemble

An intelligent debugging ensemble that adapts to different types of issues. This ensemble uses **conditional activation** to load only the tools you need based on the problem context.

## How It Works

### Core Element (Always Active)

**Error Detective** - Your primary debugging companion:
- Analyzes stack traces and error messages
- Identifies root causes
- Suggests debugging strategies
- Coordinates other specialized tools

### Conditional Elements (Activate on Demand)

The ensemble intelligently activates specialized tools based on the issue type:

1. **Performance Profiler** (when `context.needs_performance == true`)
   - CPU and execution time analysis
   - Bottleneck identification
   - Algorithm complexity review
   - Optimization recommendations

2. **Security Scanner** (when `context.security_review == true`)
   - Vulnerability detection
   - Input validation review
   - Authentication/authorization checks
   - Common exploit pattern matching

3. **Memory Analyzer** (when `context.has_memory_leak == true`)
   - Memory leak detection
   - Object retention analysis
   - Garbage collection monitoring
   - Memory usage optimization

## Usage

### Basic Debugging (All Issues)

```typescript
activate_element name="Debugging-Assistant" type="ensembles"
```

This activates only the Error Detective for general debugging.

### Performance Issue

```typescript
// Set context before activation
setContextValue("needs_performance", true, "user")
activate_element name="Debugging-Assistant" type="ensembles"
```

Activates Error Detective + Performance Profiler.

### Security Review

```typescript
// Set context before activation
setContextValue("security_review", true, "user")
activate_element name="Debugging-Assistant" type="ensembles"
```

Activates Error Detective + Security Scanner.

### Memory Leak Investigation

```typescript
// Set context before activation
setContextValue("has_memory_leak", true, "user")
activate_element name="Debugging-Assistant" type="ensembles"
```

Activates Error Detective + Memory Analyzer.

### Multiple Issues

```typescript
// Activate multiple specialized tools
setContextValue("needs_performance", true, "user")
setContextValue("has_memory_leak", true, "user")
activate_element name="Debugging-Assistant" type="ensembles"
```

Activates Error Detective + Performance Profiler + Memory Analyzer.

## Configuration Notes

- **Strategy**: Conditional - Elements activate based on context conditions
- **Conflict Resolution**: Merge - Multiple tools' findings are merged together
- **Context Sharing**: Full - All active elements share complete debugging context
- **Timeout**: 90 seconds - Enough time for deep analysis

## Important Note

**Condition Evaluation Status**: The conditional activation feature is not yet fully implemented in the ensemble system. Currently, **all conditional elements will activate** regardless of their conditions.

To control which elements activate:
- Use `activation: on-demand` instead of `activation: conditional`
- Manually activate specific elements as needed
- This limitation will be addressed in a future update

## Advantages of Conditional Strategy

When fully implemented, this approach offers:
1. **Resource Efficiency** - Only loads tools you need
2. **Faster Activation** - Fewer elements to initialize
3. **Focused Analysis** - Specialized tools for specific issues
4. **Flexible** - Easily adapt to different debugging scenarios

## Use Cases

Perfect for:
- General error debugging (always)
- Performance bottlenecks (conditional)
- Security vulnerability research (conditional)
- Memory leak investigation (conditional)
- Production issue diagnosis
- Code optimization

## Dependencies

This ensemble expects the following elements to exist in your portfolio:
- `error-detective` (persona) - Required
- `performance-profiler` (skill) - Optional, activated conditionally
- `security-scanner` (skill) - Optional, activated conditionally
- `memory-analyzer` (skill) - Optional, activated conditionally

## Tips

1. Set context flags before activating the ensemble
2. The Error Detective is always active - your debugging starting point
3. Merge conflict resolution combines findings from multiple tools
4. Full context sharing lets all tools see the complete picture
5. As a workaround for the condition limitation, create separate ensembles for specific debugging scenarios
