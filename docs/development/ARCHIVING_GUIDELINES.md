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
2. **Run Archive Script**: `scripts/archive-old-docs.sh` (if available)
3. **Manual Process**:
   ```bash
   # Example: Archive July 2025 files
   mkdir -p docs/archive/2025/07
   find docs/development -name "SESSION_*" -mtime +7 -exec mv {} docs/archive/2025/07/ \;
   ```

## Accessing Archived Documents
Archived documents remain in the git history and can be accessed at:
- `docs/archive/YYYY/MM/[filename]`

## Automation
Consider implementing automated archiving via:
- GitHub Actions workflow running weekly
- Pre-commit hook to check file age
- Script to move files based on criteria above