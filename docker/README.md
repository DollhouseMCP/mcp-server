# Docker Setup for DollhouseMCP

This directory contains Docker configuration files for running and testing the DollhouseMCP server in containerized environments.

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [Environment Configuration](#environment-configuration)
- [Available Docker Files](#available-docker-files)
- [Common Commands](#common-commands)
- [Documentation](#documentation)

## 🚀 Quick Start

### First-Time Setup

1. **Copy the environment template:**
   ```bash
   cp docker/test-environment.env.example docker/test-environment.env
   ```

2. **Edit your environment file:**
   ```bash
   # Open docker/test-environment.env and update these values:
   TEST_GITHUB_USER=your-github-username
   TEST_GITHUB_REPO=your-test-repo-name
   ```

3. **Build and run:**
   ```bash
   docker-compose up --build
   ```

### Existing Users

If you've already set up your `test-environment.env` file:

```bash
docker-compose up
```

## ⚙️ Environment Configuration

### Configuration Files

- **`test-environment.env.example`** - Template with example values (committed to git)
- **`test-environment.env`** - Your personal configuration (excluded from git)

### Important Environment Variables

The most important variables to customize in `test-environment.env`:

```bash
# Replace with your GitHub username
TEST_GITHUB_USER=your-github-username

# Replace with your test repository name
TEST_GITHUB_REPO=dollhouse-test-portfolio

# Optional: Make repository private (default: false)
TEST_GITHUB_PRIVATE=false
```

**Note:** The `test-environment.env` file is listed in `.gitignore` to prevent accidental commits of user-specific configuration. Always use the `.example` file as your starting point.

### Full Configuration Options

For a complete list of available environment variables and their purposes, see the comments in `test-environment.env.example`.

Key configuration sections:
- **Test Mode Settings** - Isolation and safety features
- **GitHub Integration** - Repository and authentication
- **Collection Settings** - Caching and API behavior
- **Logging** - Debug output and file logging
- **Safety Features** - Dry-run and confirmation requirements
- **Performance** - Timeouts and resource limits

## 📁 Available Docker Files

### Main Dockerfiles

- **`Dockerfile`** - Production-ready image
- **`Dockerfile.prebuilt`** - Uses prebuilt npm package
- **`Dockerfile.minimal`** - Minimal image for basic testing
- **`Dockerfile.test-enhanced`** - Enhanced testing environment

### Docker Compose Files

- **`docker-compose.yml`** - Main compose configuration
- **`docker-compose.prebuilt.yml`** - Uses prebuilt package
- **`docker-compose.minimal.yml`** - Minimal setup

### Test Configurations

The `test-configs/` directory contains specialized configurations:
- `Dockerfile.claude-testing` - Claude Code integration testing
- `.dockerignore.claude-testing` - Build optimization

## 🔧 Common Commands

### Building Images

```bash
# Build main image
docker build -t dollhousemcp .

# Build with specific Dockerfile
docker build -f docker/Dockerfile.prebuilt -t dollhousemcp-prebuilt .

# Build with docker-compose
docker-compose build
```

### Running Containers

```bash
# Run with docker-compose (recommended)
docker-compose up

# Run in detached mode
docker-compose up -d

# Run with specific env file
docker run --env-file docker/test-environment.env dollhousemcp

# Interactive shell
docker run -it dollhousemcp /bin/bash
```

### Testing

```bash
# Run test suite
docker-compose run --rm test

# Run enhanced index tests
./docker/test-enhanced-index.sh

# Test MCP tools
./docker/test-mcp-tools.cjs
```

### Cleanup

```bash
# Stop and remove containers
docker-compose down

# Remove volumes
docker-compose down -v

# Remove images
docker rmi dollhousemcp
```

## 📚 Documentation

### Guides in This Directory

- **[AUTHORIZATION_GUIDE.md](./AUTHORIZATION_GUIDE.md)** - GitHub OAuth and authentication setup
- **[CLAUDE_CODE_INTEGRATION.md](./CLAUDE_CODE_INTEGRATION.md)** - Integrating with Claude Code
- **[QUICK_REFERENCE.md](./QUICK_REFERENCE.md)** - Quick command reference for Docker + Claude Code

### Related Documentation

- **Main README**: `../README.md` - Project overview and installation
- **Contributing**: `../CONTRIBUTING.md` - Development workflow
- **Testing**: `../docs/testing/` - Testing guides and procedures

## 🔒 Security Notes

1. **Never commit `test-environment.env`** - It contains user-specific configuration
2. **Use environment variables for secrets** - Don't hardcode tokens or keys
3. **Review the `.example` file** - Understand what each variable does before setting it
4. **Keep your GitHub token secure** - Set `GITHUB_TOKEN` via environment, not in files

## 🐛 Troubleshooting

### MCP Tools Not Found

Ensure you're using the correct MCP config path:
```bash
--mcp-config /root/.config/claude-code/config.json
```

### Environment Variables Not Loading

1. Verify `test-environment.env` exists
2. Check file syntax (no spaces around `=`)
3. Use `docker-compose config` to validate

### Build Failures

1. Check Docker version: `docker --version` (requires 20.10+)
2. Clear build cache: `docker builder prune`
3. Review build logs for specific errors

### Permission Issues

Ensure files are readable:
```bash
chmod 644 docker/test-environment.env
```

## 💡 Best Practices

1. **Use docker-compose** - Simpler than raw docker commands
2. **Keep env file updated** - When `.example` changes, review your local copy
3. **Test in containers** - Match production environment
4. **Document custom changes** - Add comments to your `test-environment.env`
5. **Use specific tags** - Pin versions for reproducibility

## 🤝 Contributing

When adding new Docker configurations:

1. Update the relevant `.example` files
2. Document new environment variables
3. Add examples to this README
4. Test all supported platforms (linux/amd64, linux/arm64)
5. Update version numbers and dates

---

**Last Updated:** October 2025
**Maintainer:** DollhouseMCP Team
**Questions?** Open an issue at https://github.com/DollhouseMCP/mcp-server/issues
