# Smart Element Detection Guide

**User-friendly guide to understanding how DollhouseMCP automatically detects and handles portfolio elements**

## What is Smart Element Detection?

Smart Element Detection is DollhouseMCP's intelligent system that automatically identifies the type and location of portfolio elements when you submit content to GitHub. Instead of requiring you to manually specify element types, the system searches across all your portfolio directories to find matching content.

### Key Benefits

- **Automatic Type Detection**: No need to remember element types when submitting
- **Parallel Search**: Searches all element directories simultaneously for fast results
- **Fuzzy Matching**: Finds content even with partial names or different file extensions
- **Clear Error Messages**: Provides helpful guidance when content isn't found
- **Prevents Mistakes**: No more accidentally submitting content as the wrong element type

## How It Works

When you use `submit_content` without specifying a type parameter:

1. **Parallel Search**: The system searches all element directories simultaneously:
   - `personas/` - Personality and behavior profiles
   - `skills/` - Specialized capabilities
   - `templates/` - Reusable response formats
   - `agents/` - Autonomous assistants
   - `memories/` - Persistent context storage
   - `ensembles/` - Multi-element orchestrations

2. **Smart Matching**: For each directory, it looks for files matching your content name:
   - Exact name matches (e.g., `code-review.md`)
   - Partial matches (e.g., `code` matches `code-review.md`)
   - Multiple file extensions (`.md`, `.json`, `.yaml`, `.yml`)

3. **Result Processing**:
   - **Single match**: Automatically uses that element type
   - **Multiple matches**: Asks you to specify which type you want
   - **No matches**: Provides helpful error message with troubleshooting steps

## Usage Examples

### Automatic Detection (Recommended)

```
# System automatically detects the element type
submit_content name="code-review"
```

**Sample Output:**
```
✅ Smart detection: Found "code-review" as SKILL
✅ Successfully uploaded code-review to your GitHub portfolio!
📁 Portfolio URL: https://github.com/username/dollhouse-portfolio/blob/main/skills/code-review.md
```

### Explicit Type (When Needed)

```
# Specify type when you have naming conflicts
submit_content name="meeting-notes" type="templates"
```

### List Content First

```
# See what's available in your portfolio
list_elements type="skills"
list_elements  # Shows all types
```

## Common Scenarios

### ✅ Successful Detection

**Scenario**: You have a file `~/.dollhouse/portfolio/skills/data-analysis.md`

```
submit_content name="data-analysis"
```

**Result**: 
- System finds the file in the `skills/` directory
- Automatically detects type as `SKILL`
- Proceeds with GitHub submission

### ⚠️ Multiple Matches Found

**Scenario**: You have files in multiple directories with the same name:
- `~/.dollhouse/portfolio/personas/security-expert.md`
- `~/.dollhouse/portfolio/agents/security-expert.md`

```
submit_content name="security-expert"
```

**Result**:
```
Content "security-expert" found in multiple element types:

- PERSONA: ~/.dollhouse/portfolio/personas/security-expert.md
- AGENT: ~/.dollhouse/portfolio/agents/security-expert.md

Please specify the element type using the --type parameter to avoid ambiguity.
```

**Solution**:
```
submit_content name="security-expert" type="personas"
```

### ❌ Content Not Found

**Scenario**: You try to submit content that doesn't exist

```
submit_content name="nonexistent-element"
```

**Result**:
```
❌ Content "nonexistent-element" not found in portfolio.

**Searched in all element types:** personas, skills, templates, agents, memories, ensembles

**To resolve this issue:**
1. Check if the content exists in your portfolio
2. Verify the content name/filename is correct
3. If the content is in a specific type directory, try using the exact filename
4. Use the `list_portfolio` tool to see all available content

**Note:** The system no longer defaults to any element type to prevent incorrect submissions.
```

## Troubleshooting Tips

### Problem: "Content not found" error

**Check These Things:**

1. **Verify Content Exists**:
   ```
   list_elements  # See all your portfolio content
   ```

2. **Check Filename Exactly**:
   - Look for exact filename in the list
   - Note file extensions (`.md`, `.json`, etc.)
   - Check for spaces or special characters

