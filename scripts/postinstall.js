#!/usr/bin/env node

console.log(`
╔════════════════════════════════════════════════════════════════╗
║                                                                ║
║  🎭 DollhouseMCP Successfully Installed!                       ║
║                                                                ║
║  To complete setup for Claude Desktop, run:                   ║
║                                                                ║
║    npx @dollhousemcp/setup                                     ║
║                                                                ║
║  Or manually add to your Claude Desktop config:               ║
║                                                                ║
║    {                                                           ║
║      "mcpServers": {                                           ║
║        "dollhousemcp": {                                       ║
║          "command": "npx",                                     ║
║          "args": ["@dollhousemcp/mcp-server"]                 ║
║        }                                                       ║
║      }                                                         ║
║    }                                                           ║
║                                                                ║
║  📖 Full docs: https://github.com/DollhouseMCP/mcp-server     ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
`);