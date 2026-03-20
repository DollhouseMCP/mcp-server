# Smart Element Detection Guide

**Understand how `submit_collection_content` locates the right element in your portfolio and how to resolve the most common edge cases.**

---

## 1. What Smart Detection Does

When you run:

```
submit_collection_content "code-review"
```

the server:

1. Scans every element directory (`personas/`, `skills/`, `templates/`, `agents/`, `memories/`, `ensembles/`) in parallel.
2. Looks for matching filenames **and** frontmatter names, with fuzzy matching for partial strings (e.g., "verbose victorian" matches "Verbose-Victorian-Scholar") and different extensions (`.md`, `.json`, `.yaml`, `.yml`).
3. Passes the resolved element type and path to the portfolio uploader so the element lands in the correct GitHub folder.
4. Warns you if the same element already exists in multiple sources (local, GitHub, collection) before proceeding.

No manual type selection is required for the typical case.

---

## 2. Quick Examples

| Scenario | Command | Result |
|----------|---------|--------|
| Exact match | `submit_collection_content "creative-writer"` | Detects persona, uploads, then opens the sharing workflow. |
| Partial match | `submit_collection_content "writer"` | Fuzzy match finds `creative-writer.md`; warns if multiple candidates exist. |
| Duplicate detection | `submit_collection_content "code-review"` | Shows existing versions across local/GitHub/collection and recommends the latest before continuing. |
| Not found | `submit_collection_content "nonexistent-element"` | Lists searched types, offers spelling suggestions, and points you to troubleshooting steps. |

Clients that send structured JSON should pass the same value via `content`, e.g. `submit_collection_content content="creative-writer"`.

---

## 3. Handling Ambiguity

Smart detection stops at the first valid match, but the system still protects you:

- If **multiple files share the same name** (e.g., a persona and an agent both called `security-expert`), the duplicate checker warns you and shows all versions it knows about. Decide which one to keep, or rename the extra file for clarity.
- If you **intend to upload a specific type repeatedly**, consider using the `portfolio_element_manager` tool:

  ```bash
  portfolio_element_manager \
    operation="upload" \
    element_name="security-expert" \
    element_type="agents"
  ```

  This bypasses auto-detection and gives you explicit control.

---

## 4. Troubleshooting Reference

### “Content not found”
Check the basics:

1. **List your portfolio**  
   ```
   list_elements
   list_elements type="skills"
   ```
2. **Check filesystem** – ensure the file lives under `~/.dollhouse/portfolio/<type>/`.
3. **Version mismatch** – confirm the frontmatter `name:` matches the string you passed.
4. **Reload cache** – after manual edits, run `reload_elements`.

### “Wrong element type uploaded”
- Rename one of the duplicates to avoid ambiguity, or move it temporarily.
- Use `portfolio_element_manager` with explicit `element_type` on the next upload.

### “Already submitted / duplicate warning”
- Review the duplicate summary that appears in the response.
- Update the version in the element’s metadata (e.g., bump `version:`) if you’re intentionally publishing an enhancement.
- If you only meant to update your local GitHub portfolio, stop and use `portfolio_element_manager operation="upload"` instead.

---

## 5. Best Practices

- Keep portfolio directories tidy—remove stale copies and avoid storing unrelated files alongside elements.
- Use descriptive file names to reduce collisions (`security-persona.md` vs `security-agent.md`).
- Bump semantic versions in metadata after meaningful edits so the duplicate detector can tell revisions apart.
- When in doubt, dry-run a submission through a Git client before invoking `submit_collection_content`.

Smart detection is designed to catch the right file 99% of the time. These habits cover the remaining 1%.
