#!/bin/bash
# Helper script to detect GitHub username for integration tests
# Can be sourced by other scripts or run standalone

# Function to detect GitHub user
detect_github_user() {
    local user=""
    
    # First, check if GITHUB_USER environment variable is set
    if [ -n "$GITHUB_USER" ]; then
        user="$GITHUB_USER"
        echo "Using GITHUB_USER environment variable: $user" >&2
    fi
    
    # If not set, try to auto-detect from gh CLI
    if [ -z "$user" ]; then
        user=$(gh api user --jq .login 2>/dev/null || echo "")
        if [ -n "$user" ]; then
            echo "Auto-detected from GitHub CLI: $user" >&2
        fi
    fi
    
    # If still not found, try git config
    if [ -z "$user" ]; then
        user=$(git config --global github.user 2>/dev/null || echo "")
        if [ -n "$user" ]; then
            echo "Auto-detected from git config (github.user): $user" >&2
        fi
    fi
    
    # If still not found, try git user.name (less reliable)
    if [ -z "$user" ]; then
        local git_name=$(git config --global user.name 2>/dev/null || echo "")
        if [ -n "$git_name" ]; then
            echo "Warning: Using git user.name as fallback (may not match GitHub username): $git_name" >&2
            user="$git_name"
        fi
    fi
    
    # Return the detected user
    echo "$user"
}

# If script is run directly (not sourced), print the username
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    user=$(detect_github_user)
    if [ -z "$user" ]; then
        echo "Error: Could not detect GitHub username" >&2
        echo "Please set GITHUB_USER environment variable or authenticate with 'gh auth login'" >&2
        exit 1
    fi
    echo "$user"
fi