3. **Verify Directory Structure**:
   ```
   # Your portfolio should be organized like:
   ~/.dollhouse/portfolio/
   ├── personas/
   ├── skills/
   ├── templates/
   ├── agents/
   ├── memories/
   └── ensembles/
   ```

4. **Refresh Portfolio**:
   ```
   reload_elements  # Refresh from filesystem
   ```

### Problem: Multiple matches found

**Quick Solutions:**

1. **Use Explicit Type**:
   ```
   submit_content name="your-content" type="skills"
   ```

2. **Use More Specific Names**: Rename files to avoid conflicts
   - `security-persona.md` in personas/
   - `security-agent.md` in agents/

3. **Check Which One You Want**:
   ```
   get_element_details name="your-content" type="personas"
   get_element_details name="your-content" type="agents"
   ```

### Problem: Slow detection performance

**Optimization Tips:**

1. **Keep Portfolio Organized**: Don't put files in wrong directories
2. **Use Standard Extensions**: Stick to `.md`, `.json`, `.yaml`
3. **Avoid Deep Nesting**: Keep elements at the top level of each directory
4. **Regular Cleanup**: Remove unused or duplicate files

## Advanced Usage

### Working with Partial Names

The system supports fuzzy matching:

```
# This file exists: code-review-checklist.md
submit_content name="code-review"  # ✅ Will match
submit_content name="checklist"    # ✅ Will match
submit_content name="review"       # ⚠️ Might match multiple files
```

### File Extension Flexibility

The system searches multiple extensions automatically:

```
# Any of these files will be found:
# - my-template.md
# - my-template.json  
# - my-template.yaml
# - my-template.yml
submit_content name="my-template"
```

### Performance Considerations

- **Parallel Search**: All directories searched simultaneously for speed
- **Caching**: Results are cached to improve repeat searches
- **Optimized File Discovery**: Uses efficient filesystem operations

## Best Practices

### 📁 Organization

1. **Use Clear Names**: `email-template.md` not `template1.md`
2. **Avoid Duplicates**: Don't put same content in multiple element types
3. **Consistent Naming**: Use hyphens, not spaces or underscores

### 🔍 Submission

1. **Check First**: Use `list_elements` to see what you have
2. **Start Simple**: Let auto-detection work, only specify type when needed
3. **Read Error Messages**: They contain specific troubleshooting steps

### 🚀 Performance

1. **Keep It Clean**: Remove unused files from portfolio directories
2. **Standard Extensions**: Stick to `.md`, `.json`, `.yaml`, `.yml`
3. **Flat Structure**: Don't create subdirectories within element directories

## Integration with Other Tools

Smart Element Detection works seamlessly with other DollhouseMCP features:

### Portfolio Management
- `list_elements` - Shows what detection will find
- `reload_elements` - Refreshes detection cache
- `get_element_details` - Examines specific elements

### GitHub Integration
- `portfolio_status` - Check GitHub repository state
- `sync_portfolio` - Sync local changes with GitHub

### Collection Workflow
- Detected elements can be automatically submitted to the community collection
- Set `DOLLHOUSE_AUTO_SUBMIT_TO_COLLECTION=true` for automatic submission

## Migration from Previous Versions

### What Changed in PR #599

**Before**: System defaulted to `PERSONA` type when content wasn't found, causing incorrect submissions.

**After**: System never defaults and always searches explicitly, preventing mistakes.

**Impact**: Existing workflows continue working, but you'll get clearer error messages when content isn't found.

### Updating Your Workflow

No changes needed for most users:

```
# This still works exactly the same
submit_content name="my-content"

# This also works the same
submit_content name="my-content" type="skills"
```

The only difference is better error messages when content doesn't exist.

## Support and Feedback

If you encounter issues with Smart Element Detection:

1. **Check Your Portfolio**: Use `list_elements` to verify content exists
2. **Review Error Messages**: They contain specific troubleshooting steps  
3. **Try Explicit Types**: Use the `type` parameter as a workaround
4. **File Issues**: Report bugs on the GitHub repository

The Smart Element Detection system makes managing your DollhouseMCP portfolio easier and more reliable. Let it handle the technical details while you focus on creating great AI elements!