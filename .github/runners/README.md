# Self-Hosted GitHub Actions Runners (Optional)

This directory contains configuration for running GitHub Actions on your own self-hosted runners. This is **entirely optional** — the public repo uses GitHub-hosted runners by default. Self-hosted runners provide faster CI feedback for frequent contributors.

## Quick Start

```bash
cd .github/runners
cp .env.example .env
# Edit .env with your GitHub token and runner name
./setup-runner.sh
```

This will:
1. Check prerequisites (Docker, GitHub CLI)
2. Generate a runner registration token
3. Start the runner container
4. Register with your fork/repo

## When to Use Self-Hosted Runners

- **You don't need this** for normal contributions — GitHub-hosted CI runs automatically on PRs
- Self-hosted runners are useful if you're making frequent commits and want sub-minute CI feedback
- They're also useful for testing Docker builds locally without waiting for GitHub's queue

## Commands

```bash
# Start runner
./setup-runner.sh

# Start both macOS and Linux runners
./setup-runner.sh --linux

# Stop all runners
./setup-runner.sh --stop

# Check status
./setup-runner.sh --status

# Generate new token only
./setup-runner.sh --token
```

## Docker Configuration

The runner uses the `myoung34/github-runner` Docker image which:
- Auto-registers with GitHub on startup
- Supports Docker-in-Docker for container-based tests
- Persists work directories and caches between runs

### Volumes

| Volume | Purpose |
|--------|---------|
| `runner-work` | Persistent workspace |
| `runner-npm-cache` | NPM cache for faster installs |
| `runner-node-modules` | Node.js tool cache |

### Linux Runner (Optional)

For local cross-platform testing, start the Linux runner:

```bash
./setup-runner.sh --linux
```

## Troubleshooting

### Runner not picking up jobs

1. Check runner status: `./setup-runner.sh --status`
2. View logs: `docker-compose logs -f`
3. Verify labels match workflow requirements

### Token expired

Tokens expire after 1 hour. Regenerate with:
```bash
./setup-runner.sh --token
```

Then update `.env` and restart the runner.

### Docker socket permission denied

On macOS, ensure Docker Desktop is running and your user has access to the Docker socket.

## Security Notes

- Self-hosted runners have access to your local machine
- The runner container has access to the Docker socket (for DinD)
- Never run untrusted code on self-hosted runners
- Only use on repos where you trust all contributors

## Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Runner container configuration |
| `.env.example` | Template for runner configuration |
| `.env` | Your runner config (gitignored) |
| `setup-runner.sh` | Setup and management script |
| `README.md` | This documentation |
