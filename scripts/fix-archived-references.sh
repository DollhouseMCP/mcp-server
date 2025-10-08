#!/bin/bash

# Fix references to archived documentation files
# This script updates references in docs/development to point to archived files

echo "🔍 Finding and fixing references to archived files..."

ARCHIVE_BASE="docs/session-history"

# Counter for fixed references
FIXED_COUNT=0
TOTAL_REFS=0

# Create a temporary file to store all fixes
FIXES_FILE=$(mktemp)

# Build associative array of archived files
# Key: filename, Value: relative path from session-history (e.g., "2025/07/FILENAME.md")
declare -A ARCHIVED_PATHS

# Find all archived markdown files and store their paths
while IFS= read -r archive_file; do
    if [ -f "$archive_file" ]; then
        filename=$(basename "$archive_file")
        # Get the relative path from docs/session-history/
        relative_path="${archive_file#$ARCHIVE_BASE/}"
        ARCHIVED_PATHS["$filename"]="$relative_path"
    fi
done < <(find "$ARCHIVE_BASE" -type f -name "*.md")

if [ ${#ARCHIVED_PATHS[@]} -eq 0 ]; then
    echo "⚠️  No archived files found in $ARCHIVE_BASE"
    exit 0
fi

echo "📚 Found ${#ARCHIVED_PATHS[@]} archived files across all date directories"

# For each file in docs/development
for doc_file in docs/development/*.md; do
    if [ -f "$doc_file" ]; then
        # Skip if it's a directory
        [ -d "$doc_file" ] && continue

        # For each archived file
        for filename in "${!ARCHIVED_PATHS[@]}"; do
            relative_path="${ARCHIVED_PATHS[$filename]}"

            # Check if this document references the archived file
            if grep -q "$filename" "$doc_file"; then
                echo "📄 Found reference to $filename in $(basename $doc_file)"

                # Count references
                REF_COUNT=$(grep -c "$filename" "$doc_file")
                TOTAL_REFS=$((TOTAL_REFS + REF_COUNT))

                # Replace references to point to archive
                # Handle various reference patterns:
                # 1. Markdown links: [text](path/file.md)
                # 2. Reference links: [text]: path/file.md
                # 3. Direct paths: /docs/development/file.md or docs/development/file.md
                # 4. Backtick references: `path/file.md`

                # Direct path references (with or without leading slash)
                sed -i.bak -E "s|/?docs/development/${filename}|${ARCHIVE_BASE}/${relative_path}|g" "$doc_file"

                # Relative path references (e.g., ./file.md or ../development/file.md)
                sed -i.bak -E "s|\.\.?/+([^/]*/)*(${filename})|../${relative_path//\//\\/}|g" "$doc_file"

                # Check if file was actually modified
                if ! cmp -s "$doc_file" "$doc_file.bak"; then
                    FIXED_COUNT=$((FIXED_COUNT + 1))
                    echo "  ✅ Updated references to ${ARCHIVE_BASE}/${relative_path}" >> "$FIXES_FILE"
                    # Remove backup
                    rm "$doc_file.bak"
                else
                    # No changes made, remove backup
                    rm "$doc_file.bak"
                fi
            fi
        done
    fi
done

echo ""
echo "📊 Summary:"
echo "  - Total references found: $TOTAL_REFS"
echo "  - Files updated: $FIXED_COUNT"

if [ $FIXED_COUNT -gt 0 ]; then
    echo ""
    echo "📝 Files updated:"
    cat "$FIXES_FILE"
fi

# Cleanup
rm -f "$FIXES_FILE"

echo ""
echo "✨ Done! All references to archived files have been updated."
