# PersonaTools Migration Guide

**Date**: August 19, 2025  
**Version**: v1.6.0+  
**Breaking Change**: PersonaTools Partial Removal

## Overview

In DollhouseMCP v1.6.0, we've streamlined the API by removing 9 redundant PersonaTools that had exact equivalents in the generic ElementTools system. This change reduces the total tool count from **51 to 42 tools** and provides a cleaner, more consistent API.

## What Changed

### Tools Removed (9)

The following PersonaTools have been **permanently removed**:

| Removed Tool | Status | ElementTools Equivalent |
|-------------|--------|------------------------|
| `list_personas` | ❌ **REMOVED** | `list_elements type="personas"` |
| `activate_persona` | ❌ **REMOVED** | `activate_element name="name" type="personas"` |
| `get_active_persona` | ❌ **REMOVED** | `get_active_elements type="personas"` |
| `deactivate_persona` | ❌ **REMOVED** | `deactivate_element type="personas"` |
| `get_persona_details` | ❌ **REMOVED** | `get_element_details name="name" type="personas"` |
| `reload_personas` | ❌ **REMOVED** | `reload_elements type="personas"` |
| `create_persona` | ❌ **REMOVED** | Use ElementTools or server methods |
| `edit_persona` | ❌ **REMOVED** | Use ElementTools or server methods |
| `validate_persona` | ❌ **REMOVED** | Use ElementTools or server methods |

### Tools Preserved (5)

These PersonaTools remain **fully functional** as they provide unique functionality not yet available in ElementTools:

| Preserved Tool | Status | Purpose |
|---------------|--------|---------|
| `export_persona` | ✅ **AVAILABLE** | Export single persona to JSON format |
| `export_all_personas` | ✅ **AVAILABLE** | Export all personas to JSON bundle |
| `import_persona` | ✅ **AVAILABLE** | Import persona from file path or JSON string |
| `share_persona` | ✅ **AVAILABLE** | Generate shareable URL for persona |
| `import_from_url` | ✅ **AVAILABLE** | Import persona from shared URL |

## Migration Instructions

### Quick Reference - Before & After

#### Listing Personas
```bash
# Before (REMOVED)
list_personas

# After (NEW)
list_elements type="personas"
```

#### Activating a Persona
```bash
# Before (REMOVED)
activate_persona persona="creative-writer"

# After (NEW)
activate_element name="creative-writer" type="personas"
```

#### Getting Active Persona
```bash
# Before (REMOVED)
get_active_persona

# After (NEW)
get_active_elements type="personas"
```

#### Deactivating Personas
```bash
# Before (REMOVED)
deactivate_persona

# After (NEW)
deactivate_element type="personas"
```

#### Getting Persona Details
```bash
# Before (REMOVED)
get_persona_details persona="creative-writer"

# After (NEW)
get_element_details name="creative-writer" type="personas"
```

#### Reloading Personas
```bash
# Before (REMOVED)
reload_personas

# After (NEW)
reload_elements type="personas"
```

### Advanced Migration Examples

#### Complete Workflow Migration

**Before (using removed PersonaTools)**:
```bash
# List personas
list_personas

# Activate a persona
activate_persona persona="technical-analyst"

# Get current persona
get_active_persona

# View persona details
get_persona_details persona="technical-analyst"

# Deactivate
deactivate_persona

# Reload if needed
reload_personas
```

**After (using ElementTools)**:
```bash
# List personas
list_elements type="personas"

# Activate a persona
activate_element name="technical-analyst" type="personas"

# Get current active personas
get_active_elements type="personas"

# View persona details
get_element_details name="technical-analyst" type="personas"

# Deactivate
deactivate_element type="personas"

# Reload if needed
reload_elements type="personas"
```

#### Multi-Element Workflow (NEW Capability)

The ElementTools system allows you to work with multiple element types consistently:

