#!/bin/bash
# Cross-platform helper functions for integration tests
# Ensures compatibility across macOS, Linux, and Windows (Git Bash)

# Generate a random hex suffix (cross-platform)
# Uses printf instead of md5sum/md5 for portability
generate_random_suffix() {
    local length=${1:-4}  # Default to 4 characters
    # Use $RANDOM if available (bash), otherwise use timestamp
    if [ -n "$RANDOM" ]; then
        printf "%0${length}x" $((RANDOM % (16**length)))
    else
        # Fallback for shells without $RANDOM
        # Use last digits of nanoseconds from date if available
        local ns=$(date +%N 2>/dev/null || echo "000000")
        printf "%0${length}x" $((${ns: -6} % (16**length)))
    fi
}

# Check if a command exists (cross-platform)
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Get the script directory (cross-platform)
get_script_dir() {
    local source="${BASH_SOURCE[0]}"
    # Resolve symlinks
    while [ -h "$source" ]; do
        local dir="$(cd -P "$(dirname "$source")" && pwd)"
        source="$(readlink "$source")"
        [[ $source != /* ]] && source="$dir/$source"
    done
    echo "$(cd -P "$(dirname "$source")" && pwd)"
}

# Detect the operating system
detect_os() {
    case "$OSTYPE" in
        darwin*)  echo "macos" ;;
        linux*)   echo "linux" ;;
        msys*)    echo "windows" ;;
        cygwin*)  echo "windows" ;;
        win32*)   echo "windows" ;;
        *)        echo "unknown" ;;
    esac
}

# Create a temporary directory (cross-platform)
create_temp_dir() {
    local prefix="${1:-test}"
    if command_exists mktemp; then
        mktemp -d -t "${prefix}.XXXXXX" 2>/dev/null || mktemp -d
    else
        # Fallback for systems without mktemp
        local tmpdir="/tmp/${prefix}.$$"
        mkdir -p "$tmpdir" && echo "$tmpdir"
    fi
}

# Get home directory (cross-platform)
get_home_dir() {
    # Try HOME first (Unix-like)
    if [ -n "$HOME" ]; then
        echo "$HOME"
    # Try USERPROFILE (Windows)
    elif [ -n "$USERPROFILE" ]; then
        echo "$USERPROFILE"
    # Fallback to tilde expansion
    else
        echo ~
    fi
}

# Normalize path separators for the current OS
normalize_path() {
    local path="$1"
    case "$(detect_os)" in
        windows)
            # Convert forward slashes to backslashes for Windows
            echo "$path" | tr '/' '\\'
            ;;
        *)
            # Keep forward slashes for Unix-like systems
            echo "$path"
            ;;
    esac
}

# Check if running in CI environment
is_ci_environment() {
    # Check common CI environment variables
    [ -n "$CI" ] || [ -n "$CONTINUOUS_INTEGRATION" ] || \
    [ -n "$GITHUB_ACTIONS" ] || [ -n "$JENKINS_URL" ] || \
    [ -n "$TRAVIS" ] || [ -n "$CIRCLECI" ] || \
    [ -n "$GITLAB_CI" ] || [ -n "$BUILDKITE" ]
}

# Print colored output (respects NO_COLOR env var and CI environments)
print_color() {
    local color="$1"
    local message="$2"
    
    # Disable colors if NO_COLOR is set or in CI (unless FORCE_COLOR is set)
    if [ -n "$NO_COLOR" ] || (is_ci_environment && [ -z "$FORCE_COLOR" ]); then
        echo "$message"
        return
    fi
    
    # Color codes
    local red='\033[0;31m'
    local green='\033[0;32m'
    local yellow='\033[1;33m'
    local blue='\033[0;34m'
    local nc='\033[0m'  # No color
    
    case "$color" in
        red)    echo -e "${red}${message}${nc}" ;;
        green)  echo -e "${green}${message}${nc}" ;;
        yellow) echo -e "${yellow}${message}${nc}" ;;
        blue)   echo -e "${blue}${message}${nc}" ;;
        *)      echo "$message" ;;
    esac
}

# Export functions if sourced
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
    export -f generate_random_suffix
    export -f command_exists
    export -f get_script_dir
    export -f detect_os
    export -f create_temp_dir
    export -f get_home_dir
    export -f normalize_path
    export -f is_ci_environment
    export -f print_color
fi