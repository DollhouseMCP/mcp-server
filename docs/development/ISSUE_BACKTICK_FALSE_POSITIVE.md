# Issue: Security Validator Blocks Markdown Code Formatting

## Problem
The content validator is blocking legitimate markdown content that uses backticks for code formatting. This prevents installation of valid content like the Roundtrip Test Skill.

## Root Cause
In `src/security/contentValidator.ts` line 62:
```javascript
{ pattern: /`[^`]+`/g, severity: 'critical', description: 'Backtick command execution' },
```

This pattern treats ALL backticks as potential command execution, even when they're just markdown code formatting.

## Example of False Positive
The Roundtrip Test Skill contains legitimate markdown like:
```markdown
Install: `install_content "library/skills/roundtrip-test-skill.md"`
Details: `get_collection_content "library/skills/roundtrip-test-skill.md"`
```

This is blocked with error: "Critical security threat detected in persona content"

## Impact
- Cannot install skills/templates that contain code examples
- Cannot use backticks for inline code in any content
- Blocks legitimate technical documentation

## Solution Needed
The pattern needs to distinguish between:
1. **Shell command execution**: Real backticks in a shell context
2. **Markdown formatting**: Backticks used for code display

Possible approaches:
- Check context (is this in a YAML field vs markdown content?)
- Look for actual shell patterns inside backticks
- Allow single-line backticks but block multi-line
- Whitelist markdown code blocks

## Temporary Workaround
Remove the backtick pattern entirely (line 62) until a better solution is implemented.

---
*Discovered: August 11, 2025*
*Blocks: Roundtrip workflow testing*