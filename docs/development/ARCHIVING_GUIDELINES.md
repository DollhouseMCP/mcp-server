# Documentation Archiving Guidelines

## Purpose
To maintain a clean and efficient `docs/development` directory by archiving historical documentation that is no longer actively needed but should be preserved for reference.

## Archive Structure
```
docs/archive/
├── YYYY/
│   └── MM/
│       └── [archived files]
```

## Archiving Criteria
Documents should be archived when they are:
- **Session logs**: Older than 7 days
- **Context handoffs**: From completed sessions older than 7 days  
- **Development tracking**: From completed work older than 14 days
- **Status files**: From previous releases or completed milestones

## Reference Management

Before archiving files, it's critical to handle references to prevent broken links:

### 1. Search for References
Before archiving any file, search for all references to it:
```bash
# Find all references to a specific file
grep -r "filename.md" docs/

# Find references with more context
grep -r -B2 -A2 "filename.md" docs/development/
```

### 2. Update References
Update references to point to the archive location:
- Change `/docs/development/FILENAME.md` to `/docs/archive/YYYY/MM/FILENAME.md`
- Change `docs/development/FILENAME.md` to `docs/archive/YYYY/MM/FILENAME.md`
- Update relative paths like `./FILENAME.md` to `../archive/YYYY/MM/FILENAME.md`

### 3. Consider Reference Relevance
Before updating a reference, consider:
- Is the archived content still relevant to the active document?
- Should the reference be removed entirely?
- Does the active document need updating to reflect current practices?

### 4. Use the Reference Fix Script
Run the provided script to automatically fix references:
```bash
./scripts/fix-archived-references.sh
```

## What to Archive

### Always Archive (after time threshold)
- SESSION_SUMMARY_*.md
- SESSION_HANDOFF_*.md
- CONTEXT_HANDOFF_*.md
- CONTEXT_NOTES_*.md
- CRITICAL_CONTEXT_*.md
- QUICK_START_NEXT_SESSION_*.md
- NEXT_SESSION_*.md

### Review Before Archiving
- Security audit reports (may need to keep for compliance)
- Release documentation (keep current release docs active)
- Architecture decisions (may still be relevant)

### Never Archive
- DEVELOPMENT_WORKFLOW.md
- Current release checklists
- Active work tracking files
- Security policies and procedures

## Archiving Process

1. **Monthly Review**: First week of each month
2. **Run Archive Script**: `./scripts/archive-old-docs.sh`
3. **Manual Process** (if script unavailable):
   ```bash
   # Example: Archive files older than 7 days
   YEAR=$(date +%Y)
   MONTH=$(date +%m)
   mkdir -p docs/archive/$YEAR/$MONTH
   
   # Archive session files
   find docs/development -name "SESSION_*" -mtime +7 -exec mv {} docs/archive/$YEAR/$MONTH/ \;
   find docs/development -name "CONTEXT_*" -mtime +7 -exec mv {} docs/archive/$YEAR/$MONTH/ \;
   
   # Fix references after archiving
   ./scripts/fix-archived-references.sh
   ```

## Accessing Archived Documents
Archived documents remain in the git history and can be accessed at:
- `docs/archive/YYYY/MM/[filename]`

## Automation

### GitHub Actions Workflow Example

Create `.github/workflows/archive-docs.yml`:
```yaml
name: Archive Old Documentation
on:
  schedule:
    - cron: '0 9 * * 1'  # Every Monday at 9 AM
  workflow_dispatch:      # Allow manual trigger

jobs:
  archive:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      
      - name: Run archiving script
        run: |
          chmod +x ./scripts/archive-old-docs.sh
          ./scripts/archive-old-docs.sh
          
      - name: Create Pull Request
        uses: peter-evans/create-pull-request@v5
        with:
          title: "Archive old documentation files"
          body: "Automated archiving of documentation files older than 7 days"
          branch: automated-archive-${{ github.run_number }}
```

### Pre-commit Hook Example

Create `.git/hooks/pre-commit`:
```bash
#!/bin/bash
# Check for old files that should be archived
OLD_FILES=$(find docs/development -name "SESSION_*" -o -name "CONTEXT_*" -mtime +7 2>/dev/null)
if [ ! -z "$OLD_FILES" ]; then
  echo "Warning: Found old files that should be archived:"
  echo "$OLD_FILES"
  echo "Run: ./scripts/archive-old-docs.sh"
fi
```

### Archive Script Implementation

See `scripts/archive-old-docs.sh` for the complete implementation.