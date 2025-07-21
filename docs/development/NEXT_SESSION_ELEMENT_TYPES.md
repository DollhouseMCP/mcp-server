# Next Session: Implement Remaining Element Types

## Current Status
✅ **Foundation Complete**: PR #319 merged with element interface system
- BaseElement abstract class
- IElement interface  
- PersonaElement implementation
- Skill element type
- PersonaElementManager pattern
- Comprehensive security throughout

## Next Element Type: Templates

### Quick Start Commands
```bash
# Create new branch
git checkout main
git pull
git checkout -b feature/template-element-implementation

# Create Template element
mkdir -p src/elements/templates
touch src/elements/templates/Template.ts
touch src/elements/templates/TemplateManager.ts
touch test/__tests__/unit/elements/templates/Template.test.ts
```

### Template Element Structure
```typescript
// src/elements/templates/Template.ts
import { BaseElement } from '../BaseElement.js';
import { IElement, ElementValidationResult } from '../../types/elements/index.js';
import { ElementType } from '../../portfolio/types.js';

export interface TemplateMetadata extends IElementMetadata {
  variables?: TemplateVariable[];
  outputFormats?: string[];
  includes?: string[];  // Other templates to include
}

export class Template extends BaseElement implements IElement {
  public content: string;
  private compiledTemplate?: Function;
  
  constructor(metadata: Partial<TemplateMetadata>, content: string = '') {
    // IMPORTANT: Sanitize all inputs like in Skill.ts
    super(ElementType.TEMPLATE, metadata);
    this.content = content;
  }
  
  // Variable substitution engine
  render(variables: Record<string, any>): string {
    // Implementation with security validation
  }
}
```

### Security Requirements (MUST HAVE)
1. **Input Validation**: All template variables must be sanitized
2. **Template Injection Prevention**: No eval() or Function() constructor
3. **Secure Includes**: Validate template paths, prevent directory traversal
4. **Memory Limits**: Max template size, max variable count
5. **Audit Logging**: Log all template operations

### Copy These Patterns from Skill.ts
```typescript
// 1. Input sanitization in constructor
const sanitizedMetadata = {
  ...metadata,
  name: metadata.name ? sanitizeInput(UnicodeValidator.normalize(metadata.name).normalizedContent, 100) : undefined
};

// 2. Memory management constants
private readonly MAX_VARIABLES_COUNT = 100;
private readonly MAX_TEMPLATE_SIZE = 100000;

// 3. Validation with security logging
if (dangerous_pattern_detected) {
  SecurityMonitor.logSecurityEvent({
    type: 'TEMPLATE_INJECTION_ATTEMPT',
    severity: 'HIGH',
    source: 'Template.render',
    details: `Potential injection in template: ${this.metadata.name}`
  });
  throw new Error('Invalid template content');
}
```

## Implementation Order

### 1. Templates (Next - Easiest)
- Variable substitution without eval()
- Include system with path validation
- Multiple output formats (markdown, HTML, JSON)
- Tests: Variable injection, path traversal, memory limits

### 2. Agents (More Complex)
- Goal management system
- Decision frameworks
- State persistence
- Risk assessment
- Tests: State corruption, goal injection

### 3. Memories (Storage Focused)
- Multiple backends (file, memory, future: DB)
- Retention policies
- Search capabilities
- Privacy levels
- Tests: Data leakage, retention violations

### 4. Ensembles (Most Complex)
- Element orchestration
- Conflict resolution
- Activation strategies
- Nested ensembles
- Tests: Circular dependencies, resource limits

## Testing Strategy
For each element type:
1. Unit tests (like PersonaElement.test.ts)
2. Manager tests (CRUD operations)
3. Security tests (injection, traversal, DoS)
4. Integration tests (with other elements)

## Documentation Requirements
Follow the pattern from PR #319:
1. Header comment listing all security measures
2. Inline comments for each security fix
3. Before/after examples where applicable
4. Clear explanation of why each measure exists

## Git Workflow
```bash
# After implementing each element
git add -A
git commit -m "feat: Implement Template element with comprehensive security

- Variable substitution engine with injection prevention
- Secure template includes with path validation  
- Memory limits to prevent DoS attacks
- Full input sanitization and Unicode normalization
- Audit logging for security events
- 20 comprehensive tests including security scenarios

Security measures:
- No eval() or Function() constructor usage
- All inputs sanitized with UnicodeValidator
- Path traversal prevention for includes
- Template size limits (100KB max)
- Variable count limits (100 max)

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"

# Create PR
gh pr create --title "Implement Template element type with security" --body "[detailed description]"
```

## Reference These Files
- `/src/persona/PersonaElement.ts` - Element structure
- `/src/persona/PersonaElementManager.ts` - Manager pattern  
- `/src/elements/skills/Skill.ts` - Security patterns
- `/test/__tests__/unit/persona/PersonaElement.test.ts` - Test patterns

## Success Checklist
- [ ] Element extends BaseElement
- [ ] All inputs validated and sanitized
- [ ] Memory limits implemented
- [ ] Audit logging added
- [ ] Manager implements IElementManager
- [ ] Comprehensive tests (15+ like PersonaElement)
- [ ] Security tests for injection/traversal
- [ ] Inline documentation for all security measures
- [ ] No security audit failures