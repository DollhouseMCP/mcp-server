#!/bin/bash

# Archive old documentation files to keep docs/development clean
# This script moves files older than 7 days to the archive directory

echo "🗂️  Starting documentation archiving process..."

# Configuration
DAYS_OLD=7
DOCS_DIR="docs/development"
ARCHIVE_BASE="docs/session-history"
CURRENT_YEAR=$(date +%Y)
CURRENT_MONTH=$(date +%m)
ARCHIVE_DIR="$ARCHIVE_BASE/$CURRENT_YEAR/$CURRENT_MONTH"

# Files to archive (patterns)
PATTERNS=(
    "SESSION_SUMMARY_*"
    "SESSION_HANDOFF_*"
    "SESSION_NOTES_*"
    "SESSION_CONTEXT_*"
    "SESSION_END_*"
    "SESSION_WRAP_*"
    "CONTEXT_HANDOFF_*"
    "CONTEXT_NOTES_*"
    "CONTEXT_COMPACT_*"
    "CRITICAL_CONTEXT_*"
    "CRITICAL_NOTES_*"
    "QUICK_START_NEXT_SESSION_*"
    "QUICK_REFERENCE_NEXT_SESSION_*"
    "NEXT_SESSION_*"
)

# Create archive directory if it doesn't exist
mkdir -p "$ARCHIVE_DIR"

# Count files to be archived
TOTAL_FILES=0
for pattern in "${PATTERNS[@]}"; do
    COUNT=$(find "$DOCS_DIR" -maxdepth 1 -name "$pattern" -type f -mtime +$DAYS_OLD 2>/dev/null | wc -l)
    TOTAL_FILES=$((TOTAL_FILES + COUNT))
done

if [ $TOTAL_FILES -eq 0 ]; then
    echo "✅ No files older than $DAYS_OLD days found. Nothing to archive."
    exit 0
fi

echo "📊 Found $TOTAL_FILES files to archive (older than $DAYS_OLD days)"

# Archive files
ARCHIVED_COUNT=0
FAILED_COUNT=0

for pattern in "${PATTERNS[@]}"; do
    while IFS= read -r file; do
        if [ -f "$file" ]; then
            filename=$(basename "$file")
            echo "  📄 Archiving: $filename"
            
            if mv "$file" "$ARCHIVE_DIR/"; then
                ARCHIVED_COUNT=$((ARCHIVED_COUNT + 1))
            else
                echo "    ❌ Failed to archive: $filename"
                FAILED_COUNT=$((FAILED_COUNT + 1))
            fi
        fi
    done < <(find "$DOCS_DIR" -maxdepth 1 -name "$pattern" -type f -mtime +$DAYS_OLD 2>/dev/null)
done

echo ""
echo "📈 Archive Summary:"
echo "  - Files archived: $ARCHIVED_COUNT"
echo "  - Files failed: $FAILED_COUNT"
echo "  - Archive location: $ARCHIVE_DIR"

# Fix references in remaining files
if [ $ARCHIVED_COUNT -gt 0 ]; then
    echo ""
    echo "🔧 Fixing references to archived files..."
    
    # Check if reference fix script exists
    if [ -f "scripts/fix-archived-references.sh" ]; then
        ./scripts/fix-archived-references.sh
    else
        echo "⚠️  Reference fix script not found. Please run manually: ./scripts/fix-archived-references.sh"
    fi
fi

# Remove empty subdirectories
echo ""
echo "🧹 Cleaning up empty directories..."
find "$DOCS_DIR" -type d -empty -delete 2>/dev/null

echo ""
echo "✨ Archiving complete!"

# Provide git status summary
if [ $ARCHIVED_COUNT -gt 0 ]; then
    echo ""
    echo "📝 Git status:"
    echo "  Run 'git status' to see moved files"
    echo "  Run 'git add -A' to stage all changes"
    echo "  Run 'git commit -m \"Archive old documentation files\"' to commit"
fi

exit 0