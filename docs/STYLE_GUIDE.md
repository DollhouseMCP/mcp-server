# Documentation Style Guide

This guide defines writing standards for all documentation in the DollhouseMCP project. It complements [CONVENTIONS.md](./CONVENTIONS.md) (which focuses on naming) with broader documentation best practices.

## Core Principles

### 1. Clarity Over Cleverness

Write to communicate, not to impress. Technical accuracy and clarity beat eloquent prose.

```markdown
❌ "Our innovative approach leverages cutting-edge containerization paradigms"
✅ "Uses Docker containers for consistent deployment across platforms"
```

### 2. Active Voice

Prefer active voice for directness and clarity. Passive voice is acceptable for emphasis or attribution.

```markdown
❌ "The configuration file should be edited by the user"
✅ "Edit the configuration file"
✅ "The server was designed to handle 10,000 requests/sec" (attribution)
```

### 3. Be Concise, Not Terse

Remove unnecessary words, but don't sacrifice clarity for brevity.

```markdown
❌ "In order to install the package, you will need to run npm install"
✅ "Install the package: npm install"
❌ "Do npm install" (too terse, missing context)
```

### 4. Show, Don't Just Tell

Provide examples alongside explanations. Code examples should be runnable and tested.

```markdown
❌ "Configure the timeout option"
✅ "Configure the timeout option:
    {
      timeout: 5000  // 5 seconds
    }"
```

## Writing for Different Audiences

DollhouseMCP documentation serves multiple audiences. Tailor your writing style to match the audience and content type.

### End User Documentation

**Audience**: People using AI assistants with DollhouseMCP (non-technical)

**Approach**: Natural language, conversational, action-oriented

**Example - Creating Elements**:

```markdown
## Creating a Custom Persona

To create a custom persona, describe what you want to your AI assistant:

> "Create a persona called 'helpful-coder' that assists with TypeScript development
> and focuses on clean, maintainable code."

Your AI assistant will create the persona and store it in your portfolio. You can
then activate it by saying:

> "Activate the helpful-coder persona"

### Tips
- Be specific about the persona's focus and behavior
- Give it a descriptive name (use lowercase with hyphens)
- You can modify personas later by asking your AI to update them
```

**Key characteristics**:
- Use natural language instructions
- Frame actions as conversations with the AI
- Avoid technical jargon or implementation details
- Focus on what the user wants to accomplish

### Developer/API Documentation

**Audience**: Developers building with or contributing to DollhouseMCP

**Approach**: Technical, precise, comprehensive

**Example - MCP Tool Reference**:

```markdown
## create_element

Creates a new element in the user's portfolio.

**Tool Name**: `create_element`

**Parameters**:
- `type` (string, required) - Element type
  - Valid values: "personas", "skills", "templates", "agents", "memories", "ensembles"
- `name` (string, required) - Element name
  - Format: lowercase-with-hyphens
  - Must be unique within the element type
- `description` (string, required) - Brief description of the element
- `content` (string, required for most types) - Element content in appropriate format
  - Personas/Skills/Templates: Markdown
  - Memories: Markdown (will be converted to YAML entry)
  - Agents: Markdown with special directives

**Returns**: `{ success: boolean, element: Element, message: string }`

**Errors**:
- `ValidationError` - Invalid parameters or format
- `DuplicateError` - Element with that name already exists
- `FileSystemError` - Unable to write to portfolio directory

**Implementation**: `src/tools/createElement.ts`

**Related**:
- `activate_element` - Activate a created element
- `edit_element` - Modify an existing element
- `delete_element` - Remove an element
```

**Key characteristics**:
- Complete technical specifications
- Parameter types and constraints
- Error conditions
- Implementation references
- Cross-references to related functionality

### LLM Context Documentation

**Audience**: AI assistants (LLMs) that need project context

**Approach**: Clear instructions, tool availability, behavioral guidelines

**Example - claude.md style**:

```markdown
## Element Management

DollhouseMCP provides MCP tools for managing elements (personas, skills, memories, etc.).

### Available Tools

Use these MCP tools to manage elements:

- `create_element` - Create a new element in the portfolio
- `activate_element` - Activate an element for use
- `deactivate_element` - Deactivate an active element
- `list_elements` - List available elements by type
- `get_element_details` - Get detailed information about an element

### Creating Elements

When a user asks to create an element (persona, skill, etc.), use the `create_element` tool:

1. Extract the element type from the user's request
2. Generate an appropriate name (lowercase-with-hyphens)
3. Write a clear description
4. Create appropriate content based on the element type
5. Call `create_element` with the parameters

**Important**: Always use MCP tools to create elements. Never instruct users to manually
create files in `~/.dollhouse/portfolio/`.

### Example User Requests

"Create a persona for helping with Python" → Use `create_element` with type="personas"
"Add a new skill for code review" → Use `create_element` with type="skills"
"Store this meeting note as a memory" → Use `create_element` with type="memories"
```

