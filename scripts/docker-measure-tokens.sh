#!/bin/bash
# Measure actual MCP tool tokens in Docker for each configuration

set -e

echo "=============================================================================="
echo "  MCP TOOL TOKEN MEASUREMENT - DOCKER"
echo "=============================================================================="
echo ""

# Function to measure tokens for a configuration
measure_config() {
    local mode=$1
    local aql_mode=$2
    local label=$3

    echo "Testing: $label"
    echo "  MCP_INTERFACE_MODE=$mode MCP_AQL_ENDPOINT_MODE=$aql_mode"
    echo ""

    # Create the MCP initialize and tools/list request
    local request='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"token-measure","version":"1.0.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

    # Run the container and send the request
    local response=$(echo "$request" | docker run --rm -i \
        -e MCP_INTERFACE_MODE="$mode" \
        -e MCP_AQL_ENDPOINT_MODE="$aql_mode" \
        -e NODE_ENV=production \
        dollhousemcp-token-test 2>/dev/null)

    # Extract the tools/list response (second JSON object)
    local tools_response=$(echo "$response" | grep -o '{"jsonrpc":"2.0","id":2.*' | head -1)

    if [ -z "$tools_response" ]; then
        echo "  ERROR: Could not get tools response"
        echo "  Raw response: $response"
        return 1
    fi

    # Count tools and estimate tokens
    local tool_count=$(echo "$tools_response" | jq '.result.tools | length')
    local json_length=$(echo "$tools_response" | jq -c '.result.tools' | wc -c)
    local token_estimate=$((json_length / 4))

    echo "  Tool count: $tool_count"
    echo "  JSON length: $json_length chars"
    echo "  Token estimate: ~$token_estimate tokens"
    echo ""

    # List individual tools
    echo "  Tools:"
    echo "$tools_response" | jq -r '.result.tools[].name' | while read tool; do
        local tool_json=$(echo "$tools_response" | jq -c ".result.tools[] | select(.name==\"$tool\")")
        local tool_len=$(echo "$tool_json" | wc -c)
        local tool_tokens=$((tool_len / 4))
        echo "    $tool: ~$tool_tokens tokens"
    done
    echo ""
}

echo "=============================================================================="
echo "  CONFIGURATION 1: DISCRETE TOOLS"
echo "=============================================================================="
measure_config "discrete" "crude" "Discrete (42+ individual tools)"

echo "=============================================================================="
echo "  CONFIGURATION 2: CRUDE ENDPOINTS (5 tools)"
echo "  (Create, Read, Update, Delete, Execute)"
echo "=============================================================================="
measure_config "mcpaql" "crude" "MCP-AQL CRUDE (5 endpoints)"

echo "=============================================================================="
echo "  CONFIGURATION 3: SINGLE ENDPOINT (1 tool)"
echo "=============================================================================="
measure_config "mcpaql" "single" "MCP-AQL Single (1 endpoint)"

echo "=============================================================================="
echo "  MEASUREMENT COMPLETE"
echo "=============================================================================="
