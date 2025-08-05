# DollhouseMCP API Reference

Complete reference for all MCP tools available in DollhouseMCP v1.5.0+

## Overview

DollhouseMCP provides 40+ MCP tools organized into these categories:
- **Generic Element Tools**: Work with all element types
- **Type-Specific Tools**: Specialized for certain elements
- **Collection Tools**: GitHub marketplace integration
- **User Management**: Identity and settings
- **GitHub Authentication**: OAuth device flow authentication
- **Legacy Persona Tools**: Backward compatibility

## Generic Element Tools

These tools work with all element types (persona, skill, template, agent, memory, ensemble).

### list_elements
Lists all available elements of a specific type.

**Parameters:**
- `type` (required): Element type - one of: `persona`, `skill`, `template`, `agent`, `memory`, `ensemble`

**Example:**
```bash
list_elements --type skill
```

**Response:**
```
🎯 Code Reviewer (skill)
   Reviews code for quality, security, and best practices
   📁 software-development | ⭐ 4.8 | 👤 dollhousemcp
   
🎯 Language Translator (skill)
   Translates between multiple languages
   📁 communication | ⭐ 4.5 | 👤 mickdarling
```

### create_element
Creates a new element of any type.

**Parameters:**
- `name` (required): Element name
- `type` (required): Element type
- `description` (required): Brief description
- `content` (optional): Element content/instructions
- `metadata` (optional): Additional metadata as JSON

**Examples:**
```bash
# Create a persona
create_element --type persona --name "Data Scientist" --description "Expert in data analysis and ML"

# Create a skill with parameters
create_element --type skill --name "API Helper" --description "Helps integrate APIs" \
  --metadata '{"parameters": [{"name": "apiType", "type": "string", "default": "REST"}]}'

# Create a template
create_element --type template --name "Sprint Report" --description "Weekly sprint template" \
  --content "# Sprint {{number}}\n\n## Completed\n{{#each tasks}}..."
```

### edit_element
Edits an existing element's properties.

**Parameters:**
- `name` (required): Element name to edit
- `type` (required): Element type
- `field` (required): Field path to edit (supports nested: `metadata.author`)
- `value` (required): New value for the field

**Examples:**
```bash
# Update description
edit_element "Code Reviewer" --type skill --field description --value "Advanced code analysis"

# Update nested metadata
edit_element "Sprint Report" --type template --field "metadata.version" --value "2.0.0"

# Update skill parameter
edit_element "API Helper" --type skill --field "parameters.apiType.default" --value "GraphQL"
```

### delete_element
Deletes an element and optionally its associated data files.

**Parameters:**
- `name` (required): Element name to delete
- `type` (required): Element type
- `deleteData` (optional): Whether to delete associated data files

**Examples:**
```bash
# Delete element only (preserves data)
delete_element "Old Template" --type template --deleteData false

# Delete element and all data
delete_element "Test Agent" --type agent --deleteData true

# Interactive mode (prompts about data files)
delete_element "Project Manager" --type agent
```

### validate_element
Validates an element for correctness and best practices.

**Parameters:**
- `name` (required): Element name to validate
- `type` (required): Element type
- `strict` (optional): Apply strict validation rules (default: false)

**Example:**
```bash
validate_element "Code Reviewer" --type skill --strict true
```

**Response:**
```
✅ Validation passed

Warnings:
- Missing 'proficiency.level' field
- No examples provided in content

Suggestions:
- Add usage examples
- Define parameter constraints
- Include error handling instructions
```

### activate_element
Activates a specific element.

**Parameters:**
- `name` (required): Element name to activate
- `type` (required): Element type

**Example:**
```bash
activate_element "Professional Writer" --type persona
activate_element "Code Reviewer" --type skill
```

### deactivate_element
Deactivates a specific element.

**Parameters:**
- `name` (required): Element name to deactivate
- `type` (required): Element type

**Example:**
```bash
deactivate_element "Code Reviewer" --type skill
```

### get_active_elements
Shows currently active elements of a specific type.

**Parameters:**
- `type` (required): Element type to check

**Example:**
```bash
get_active_elements --type persona
```

**Response:**
```
Active personas (1):
🔹 Professional Writer
   A skilled writer focused on clear communication
   Activated at: 2025-08-02T10:30:00Z
```

### get_element_details
Retrieves detailed information about a specific element.

**Parameters:**
- `name` (required): Element name
- `type` (required): Element type

**Example:**
```bash
get_element_details "Code Reviewer" --type skill
```

### reload_elements
Reloads elements from the filesystem.