**Key characteristics**:
- Instructions for the LLM, not end users
- Tool names and when to use them
- Behavioral guidelines (dos and don'ts)
- Example user requests and appropriate responses
- Context about the system architecture

### Technical Writing (Inline Code)

**Audience**: Developers reading the source code

**Approach**: Explain why, not what (when it's not obvious from code)

**Good comments**:
```typescript
// Use display name for UI, fall back to username for API compatibility
const displayName = user.displayName || user.username;

// WORKAROUND: Jest doesn't support ES modules for dynamic imports yet
// See: https://github.com/facebook/jest/issues/9430
const { default: module } = await import('./module.js');

// FIX: Escape special characters to prevent YAML injection
// Previously: Directly interpolated user input
// Now: Sanitize and validate before YAML serialization
const sanitized = escapeYAML(userInput);
```

**Bad comments**:
```typescript
// Get the user name
const userName = user.name;

// Loop through items
for (const item of items) { ... }
```

## Writing Style Guidelines

### Headlines and Titles

- Use sentence case for all headings: "Getting started" not "Getting Started"
- Be descriptive: "Install dependencies" not "Installation"
- Front-load important words: "GitHub authentication setup" not "Setting up authentication for GitHub"

### Paragraphs

- Keep paragraphs focused on one idea
- Aim for 3-5 sentences per paragraph
- Use line breaks between paragraphs (markdown blank lines)
- First sentence should summarize the paragraph's point

### Lists

Use lists to improve scanability:

**Bulleted lists** - Unordered information, options, or loosely related items
**Numbered lists** - Sequential steps, prioritized information, or ordered items
**Definition lists** - When explaining terms or concepts (use bold)

### Code References

When mentioning code elements inline:

- Use backticks for code: `functionName()`, `variable`, `"string value"`
- Include parentheses for functions: `createElement()` not `createElement`
- Use file paths with context: `src/index.ts` not just `index.ts`
- Reference line numbers when helpful: `src/index.ts:42`

### Links

**Inline links** - For documentation references:
```markdown
See [CONTRIBUTING.md](../CONTRIBUTING.md) for development workflow.
```

**Reference links** - For repeated or long URLs:
```markdown
See the [MCP specification][mcp-spec] for protocol details.

[mcp-spec]: https://modelcontextprotocol.io/specification
```

**URL formatting** - Wrap bare URLs in angle brackets:
```markdown
✅ Repository: <https://github.com/DollhouseMCP/mcp-server>
❌ Repository: https://github.com/DollhouseMCP/mcp-server
```

## Formatting Standards

### Code Blocks

Always specify the language for syntax highlighting:

```markdown
\```typescript
const example = "with language";
\```

\```bash
npm install
\```

\```json
{ "key": "value" }
\```
```

Use `console` for command output:

```markdown
\```console
$ npm install
added 42 packages in 3.2s
\```
```

### Callouts and Admonitions

Use consistent formatting for notes, warnings, and tips:

```markdown
**Note**: Additional context or clarification

**Important**: Critical information that affects behavior

**Warning**: Potential issues or risks

**Tip**: Helpful advice or best practice
```

### Tables

Use tables for structured comparisons or reference data:

```markdown
| Feature | Supported | Notes |
|---------|-----------|-------|
| OAuth   | ✅        | GitHub only |
| API Key | ✅        | All platforms |
```

**Guidelines**:
- Keep tables simple (max 4-5 columns)
- Use emoji sparingly (✅ ❌ ⚠️)
- Left-align text, right-align numbers
- Include header row separators

### File Paths

Use consistent path notation:

- Unix-style forward slashes: `src/elements/personas.ts`
- Include leading `./` for relative paths in documentation: `./docs/CONTRIBUTING.md`
- Use `~` for home directory: `~/.dollhouse/portfolio/`
- Use backticks: `` `src/index.ts` ``

## Technical Writing

### Version-Specific Information

Handle version-specific content carefully:

```markdown
❌ "In the latest version, we added feature X"
✅ "Since v1.9.0, feature X is available"

❌ "This feature is coming soon"
✅ "This feature is planned for v2.0.0" or omit entirely
```

### Deprecation Notices

Be clear about deprecations and migration paths:

```markdown
**Deprecated**: `oldFunction()` is deprecated since v1.8.0 and will be removed in v2.0.0.

**Migration**: Use `newFunction()` instead:

\```typescript
// Before
oldFunction(arg1, arg2);

// After
newFunction({ arg1, arg2 });
\```
```

### Error Messages and Troubleshooting

Structure troubleshooting information clearly:

```markdown
### Error: "Module not found"

**Symptom**: `Error: Cannot find module '@dollhousemcp/core'`

**Cause**: Dependencies not installed or build artifacts missing

**Solution**:
1. Install dependencies: `npm install`
2. Build the project: `npm run build`
3. If error persists, clear cache: `npm run clean && npm run build`
```

### Cross-References

Link to related documentation to help readers find additional information.

**Basic cross-reference section:**

```markdown
For more details, see:
- [Architecture overview](./ARCHITECTURE.md)
- [API reference](./API.md#createElement)
- [GitHub issue #123](https://github.com/DollhouseMCP/mcp-server/issues/123)
```

**Example of a good cross-reference section:**

```markdown
## Related Documentation

### Prerequisites
Before using this feature, ensure you understand:
- [Element system architecture](./ELEMENT_IMPLEMENTATION_GUIDE.md) - Overview of element types and structure
- [Portfolio management](./PORTFOLIO_GUIDE.md#setup) - Setting up your local portfolio

### Next Steps
After completing this guide:
- [Create your first persona](./tutorials/FIRST_PERSONA.md) - Hands-on tutorial
- [Advanced element composition](./ENSEMBLES.md) - Combining multiple elements
- [Element best practices](./ELEMENT_BEST_PRACTICES.md) - Tips for effective elements

### Troubleshooting
If you encounter issues:
- [Common errors](./TROUBLESHOOTING.md#element-creation) - Solutions for frequent problems
- [GitHub issue #1234](https://github.com/DollhouseMCP/mcp-server/issues/1234) - Known issue with workaround
- [Community discussions](https://github.com/DollhouseMCP/mcp-server/discussions) - Ask questions

### Technical Reference
For developers:
- [API documentation](./API.md#createElement) - Complete API reference
- [Element file format spec](./development/MANUAL_ELEMENT_CONSTRUCTION.md) - File format details
- [Source code](../src/elements/PersonaManager.ts) - Implementation reference
```

**Guidelines**:
- **Group by purpose**: Prerequisites, Next Steps, Troubleshooting, Technical Reference
- **Be specific**: Link to exact sections when possible (`#createElement`)
- **Add context**: Brief description helps readers decide whether to click
- **Mix link types**: Documentation, issues, discussions, source code as appropriate
- **Keep it relevant**: Only link to directly related content

## Common Mistakes to Avoid

### 1. Assuming Context

```markdown
❌ "Run the command"
✅ "From the project root, run: npm test"
```

### 2. Using "Simply" or "Just"

```markdown
❌ "Simply edit the config file"
✅ "Edit the config file at ~/.dollhouse/config.yaml"
```

If it's truly simple, the word is unnecessary. If it's not simple, the word is condescending.

### 3. Unclear Pronouns

```markdown
❌ "When you run this, it will generate them"
✅ "When you run the build, it will generate type definitions"
```

### 4. Future Tense for Documentation

```markdown
❌ "This guide will show you how to..."
✅ "This guide shows you how to..."
```

### 5. Marketing Speak in Technical Docs

```markdown
❌ "Our revolutionary element system empowers you to..."
✅ "The element system enables modular AI customization through..."
```

### 6. Confusing MCP Tools with CLI Commands

```markdown
❌ "Run: mcp__dollhousemcp__create_element --type personas"
✅ (User docs): "Ask your AI assistant to create a new persona"
✅ (Dev docs): "The create_element tool accepts a type parameter"
✅ (LLM docs): "Use create_element when the user requests element creation"
```

### 7. Wrong Audience Style

```markdown
❌ (In user docs): "Call the create_element MCP tool with type parameter 'personas'"
❌ (In dev docs): "Just tell Claude to make a persona"
❌ (In LLM docs): "Users should ask their AI nicely"
```

## Quality Checklist

Before submitting documentation, verify:

### Accuracy
- [ ] All code examples run without errors
- [ ] All tool references use correct names
- [ ] All links work (internal and external)
- [ ] Technical details are current and correct
- [ ] Version numbers are accurate

### Clarity
- [ ] Appropriate style for target audience
- [ ] No jargon without explanation (in user docs)
- [ ] Examples illustrate the concept
- [ ] Structure is logical and scannable

### Completeness
- [ ] Answers the question fully
- [ ] Includes prerequisites
- [ ] Provides next steps or related topics
- [ ] Covers common issues

### Style
- [ ] Follows this style guide
- [ ] Uses consistent terminology
- [ ] Markdown renders correctly
- [ ] No spelling or grammar errors

## Tools and Resources

### Markdown Linting

Common rules:
- MD022: Blank lines around headings
- MD031: Blank lines around code blocks
- MD034: No bare URLs (use angle brackets)

### Spell Checking

- Use IDE spell checker
- Add technical terms to project dictionary
- Watch for homophone errors (their/there, its/it's)

### Link Checking

Automated link checking (see Issue #1272) helps catch broken links.

## Related Documentation

- [CONVENTIONS.md](./CONVENTIONS.md) - Naming standards and conventions
- [CONTRIBUTING.md](./CONTRIBUTING.md) - Development workflow and guidelines
- [SESSION_MANAGEMENT.md](./development/SESSION_MANAGEMENT.md) - Session workflow
- [Manual Element Construction](./development/MANUAL_ELEMENT_CONSTRUCTION.md) - Developer guide for manual element creation

---

*This style guide helps maintain consistent, professional documentation across the DollhouseMCP project.*
*For questions or suggestions, create an issue or PR.*
