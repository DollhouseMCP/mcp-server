## 🎯 Troubleshooting

### Common Issues

#### MCP Server Not Connecting

**Symptoms**: Claude Desktop doesn't show DollhouseMCP in available servers

**Solutions**:
1. Verify configuration file location:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
2. Check JSON syntax is valid
3. Restart Claude Desktop after configuration changes

#### OAuth Authentication Fails

**Symptoms**: Cannot authenticate with GitHub

**Solutions**:
1. Check internet connection
2. Verify GitHub account has proper permissions
3. Try using Personal Access Token instead:
   ```bash
   export GITHUB_TOKEN=your_pat_token
   ```
4. Clear cached credentials and retry

#### Elements Not Loading

**Symptoms**: Portfolio appears empty

**Solutions**:
1. Check portfolio directory exists: `~/.dollhouse/portfolio/`
2. Verify file permissions
3. Run `list_portfolio_elements` tool to diagnose
4. Check element file format (YAML frontmatter required)

#### Performance Issues

**Symptoms**: Slow response times

**Solutions**:
1. Check portfolio size (large portfolios may be slow)
2. Verify adequate system resources
3. Consider using pagination for large lists
4. Check network latency for GitHub operations

### Getting Help

- **Documentation**: [Full docs](https://github.com/DollhouseMCP/mcp-server/tree/main/docs)
- **Issues**: [GitHub Issues](https://github.com/DollhouseMCP/mcp-server/issues)
- **Discussions**: [GitHub Discussions](https://github.com/DollhouseMCP/mcp-server/discussions)

For detailed troubleshooting, see [Troubleshooting Guide](docs/troubleshooting/).