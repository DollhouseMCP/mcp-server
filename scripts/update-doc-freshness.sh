#!/bin/bash
# Script to automatically update document freshness indicators in docs/README.md
# Usage: ./scripts/update-doc-freshness.sh

set -e

echo "🔄 Updating document freshness indicators..."

# Create scripts directory if it doesn't exist
mkdir -p scripts

# Get current date for comparison
CURRENT_DATE=$(date +%s)
TWO_DAYS_AGO=$((CURRENT_DATE - 172800)) # 2 days in seconds

# Function to determine freshness
get_freshness() {
    local file_path=$1
    local mod_date_str=$2
    
    # Convert modification date to epoch seconds
    local mod_date=$(date -j -f "%Y-%m-%d" "$mod_date_str" +%s 2>/dev/null || echo "0")
    
    if [ "$mod_date" -gt "$TWO_DAYS_AGO" ]; then
        echo "Fresh"
    else
        echo "Aging"
    fi
}

# Get modification dates for all documentation files
declare -A file_dates
while IFS= read -r line; do
    file=$(echo "$line" | cut -d: -f1)
    date=$(echo "$line" | cut -d: -f2 | tr -d ' ')
    filename=$(basename "$file")
    file_dates["$filename"]="$date"
done < <(find docs/ -name "*.md" -not -name "README.md" -exec stat -f "%N: %Sm" -t "%Y-%m-%d" {} \;)

echo "📋 Found ${#file_dates[@]} documentation files to process"

# Update the README.md file with current freshness indicators
README_FILE="docs/README.md"
TEMP_FILE=$(mktemp)

# Process the README file and update freshness indicators
while IFS= read -r line; do
    updated_line="$line"
    
    # Look for lines with markdown file references and existing freshness indicators
    if [[ "$line" =~ \*\*([^*]+\.md)\*\* && "$line" =~ \*\[(Fresh|Aging):[[:space:]]*[0-9]{4}-[0-9]{2}-[0-9]{2}\]\* ]]; then
        filename=$(echo "$line" | sed -n 's/.*\*\*\([^*]*\.md\)\*\*.*/\1/p')
        
        if [[ -n "${file_dates[$filename]}" ]]; then
            date="${file_dates[$filename]}"
            freshness=$(get_freshness "$filename" "$date")
            
            # Replace the existing freshness indicator
            updated_line=$(echo "$line" | sed "s/\*\[(Fresh|Aging):[[:space:]]*[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}\]\*/\*[$freshness: $date]\*/")
            
            echo "  📄 Updated $filename: $freshness ($date)"
        fi
    fi
    
    echo "$updated_line" >> "$TEMP_FILE"
done < "$README_FILE"

# Replace the original file
mv "$TEMP_FILE" "$README_FILE"

echo "✅ Documentation freshness indicators updated successfully!"
echo "📝 Don't forget to commit the changes if they look correct."