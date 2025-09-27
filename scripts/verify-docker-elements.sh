#!/bin/bash

# Verify what DollhouseMCP elements are available in Docker Claude Code instance

echo "🐳 Checking DollhouseMCP elements in Docker instance..."
echo "=========================================="
echo ""

# Run Docker container and query available elements
docker run --rm \
  -v $(pwd):/workspace \
  dollhousemcp:latest \
  node -e "
const { DollhouseMCPServer } = require('./dist');

async function checkElements() {
  try {
    const server = new DollhouseMCPServer();
    await server.initialize();

    console.log('📋 Checking available MCP tools...');
    const tools = server.getAvailableTools();
    console.log('Available tools:', tools.map(t => t.name));

    console.log('\\n🎭 Checking available personas...');
    const personas = await server.listElements('personas');
    console.log('Available personas:', personas.length);
    personas.slice(0, 5).forEach(p => {
      console.log('  -', p.name || p.id);
    });

    console.log('\\n💡 Checking available skills...');
    const skills = await server.listElements('skills');
    console.log('Available skills:', skills.length);

    console.log('\\n🧠 Checking available memories...');
    const memories = await server.listElements('memories');
    console.log('Available memories:', memories.length);

  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkElements();
" 2>/dev/null || echo "Direct query failed, trying MCP protocol..."

# Alternative: Use MCP protocol directly
echo ""
echo "Trying MCP protocol query..."
echo ""

docker run --rm \
  -e DOLLHOUSE_PORTFOLIO_DIR=/tmp/portfolio \
  dollhousemcp:latest \
  /bin/sh -c '
    # Start server and send MCP commands
    node dist/index.js &
    SERVER_PID=$!
    sleep 2

    # Send list_elements command via MCP protocol
    echo "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"list_elements\",\"arguments\":{\"type\":\"personas\"}},\"id\":1}" | nc localhost 3000

    kill $SERVER_PID
  ' 2>/dev/null || echo "MCP query also failed"

echo ""
echo "📝 Note: If both methods failed, we need to adjust our approach"
echo "The Docker container might have different elements or configuration"