```bash
# List all your element types
list_elements type="personas"
list_elements type="skills"
list_elements type="templates"
list_elements type="agents"

# Activate elements from different types
activate_element name="code-reviewer" type="skills"
activate_element name="professional" type="personas"
activate_element name="email-format" type="templates"

# View all active elements at once
get_active_elements

# View active elements by type
get_active_elements type="skills"
get_active_elements type="personas"

# Deactivate specific elements
deactivate_element name="code-reviewer" type="skills"
deactivate_element type="personas"  # Deactivates all personas
```

### Export/Import Workflows (Unchanged)

These workflows continue to work exactly as before:

```bash
# Export a single persona
export_persona persona="my-custom-persona"

# Export all personas
export_all_personas includeDefaults=true

# Import from file
import_persona source="/path/to/persona.md" overwrite=false

# Share a persona
share_persona persona="my-persona" expiryDays=7

# Import from shared URL
import_from_url url="https://shared-url" overwrite=false
```

## What You Need to Do

### 1. Update Your Scripts and Workflows

If you have scripts, documentation, or workflows that use the removed tools, update them to use the ElementTools equivalents.

### 2. Update Any Documentation References

Replace references to removed tools in your documentation with the new ElementTools syntax.

### 3. Test Your Workflows

Verify that your migrated workflows function correctly with the new tool names and parameter syntax.

## Benefits of the Migration

### 1. **Consistent API**
- All element types (personas, skills, templates, agents, etc.) use the same command structure
- Easier to learn and remember tool names
- Consistent parameter naming across all element types

### 2. **Reduced Complexity**
- 9 fewer tools to learn and maintain
- Cleaner tool list (42 instead of 51 tools)
- Less API surface area reduces potential for bugs

### 3. **Future-Proof**
- New element types automatically work with existing ElementTools
- No need to create type-specific tools for new element types
- Easier to add new functionality across all element types

### 4. **Better User Experience**
- More intuitive command structure
- Multi-type operations in single commands
- Consistent behavior across all element types

## Backward Compatibility

**⚠️ Important**: This is a **breaking change**. The removed tools are completely unavailable and will return "tool not found" errors if used.

**No backward compatibility aliases** are provided for the removed tools, as they were functionally identical to existing ElementTools.

## Support and Migration Help

### Common Migration Issues

**Issue**: "Tool not found" errors for removed PersonaTools  
**Solution**: Replace with ElementTools equivalent from the migration table above

**Issue**: Different parameter names between old and new tools  
**Solution**: Update parameter names:
- `persona="name"` → `name="name" type="personas"`
- Most other parameters remain the same

**Issue**: Workflows that relied on persona-specific behavior  
**Solution**: ElementTools provide identical functionality - no behavior changes

### Getting Help

- **GitHub Issues**: [Report migration problems](https://github.com/DollhouseMCP/mcp-server/issues)
- **Documentation**: [Element System Guide](ELEMENT_ARCHITECTURE.md)
- **API Reference**: [Complete Tool Documentation](API_REFERENCE.md)

## FAQ

### Q: Why were these tools removed?
**A**: They were functionally identical to ElementTools, creating unnecessary API duplication. The removal simplifies the API while maintaining all functionality.

### Q: Will the removed tools ever come back?
**A**: No, these tools are permanently removed. The ElementTools provide identical functionality with a more consistent API.

### Q: Are export/import tools affected?
**A**: No, all 5 export/import tools (`export_persona`, `export_all_personas`, `import_persona`, `share_persona`, `import_from_url`) remain fully functional and unchanged.

### Q: Do I need to migrate my persona files?
**A**: No, persona files and their format remain unchanged. Only the tools to interact with them have changed.

### Q: What about server methods?
**A**: All server methods (`server.createPersona()`, `server.listPersonas()`, etc.) remain unchanged. This change only affects MCP tools.

### Q: Will this break my Claude Desktop integration?
**A**: The removal might break workflows that use the removed tool names. Update your workflows to use ElementTools, and everything will work normally.

---

**🔄 Migration Complete**: You're now using the streamlined DollhouseMCP API with 42 consistent, powerful tools!