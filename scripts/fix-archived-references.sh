#!/bin/bash

# Fix references to archived documentation files
# This script updates references in docs/development to point to archived files

echo "🔍 Finding and fixing references to archived files..."

# Get list of archived files (just filenames)
ARCHIVED_FILES=$(ls docs/session-history/2025/07/ | grep -E "\.md$")

# Counter for fixed references
FIXED_COUNT=0
TOTAL_REFS=0

# Create a temporary file to store all fixes
FIXES_FILE=$(mktemp)

# For each file in docs/development
for doc_file in docs/development/*.md; do
    if [ -f "$doc_file" ]; then
        # Skip if it's a directory
        [ -d "$doc_file" ] && continue
        
        # For each archived file
        for archived in $ARCHIVED_FILES; do
            # Check if this document references the archived file
            if grep -q "$archived" "$doc_file"; then
                echo "📄 Found reference to $archived in $(basename $doc_file)"
                
                # Count references
                REF_COUNT=$(grep -c "$archived" "$doc_file")
                TOTAL_REFS=$((TOTAL_REFS + REF_COUNT))
                
                # Replace references to point to archive
                # Handle various reference patterns:
                # 1. Markdown links: [text](path/file.md)
                # 2. Reference links: [text]: path/file.md
                # 3. Direct paths: /docs/development/file.md or docs/development/file.md
                # 4. Backtick references: `path/file.md`
                
                # Direct path references (with or without leading slash)
                sed -i.bak -E "s|/?docs/development/${archived}|docs/session-history/2025/07/${archived}|g" "$doc_file"

                # Relative path references (e.g., ./file.md or ../development/file.md)
                sed -i.bak -E "s|\.\.?/+([^/]*/)*(${archived})|../session-history/2025/07/\\2|g" "$doc_file"
                
                # Check if file was actually modified
                if ! cmp -s "$doc_file" "$doc_file.bak"; then
                    FIXED_COUNT=$((FIXED_COUNT + 1))
                    echo "  ✅ Updated references in $(basename $doc_file)" >> "$FIXES_FILE"
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