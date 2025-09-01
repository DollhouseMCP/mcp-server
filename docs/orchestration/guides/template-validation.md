# Template Validation Guide

## Purpose

Ensure all elements referenced in orchestration templates actually exist in the DollhouseMCP system before execution.

## Validation Checklist

### Pre-Orchestration Validation

#### 1. Verify Personas Exist

```bash
# Check if persona exists
ls ~/.dollhouse/portfolio/personas/alex-sterling.md
# OR
mcp__dollhousemcp-production__get_element_details "alex-sterling" type="personas"
```

#### 2. Verify Skills Exist

```bash
# Check available skills
mcp__dollhousemcp-production__list_elements type="skills"

# Verify specific skill
mcp__dollhousemcp-production__get_element_details "code-review" type="skills"
```

#### 3. Verify Agents Exist

For agents launched via Task tool, verify:
- The subagent_type is valid ("general-purpose", "statusline-setup", "output-style-setup")
- The Task tool is available
- Any referenced specialized agents are documented

#### 4. Verify Templates Exist

```bash
# Check template files
ls docs/orchestration/templates/*.md

# Specific template
test -f docs/orchestration/templates/coordination-template.md && echo "✅ Exists" || echo "❌ Not found"
```

## Validation Script

### Automated Validation

```bash
#!/bin/bash
# validate-orchestration.sh

echo "🔍 Validating Orchestration Elements..."

# Function to check element
check_element() {
    local element_name="$1"
    local element_type="$2"
    local element_path="$HOME/.dollhouse/portfolio/$element_type/$element_name.md"
    
    if [ -f "$element_path" ]; then
        echo "✅ $element_type/$element_name exists"
        return 0
    else
        echo "❌ $element_type/$element_name NOT FOUND"
        return 1
    fi
}

# Validate personas
echo "Checking Personas..."
check_element "alex-sterling" "personas"
check_element "verification-specialist" "personas"
check_element "session-notes-writer" "personas"

# Validate skills
echo "Checking Skills..."
check_element "code-review" "skills"
check_element "test-writer" "skills"

# Validate templates
echo "Checking Templates..."
for template in coordination-template task-tracker verification-checklist; do
    if [ -f "docs/orchestration/templates/$template.md" ]; then
        echo "✅ Template $template exists"
    else
        echo "❌ Template $template NOT FOUND"
    fi
done

# Check MCP tools
echo "Checking MCP Tools..."
if command -v mcp__dollhousemcp-production__list_elements &> /dev/null; then
    echo "✅ MCP tools available"
else
    echo "⚠️  MCP tools not directly accessible (normal in orchestration context)"
fi
```

## Common Validation Errors

### Error: Persona Not Found

**Problem**: Referenced persona doesn't exist
```bash
activate_element "fictional-persona" type="personas"
# Error: Element 'fictional-persona' not found
```

**Solution**: Use existing personas or create the persona first
```bash
# Check available personas
mcp__dollhousemcp-production__list_elements type="personas"

# Use existing one
activate_element "alex-sterling" type="personas"
```

### Error: Skill Not Available

**Problem**: Skill not implemented yet
```bash
activate_element "advanced-debugging" type="skills"
# Error: Element 'advanced-debugging' not found
```

**Solution**: Use available skills or implement the skill
```bash
# List available skills
ls ~/.dollhouse/portfolio/skills/

# Use available skill
activate_element "code-review" type="skills"
```

### Error: Invalid Agent Type

**Problem**: Using non-existent agent type
```bash
Task({
  subagent_type: "specialized-agent"  // Doesn't exist
})
```

**Solution**: Use valid agent types
```bash
Task({
  subagent_type: "general-purpose"  // Valid
})
```

## Validation in Templates

### Add Validation Section to Templates

```markdown
## Prerequisites Validation

### Required Elements
- [ ] Persona: alex-sterling (exists: yes/no)
- [ ] Skill: code-review (exists: yes/no)
- [ ] Template: verification-checklist.md (exists: yes/no)

### Validation Commands
```bash
# Run before orchestration
./validate-orchestration.sh
```
```

## Real Elements in DollhouseMCP

### Currently Available Personas
- alex-sterling
- verification-specialist
- session-notes-writer

### Currently Available Skills
- (Skills need to be created as part of element implementation)

### Available Agent Types (via Task tool)
- general-purpose
- statusline-setup
- output-style-setup

### Available Templates
- coordination-template.md
- task-tracker.md
- verification-checklist.md
- session-notes-template.md
- feature-implementation.md

## Integration with Orchestration

### Pre-Flight Check

Before starting any orchestration:

1. **List what you need**
```yaml
required_elements:
  personas:
    - alex-sterling
  skills:
    - code-review
  templates:
    - coordination-template
```

2. **Validate availability**
```bash
./validate-orchestration.sh
```

3. **Handle missing elements**
- Install from collection
- Create if needed
- Use alternatives

## Validation Metrics

Track validation success:
- Elements Found: X/Y
- Validation Time: X seconds
- Missing Elements: [list]
- Fallback Used: yes/no

---

*Always validate before orchestration to prevent runtime failures.*