**Parameters:**
- `type` (required): Element type to reload

**Example:**
```bash
reload_elements --type template
```

## Type-Specific Tools

### render_template
Renders a template with provided variables.

**Parameters:**
- `name` (required): Template name to render
- `variables` (required): JSON object with variable values

**Example:**
```bash
render_template "Sprint Report" --variables '{
  "sprintNumber": 23,
  "teamName": "Phoenix",
  "completedTasks": [
    {"title": "Implement auth", "points": 5},
    {"title": "Fix bugs", "points": 3}
  ]
}'
```

### execute_agent
Executes an agent with a specific goal.

**Parameters:**
- `name` (required): Agent name to execute
- `goal` (required): Goal for the agent to achieve

**Example:**
```bash
execute_agent "Project Manager" --goal "Plan the next sprint based on velocity"
```

## Collection Tools

### browse_collection
Browse the GitHub collection by element type.

**Parameters:**
- `section` (optional): Collection section to browse
- `type` (optional): Filter by element type

**Example:**
```bash
browse_collection --type skill
```

### search_collection
Search across all collection content.

**Parameters:**
- `query` (required): Search query
- `type` (optional): Filter by element type

**Example:**
```bash
search_collection "python" --type skill
```

### get_collection_content
View detailed information about collection content.

**Parameters:**
- `path` (required): Path to the content file

**Example:**
```bash
get_collection_content "skill/python-expert.md"
```

### install_element
Install an element from the collection.

**Parameters:**
- `path` (required): Path to the element in collection
- `type` (optional): Element type (auto-detected if not provided)

**Example:**
```bash
install_element "skill/code-reviewer.md"
```

### submit_persona
Submit a persona to the collection (legacy - for personas only).

**Parameters:**
- `persona_name` (required): Name of persona to submit

**Example:**
```bash
submit_persona "Data Scientist"
```

## User Management Tools

### set_user_identity
Set your user identity for element attribution.

**Parameters:**
- `username` (required): Your username
- `email` (optional): Your email address

**Example:**
```bash
set_user_identity "johndoe" --email "john@example.com"
```

### get_user_identity
Display current user identity settings.

**Example:**
```bash
get_user_identity
```

**Response:**
```
Current user identity:
Username: johndoe
Email: john@example.com
```

### clear_user_identity
Clear user identity (return to anonymous).

**Example:**
```bash
clear_user_identity
```

### configure_indicator
Configure how active elements are displayed.

**Parameters:**
- `style` (required): Display style - one of: `full`, `minimal`, `compact`, `custom`, `none`
- `options` (optional): JSON object with display options

**Example:**
```bash
# Minimal style
configure_indicator --style minimal

# Custom style
configure_indicator --style custom --options '{
  "showEmoji": true,
  "showBrackets": false,
  "showVersion": false,
  "showAuthor": true
}'
```

### get_indicator_config
Show current indicator configuration.

**Example:**
```bash
get_indicator_config
```

## Update System Tools

### check_for_updates
Check for available updates on GitHub.

**Example:**
```bash
check_for_updates
```

### update_server
Perform automated server update.

**Parameters:**
- `autoConfirm` (optional): Skip confirmation prompts (default: false)

**Example:**
```bash
update_server --autoConfirm true
```

### rollback_update
Rollback to a previous version from backup.

**Parameters:**
- `autoConfirm` (optional): Skip confirmation prompts (default: false)

**Example:**
```bash
rollback_update
```

### get_server_status
Display current server version and status.

**Example:**
```bash
get_server_status
```

## GitHub Authentication Tools

### authenticate_github
Start GitHub OAuth device flow authentication for secure access to GitHub features.

**Example:**
```bash
authenticate_github
```

**Response:**
```
🔐 GitHub Device Flow Authentication

To authenticate with GitHub:
1. Visit: https://github.com/login/device
2. Enter code: XXXX-XXXX
3. Authorize 'DollhouseMCP OAuth'

⏳ Waiting for authorization... (expires in 15 minutes)
```

### get_auth_status
Check current GitHub authentication status.

**Example:**
```bash
get_auth_status
```

**Response (Authenticated):**
```
✅ Authenticated as: mickdarling
📧 Email: mick@example.com
🔑 Token: Stored securely (encrypted)
📅 Authenticated at: 2025-08-05T14:30:00Z
```

**Response (Not Authenticated):**
```
❌ Not authenticated with GitHub

To authenticate, use the 'authenticate_github' tool.
```

### clear_authentication
Remove stored GitHub authentication credentials.

