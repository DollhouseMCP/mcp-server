# Migration Guide: From Personas to Portfolio

This guide helps users upgrade from the original personas-only system to the new portfolio system with multiple element types.

## Overview

DollhouseMCP has evolved from a persona management tool to a comprehensive AI portfolio system. The good news: **your existing personas will continue to work without any changes required**.

### What's New?
- 🎯 **Multiple Element Types**: Beyond personas - skills, templates, agents, memories, and ensembles
- 🛠️ **Generic Tools**: New MCP tools that work with all element types
- 📁 **Portfolio Structure**: Organized directory system for all elements
- ✨ **Enhanced Features**: Ratings, feedback, and cross-element references

### What's Preserved?
- ✅ All existing personas remain functional
- ✅ Persona-specific tools still work (deprecated but functional)
- ✅ File format unchanged
- ✅ No data loss during migration

## Migration Paths

### Option 1: Automatic Migration (Recommended)
The system automatically migrates your personas on first run:

1. **Start the updated server**
   ```bash
   npm install @dollhousemcp/mcp-server@latest
   npm run build
   npm run start
   ```

2. **Automatic migration occurs**
   - Old location: `~/.dollhouse/personas/`
   - New location: `~/.dollhouse/portfolio/persona/`
   - Original files are preserved

3. **Verify migration**
   ```bash
   # In Claude Desktop
   list_elements --type persona
   ```

### Option 2: Manual Migration
If you prefer manual control:

1. **Create portfolio structure**
   ```bash
   mkdir -p ~/.dollhouse/portfolio/persona
   mkdir -p ~/.dollhouse/portfolio/skill
   mkdir -p ~/.dollhouse/portfolio/template
   mkdir -p ~/.dollhouse/portfolio/agent
   ```

2. **Copy personas**
   ```bash
   cp ~/.dollhouse/personas/*.md ~/.dollhouse/portfolio/persona/
   ```

3. **Verify files**
   ```bash
   ls ~/.dollhouse/portfolio/persona/
   ```

### Option 3: Clean Start
Start fresh with the new system:

1. **Backup existing personas**
   ```bash
   cp -r ~/.dollhouse/personas ~/.dollhouse/personas.backup
   ```

2. **Remove old directory**
   ```bash
   rm -rf ~/.dollhouse/personas
   ```

3. **Let system create new structure**
   The portfolio directory will be created on first use

## Directory Structure Changes

### Before (Personas Only)
```
~/.dollhouse/
└── personas/
    ├── creative-writer.md
    ├── code-reviewer.md
    └── teacher.md
```

### After (Full Portfolio)
```
~/.dollhouse/
├── personas/           # Old location (deprecated)
└── portfolio/         # New location
    ├── persona/       # Your personas move here
    │   ├── creative-writer.md
    │   ├── code-reviewer.md
    │   └── teacher.md
    ├── skill/         # New: discrete capabilities
    ├── template/      # New: reusable templates
    ├── agent/         # New: autonomous agents
    │   └── .state/    # Agent state files
    ├── memory/        # New: persistent storage
    │   └── .storage/  # Memory data files
    └── ensemble/      # New: element groups
```

## Tool Changes

### Deprecated Tools (Still Work)
These tools continue to function but are deprecated:
- `list_personas` → Use `list_elements --type persona`
- `activate_persona` → Use `activate_element --type persona`
- `deactivate_persona` → Use `deactivate_element --type persona`
- `get_active_persona` → Use `get_active_elements --type persona`
- `get_persona_details` → Use `get_element_details --type persona`
- `reload_personas` → Use `reload_elements --type persona`

### New Generic Tools
These tools work with all element types:
- `list_elements --type [element_type]`
- `create_element --type [element_type]`
- `edit_element --type [element_type]`
- `delete_element --type [element_type]`
- `validate_element --type [element_type]`
- `activate_element --type [element_type]`
- `deactivate_element --type [element_type]`
- `get_element_details --type [element_type]`

### Type-Specific Tools
Some elements have specialized tools:
- `render_template` - For templates only
- `execute_agent` - For agents only

## Updating Your Workflow

### Old Workflow
```bash
# List personas
list_personas

# Activate a persona
activate_persona "Creative Writer"

# Create new persona
create_persona "Data Analyst" "Expert in data" "technical" "You are a data analyst..."
```

### New Workflow
```bash
# List any element type
list_elements --type persona
list_elements --type skill
list_elements --type template

# Activate any element
activate_element "Creative Writer" --type persona
activate_element "Code Reviewer" --type skill

# Create any element
create_element --type persona --name "Data Analyst" --description "Expert in data"
create_element --type skill --name "Python Expert" --description "Python programming"
```

## Backward Compatibility

