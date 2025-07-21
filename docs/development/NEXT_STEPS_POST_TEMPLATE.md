# Next Steps After Template Implementation

**Date**: July 21, 2025  
**Context**: Template element merged, ready for next element type

## Immediate Next Session Tasks

1. **Verify PR Merges**
   ```bash
   gh pr list --author @me --state merged --limit 5
   ```

2. **Check for New Issues**
   ```bash
   gh issue list --limit 10
   ```

## Next Element Implementation Priority

Based on complexity and dependencies:

### 1. Agents (Recommended Next)
**Why**: Most complex, good to tackle early
**Key Features**:
- Goal management system
- Decision frameworks (Eisenhower matrix)
- State persistence
- Risk assessment

**Implementation Checklist**:
```bash
# Create branch
git checkout main
git pull
git checkout -b feature/agent-element-implementation

# Create structure
mkdir -p src/elements/agents
touch src/elements/agents/Agent.ts
touch src/elements/agents/AgentManager.ts
touch src/elements/agents/index.ts
mkdir -p test/__tests__/unit/elements/agents
```

### 2. Memories (Alternative)
**Why**: Simpler, focused on storage
**Key Features**:
- Multiple storage backends
- Retention policies
- Search capabilities

### 3. Ensembles (Do Last)
**Why**: Depends on other elements existing
**Key Features**:
- Orchestration of multiple elements
- Activation strategies

## Security Patterns to Follow

From Template implementation:

1. **Input Validation**
   ```typescript
   const sanitizedInput = sanitizeInput(
     UnicodeValidator.normalize(input).normalizedContent, 
     maxLength
   );
   ```

2. **Memory Limits**
   ```typescript
   private readonly MAX_ITEMS = 100;
   private readonly MAX_SIZE = 100 * 1024; // 100KB
   ```

3. **Path Validation**
   ```typescript
   if (normalized.includes('..') || path.isAbsolute(normalized)) {
     throw new Error('Invalid path');
   }
   ```

4. **Audit Logging**
   ```typescript
   SecurityMonitor.logSecurityEvent({
     type: 'AGENT_ACTIVATED',
     severity: 'LOW',
     source: 'Agent.activate',
     details: `Agent ${this.metadata.name} activated`
   });
   ```

## Testing Requirements

For each element:
1. **Unit tests**: Minimum 15 like PersonaElement
2. **Security tests**: Injection, traversal, DoS
3. **Integration tests**: With other elements
4. **Platform tests**: Windows path compatibility

## Documentation Requirements

Per `SECURITY_FIX_DOCUMENTATION_PROCEDURE.md`:
1. Header comment with all security measures
2. Inline comments for each security fix
3. Before/after examples
4. Clear rationale for each measure

## PR Strategy

Per `EFFECTIVE_PR_REVIEW_PROCESS.md`:
1. Implement all security fixes first
2. Push code and comment together
3. Include commit SHA in comment
4. Provide grep/test evidence
5. Address CI failures immediately

## Reference PRs
- **PR #319**: Element interface foundation
- **PR #331**: Template implementation example
- **PR #332**: Security suppression patterns
- **PR #333**: PR review documentation

## Quick Reference Commands

```bash
# Start new element
git checkout -b feature/[element]-element-implementation

# Run tests for specific element
npm test -- test/__tests__/unit/elements/[element]/ --no-coverage

# Check security
npm run security:audit

# Build
npm run build

# Create PR with full context
gh pr create --title "Implement [Element] element type with security" \
  --body "$(cat docs/pr-template.md)"
```

## Success Metrics
- [ ] All tests passing
- [ ] Security audit clean
- [ ] Windows CI passing
- [ ] Comprehensive inline documentation
- [ ] PR approved on first review

Keep this document handy for the next element implementation!