**Example:**
```bash
clear_authentication
```

**Response:**
```
✅ GitHub authentication cleared successfully

Your stored credentials have been removed. You'll need to authenticate again to use GitHub features.
```

## Legacy Persona Tools (Deprecated)

These tools are maintained for backward compatibility but should be replaced with generic element tools.

### list_personas
Use `list_elements --type persona` instead.

### activate_persona
Use `activate_element [name] --type persona` instead.

### deactivate_persona
Use `deactivate_element [name] --type persona` instead.

### get_active_persona
Use `get_active_elements --type persona` instead.

### get_persona_details
Use `get_element_details [name] --type persona` instead.

### reload_personas
Use `reload_elements --type persona` instead.

### create_persona
Use `create_element --type persona` instead.

### edit_persona
Use `edit_element --type persona` instead.

### validate_persona
Use `validate_element --type persona` instead.

## Response Formats

### Success Response
```json
{
  "content": [{
    "type": "text",
    "text": "✅ Operation completed successfully"
  }]
}
```

### Error Response
```json
{
  "content": [{
    "type": "text",
    "text": "❌ Error: Element 'NonExistent' not found"
  }]
}
```

### List Response
```json
{
  "content": [{
    "type": "text",
    "text": "🎯 Element Name (type)\n   Description\n   📁 category | ⭐ rating | 👤 author"
  }]
}
```

## Error Handling

Common error scenarios and solutions:

### Element Not Found
```
❌ Error: Element 'MySkill' not found
```
**Solution**: Check spelling and use `list_elements` to see available elements.

### Invalid Element Type
```
❌ Invalid element type 'skills'. Valid types: persona, skill, template, agent, memory, ensemble
```
**Solution**: Use singular form (skill, not skills).

### Validation Errors
```
❌ Invalid element: Name cannot be empty
```
**Solution**: Provide all required fields.

### File System Errors
```
❌ Error: Permission denied
```
**Solution**: Check file permissions in ~/.dollhouse/portfolio/

## Best Practices

1. **Use Generic Tools**: Prefer generic element tools over legacy persona tools
2. **Validate Before Saving**: Use `validate_element` to check for issues
3. **Backup Before Updates**: System creates automatic backups
4. **Use Meaningful Names**: Element names should be descriptive
5. **Set User Identity**: Configure identity for proper attribution
6. **Check Active Elements**: Know what's currently active
7. **Use Type Singular**: skill not skills, persona not personas

## Examples by Use Case

### Creating a Development Environment
```bash
# Create a developer persona
create_element --type persona --name "Senior Developer" \
  --description "Experienced software engineer"

# Add complementary skills
create_element --type skill --name "Code Review" \
  --description "Thorough code analysis"
  
create_element --type skill --name "Testing Expert" \
  --description "Unit and integration testing"

# Create an ensemble
create_element --type ensemble --name "Full Stack Dev" \
  --description "Complete development environment" \
  --metadata '{
    "members": [
      {"type": "persona", "ref": "Senior Developer"},
      {"type": "skill", "ref": "Code Review"},
      {"type": "skill", "ref": "Testing Expert"}
    ]
  }'

# Activate the ensemble
activate_element "Full Stack Dev" --type ensemble
```

### Setting Up Templates
```bash
# Create templates for common tasks
create_element --type template --name "PR Description" \
  --description "Pull request template" \
  --content "## Summary\n{{summary}}\n\n## Changes\n{{changes}}"

create_element --type template --name "Bug Report" \
  --description "Bug report format" \
  --content "## Bug Description\n{{description}}\n\n## Steps\n{{steps}}"

# Use templates
render_template "PR Description" --variables '{
  "summary": "Add user authentication",
  "changes": "- Add login endpoint\n- Add JWT tokens"
}'
```

## Version History

- **v1.5.0**: GitHub OAuth authentication with secure token storage
- **v1.4.5**: Fixed Claude Desktop integration issues
- **v1.4.0**: NPM package distribution support
- **v1.3.3**: Full element system with generic tools
- **v1.3.0**: Portfolio structure introduced
- **v1.2.0**: Security enhancements
- **v1.1.0**: GitHub marketplace integration
- **v1.0.0**: Initial personas-only release

## See Also

- [Element Architecture](./ELEMENT_ARCHITECTURE.md)
- [Element Types](./ELEMENT_TYPES.md)
- [Developer Guide](./ELEMENT_DEVELOPER_GUIDE.md)
- [Migration Guide](./MIGRATION_TO_PORTFOLIO.md)