### What Still Works
1. **All persona files**: No changes needed to existing files
2. **Persona tools**: Old commands continue to function
3. **File format**: Same YAML frontmatter + markdown
4. **Triggers**: Activation triggers work as before
5. **Categories**: Existing categories preserved

### What's Enhanced
1. **Generic tools**: More flexible and powerful
2. **Validation**: Improved error checking
3. **Ratings**: AI and user feedback system
4. **References**: Link between elements
5. **Security**: Enhanced input validation

### Breaking Changes
None! The migration is designed to be seamless.

## Taking Advantage of New Features

### 1. Create Skills
Enhance your AI with specific capabilities:
```bash
create_element --type skill \
  --name "Code Reviewer" \
  --description "Reviews code for quality and security" \
  --content "I review code focusing on..."
```

### 2. Build Templates
Create reusable content structures:
```bash
create_element --type template \
  --name "Bug Report" \
  --description "Standardized bug report format" \
  --content "## Bug Report\n**Summary**: {{summary}}..."
```

### 3. Deploy Agents
Add autonomous capabilities:
```bash
create_element --type agent \
  --name "Project Manager" \
  --description "Manages project tasks autonomously" \
  --metadata '{"goals": {"primary": "Deliver on time"}}'
```

### 4. Combine with Ensembles
Create powerful combinations:
```bash
create_element --type ensemble \
  --name "Full Stack Developer" \
  --description "Complete development capabilities" \
  --metadata '{"members": [
    {"type": "persona", "ref": "professional-developer"},
    {"type": "skill", "ref": "frontend-development"},
    {"type": "skill", "ref": "backend-development"}
  ]}'
```

## Environment Variables

### New Variables
- `DOLLHOUSE_PORTFOLIO_DIR`: Custom portfolio location (default: `~/.dollhouse/portfolio`)

### Existing Variables (Still Work)
- `DOLLHOUSE_USER`: Your username for attribution
- `DOLLHOUSE_EMAIL`: Your email for contact

## Troubleshooting

### Common Issues

#### 1. Personas Not Found
**Problem**: `list_personas` returns empty
**Solution**: Check if migration completed:
```bash
ls ~/.dollhouse/portfolio/persona/
```

#### 2. Old Tools Not Working
**Problem**: Deprecated tools fail
**Solution**: Update to new generic tools:
```bash
# Instead of: list_personas
list_elements --type persona
```

#### 3. Migration Didn't Run
**Problem**: Personas still in old location
**Solution**: Manually trigger migration or copy files

#### 4. Permission Errors
**Problem**: Can't access portfolio directory
**Solution**: Check directory permissions:
```bash
chmod -R u+rw ~/.dollhouse/portfolio
```

### Getting Help
1. Check the logs for migration status
2. Verify file locations
3. Try manual migration
4. Report issues on GitHub

## Best Practices

### Do's
- ✅ Use generic tools for new workflows
- ✅ Explore new element types
- ✅ Take advantage of ratings/feedback
- ✅ Organize elements by type
- ✅ Create ensembles for complex needs

### Don'ts
- ❌ Don't modify the portfolio structure manually
- ❌ Don't mix old and new directory structures
- ❌ Don't rely on deprecated tools long-term
- ❌ Don't skip the migration backup
- ❌ Don't edit element type directories

## Migration Checklist

- [ ] Backup existing personas
- [ ] Update to latest version
- [ ] Run the server to trigger migration
- [ ] Verify personas in new location
- [ ] Test with generic tools
- [ ] Explore new element types
- [ ] Update any scripts/automation
- [ ] Remove old personas directory (optional)

## Next Steps

After migration:
1. **Explore Skills**: Add specific capabilities
2. **Create Templates**: Build reusable structures
3. **Try Agents**: Experiment with automation
4. **Build Ensembles**: Combine elements
5. **Share Elements**: Contribute to marketplace

## FAQ

### Q: Will my personas stop working?
**A**: No, all personas continue to work exactly as before.

### Q: Do I need to update my personas?
**A**: No updates required. The format hasn't changed.

### Q: Can I use both old and new tools?
**A**: Yes, but we recommend transitioning to generic tools.

### Q: What happens to my custom categories?
**A**: All categories are preserved during migration.

### Q: Can I reverse the migration?
**A**: Yes, your original files are preserved in the old location.

### Q: Do I need to migrate immediately?
**A**: No rush - the system handles both structures.

## Summary

The migration from personas to portfolio is designed to be seamless and non-disruptive. Your existing personas continue to work while you gain access to powerful new element types and tools. The automatic migration handles the transition, and backward compatibility ensures nothing breaks.

Welcome to the future of AI customization with DollhouseMCP Portfolio System! 🎉