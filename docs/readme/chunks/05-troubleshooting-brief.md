## 🔧 Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| **Personas not loading** | Check `~/.dollhouse/portfolio/personas/` directory exists |
| **Server won't start** | Ensure Node.js v20+ is installed: `node --version` |
| **Collection not working** | Check internet connection and GitHub API access |
| **Tools not appearing in Claude** | Restart Claude Desktop completely after config changes |
| **"Cannot find module" errors** | Reinstall: `npm install -g @dollhousemcp/mcp-server@latest` |
| **Rate limit errors** | Wait 60 seconds; GitHub API has hourly limits |

### Need Help?

- 📖 [Full Troubleshooting Guide](docs/TROUBLESHOOTING.md)
- 💬 [GitHub Issues](https://github.com/DollhouseMCP/mcp-server/issues)
- 💭 [GitHub Discussions](https://github.com/DollhouseMCP/mcp-server/discussions)