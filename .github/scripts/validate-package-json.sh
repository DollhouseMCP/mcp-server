#!/bin/bash

# validate-package-json.sh
# Ultra-robust JSON parsing with comprehensive error handling and multiple fallbacks
# Usage: ./validate-package-json.sh [expected_name] [expected_main]

set -euo pipefail

# Parameters
EXPECTED_NAME="${1:-dollhousemcp}"
EXPECTED_MAIN="${2:-dist/index.js}"
PACKAGE_FILE="${3:-package.json}"

echo "🔍 Attempting JSON parsing with multiple fallback strategies..."

# Initialize variables
NAME=""
MAIN=""
PARSE_SUCCESS=false

# Strategy 1: Try jq (most reliable for JSON parsing)
if command -v jq &> /dev/null; then
  echo "📊 Attempting jq parsing..."
  if jq empty "$PACKAGE_FILE" 2>/dev/null; then
    NAME=$(jq -r '.name // ""' "$PACKAGE_FILE" 2>/dev/null)
    MAIN=$(jq -r '.main // ""' "$PACKAGE_FILE" 2>/dev/null)
    if [ -n "$NAME" ] && [ -n "$MAIN" ]; then
      echo "✅ jq parsing successful"
      PARSE_SUCCESS=true
    else
      echo "⚠️  jq parsing incomplete - missing fields"
    fi
  else
    echo "⚠️  jq parsing failed - invalid JSON"
  fi
else
  echo "⚠️  jq not available"
fi

# Strategy 2: Try node.js with enhanced error handling
if [ "$PARSE_SUCCESS" = false ]; then
  echo "📊 Attempting Node.js parsing..."
  if [ -f "$PACKAGE_FILE" ]; then
    # Test if file is readable and valid JSON
    if node -e "JSON.parse(require(\"fs\").readFileSync(\"$PACKAGE_FILE\", \"utf8\"))" 2>/dev/null; then
      NAME=$(node -e "try { 
        const pkg = JSON.parse(require(\"fs\").readFileSync(\"$PACKAGE_FILE\", \"utf8\")); 
        console.log(pkg.name || \"\"); 
      } catch(e) { 
        console.log(\"\"); 
        process.exit(1); 
      }" 2>/dev/null || echo "")
      MAIN=$(node -e "try { 
        const pkg = JSON.parse(require(\"fs\").readFileSync(\"$PACKAGE_FILE\", \"utf8\")); 
        console.log(pkg.main || \"\"); 
      } catch(e) { 
        console.log(\"\"); 
        process.exit(1); 
      }" 2>/dev/null || echo "")
      if [ -n "$NAME" ] && [ -n "$MAIN" ]; then
        echo "✅ Node.js parsing successful"
        PARSE_SUCCESS=true
      else
        echo "⚠️  Node.js parsing incomplete - missing fields"
      fi
    else
      echo "⚠️  Node.js parsing failed - invalid JSON structure"
    fi
  else
    echo "⚠️  $PACKAGE_FILE file not found"
  fi
fi

# Strategy 3: Try python as final fallback
if [ "$PARSE_SUCCESS" = false ] && command -v python3 &> /dev/null; then
  echo "📊 Attempting Python parsing..."
  NAME=$(python3 -c "import json, sys; 
  try: 
    with open(\"$PACKAGE_FILE\") as f: 
      data = json.load(f); 
      print(data.get(\"name\", \"\"))
  except: 
    print(\"\"); 
    sys.exit(1)" 2>/dev/null || echo "")
  MAIN=$(python3 -c "import json, sys; 
  try: 
    with open(\"$PACKAGE_FILE\") as f: 
      data = json.load(f); 
      print(data.get(\"main\", \"\"))
  except: 
    print(\"\"); 
    sys.exit(1)" 2>/dev/null || echo "")
  if [ -n "$NAME" ] && [ -n "$MAIN" ]; then
    echo "✅ Python parsing successful"
    PARSE_SUCCESS=true
  else
    echo "⚠️  Python parsing incomplete - missing fields"
  fi
fi

# Final validation
if [ "$PARSE_SUCCESS" = false ]; then
  echo "❌ All JSON parsing strategies failed"
  echo "🔍 Debugging information:"
  echo "  - File exists: $([ -f "$PACKAGE_FILE" ] && echo 'Yes' || echo 'No')"
  echo "  - File readable: $([ -r "$PACKAGE_FILE" ] && echo 'Yes' || echo 'No')"
  echo "  - File size: $(wc -c < "$PACKAGE_FILE" 2>/dev/null || echo 'Unknown') bytes"
  echo "  - Available parsers: $(command -v jq &>/dev/null && echo 'jq' || echo 'no-jq') $(command -v node &>/dev/null && echo 'node' || echo 'no-node') $(command -v python3 &>/dev/null && echo 'python3' || echo 'no-python3')"
  echo "  - First 200 chars: $(head -c 200 "$PACKAGE_FILE" 2>/dev/null || echo 'Cannot read file')"
  exit 1
fi

# Validate parsed values
if [ -z "$NAME" ]; then
  echo "❌ Failed to parse $PACKAGE_FILE name or name is empty"
  exit 1
fi
if [ -z "$MAIN" ]; then
  echo "❌ Failed to parse $PACKAGE_FILE main or main is empty"
  exit 1
fi

# Validate expected values
if [ "$NAME" != "$EXPECTED_NAME" ]; then
  echo "❌ Invalid package name: '$NAME', expected '$EXPECTED_NAME'"
  exit 1
fi
echo "✅ Package name correct: $NAME"

if [ "$MAIN" != "$EXPECTED_MAIN" ]; then
  echo "❌ Invalid main entry: '$MAIN', expected '$EXPECTED_MAIN'"
  exit 1
fi
echo "✅ Main entry correct: $MAIN"

echo "🎯 JSON validation completed successfully!"