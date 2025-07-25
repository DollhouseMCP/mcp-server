#!/bin/bash

# Smart archiving script that parses dates from filenames
# Archives files with dates older than 7 days in their names

echo "🧠 Starting smart documentation archiving..."

# Configuration
DAYS_OLD=7
DOCS_DIR="docs/development"
ARCHIVE_BASE="docs/archive"
CURRENT_DATE=$(date +%Y-%m-%d)
CUTOFF_DATE=$(date -d "$DAYS_OLD days ago" +%Y-%m-%d 2>/dev/null || date -v -${DAYS_OLD}d +%Y-%m-%d)
CUTOFF_TIMESTAMP=$(date -d "$CUTOFF_DATE" +%s 2>/dev/null || date -j -f "%Y-%m-%d" "$CUTOFF_DATE" +%s)

echo "📅 Current date: $CURRENT_DATE"
echo "📅 Cutoff date: $CUTOFF_DATE (files older than this will be archived)"

# Read never-archive list
NEVER_ARCHIVE_LIST="scripts/never-archive-list.txt"
NEVER_ARCHIVE_FILES=()
if [ -f "$NEVER_ARCHIVE_LIST" ]; then
    while IFS= read -r line; do
        # Skip comments and empty lines
        [[ "$line" =~ ^#.*$ ]] || [[ -z "$line" ]] && continue
        # Handle wildcards
        if [[ "$line" =~ \* ]]; then
            pattern="${line%\*}"
            for file in $DOCS_DIR/$line; do
                if [ -f "$file" ]; then
                    filename=$(basename "$file")
                    NEVER_ARCHIVE_FILES+=("$filename")
                fi
            done
        else
            NEVER_ARCHIVE_FILES+=("$line")
        fi
    done < "$NEVER_ARCHIVE_LIST"
fi

# Function to check if file is in never-archive list
is_never_archive() {
    local filename="$1"
    for never_file in "${NEVER_ARCHIVE_FILES[@]}"; do
        if [ "$filename" = "$never_file" ]; then
            return 0
        fi
    done
    return 1
}

# Function to parse date from filename
parse_date_from_filename() {
    local filename="$1"
    local file_date=""
    
    # Pattern 1: YYYY_MM_DD or YYYY-MM-DD
    if [[ "$filename" =~ (2025)[_-](0[1-9]|1[0-2])[_-](0[1-9]|[12][0-9]|3[01]) ]]; then
        file_date="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
    # Pattern 2: JULY_DD or July_DD (case insensitive)
    elif [[ "$filename" =~ (JULY|July)[_-]?([0-9]{1,2}) ]]; then
        day=$(printf "%02d" "${BASH_REMATCH[2]}")
        file_date="2025-07-$day"
    # Pattern 3: Month names followed by day
    elif [[ "$filename" =~ (JUNE|June)[_-]?([0-9]{1,2}) ]]; then
        day=$(printf "%02d" "${BASH_REMATCH[2]}")
        file_date="2025-06-$day"
    fi
    
    echo "$file_date"
}

# Function to check if date is older than cutoff
is_date_old() {
    local file_date="$1"
    
    # Convert file date to timestamp
    local file_timestamp=$(date -d "$file_date" +%s 2>/dev/null || date -j -f "%Y-%m-%d" "$file_date" +%s 2>/dev/null)
    
    if [ -z "$file_timestamp" ]; then
        return 1  # Invalid date
    fi
    
    # Compare timestamps
    if [ "$file_timestamp" -lt "$CUTOFF_TIMESTAMP" ]; then
        return 0  # Old file
    else
        return 1  # Recent file
    fi
}

# Count files to archive
echo ""
echo "🔍 Analyzing files..."
FILES_TO_ARCHIVE=()

for file in $DOCS_DIR/*.md; do
    [ -f "$file" ] || continue
    
    filename=$(basename "$file")
    
    # Check if file is in never-archive list
    if is_never_archive "$filename"; then
        echo "  ⚡ Keeping (protected): $filename"
        continue
    fi
    
    # Parse date from filename
    file_date=$(parse_date_from_filename "$filename")
    
    if [ -n "$file_date" ]; then
        if is_date_old "$file_date"; then
            echo "  📅 Will archive: $filename (date: $file_date)"
            FILES_TO_ARCHIVE+=("$file")
        else
            echo "  ✓ Keeping (recent): $filename (date: $file_date)"
        fi
    fi
done

# Check if any files need archiving
if [ ${#FILES_TO_ARCHIVE[@]} -eq 0 ]; then
    echo ""
    echo "✅ No files with old dates found. Nothing to archive."
    exit 0
fi

echo ""
echo "📊 Found ${#FILES_TO_ARCHIVE[@]} files to archive based on filename dates"

# Create archive directory
ARCHIVE_YEAR=$(date +%Y)
ARCHIVE_MONTH=$(date +%m)
ARCHIVE_DIR="$ARCHIVE_BASE/$ARCHIVE_YEAR/$ARCHIVE_MONTH"
mkdir -p "$ARCHIVE_DIR"

# Archive files
echo ""
echo "📦 Archiving files..."
ARCHIVED_COUNT=0
FAILED_COUNT=0

for file in "${FILES_TO_ARCHIVE[@]}"; do
    filename=$(basename "$file")
    echo "  Moving: $filename"
    
    if mv "$file" "$ARCHIVE_DIR/"; then
        ARCHIVED_COUNT=$((ARCHIVED_COUNT + 1))
    else
        echo "    ❌ Failed to archive: $filename"
        FAILED_COUNT=$((FAILED_COUNT + 1))
    fi
done

echo ""
echo "📈 Archive Summary:"
echo "  - Files archived: $ARCHIVED_COUNT"
echo "  - Files failed: $FAILED_COUNT"
echo "  - Archive location: $ARCHIVE_DIR"

# Fix references
if [ $ARCHIVED_COUNT -gt 0 ]; then
    echo ""
    echo "🔧 Fixing references to archived files..."
    
    if [ -f "scripts/fix-archived-references.sh" ]; then
        ./scripts/fix-archived-references.sh
    else
        echo "⚠️  Reference fix script not found."
    fi
fi

echo ""
echo "✨ Smart archiving complete!"

# Provide git status
if [ $ARCHIVED_COUNT -gt 0 ]; then
    echo ""
    echo "📝 Next steps:"
    echo "  1. Review changes: git status"
    echo "  2. Stage changes: git add -A"
    echo "  3. Commit: git commit -m \"Archive files with dates older than $DAYS_OLD days\""
fi