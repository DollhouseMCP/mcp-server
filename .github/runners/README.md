# Self-Hosted GitHub Actions Runners

This directory contains configuration for running GitHub Actions on self-hosted runners, providing faster CI feedback during development.

## Quick Start

```bash
cd .github/runners
./setup-runner.sh
```

This will:
1. Check prerequisites (Docker, GitHub CLI)
2. Generate a runner registration token
3. Start the runner container
4. Register with GitHub

## How It Works

### Runner Selection Logic

The CI automatically chooses between self-hosted and GitHub-hosted runners:

| Trigger | Actor | Override | Runner |
|---------|-------|----------|--------|
| Any | `mickdarling` | None | **Self-hosted** (macOS only) |
| Any | `mickdarling` | `[full-matrix]` in commit/PR | GitHub-hosted (full matrix) |
| Any | `mickdarling` | `full-matrix` label | GitHub-hosted (full matrix) |
| Push to main | Any | - | GitHub-hosted (full matrix) |
| Any | Other contributors | - | GitHub-hosted (full matrix) |

### Partial CI Tracking

When a PR runs with single-platform CI:
- The `partial-ci` label is automatically added
- A comment is posted explaining how to trigger full matrix testing

## Commands

```bash
# Start macOS runner
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

## Triggering Full Matrix

Even as `mickdarling`, you can force full cross-platform testing:

1. **Commit message**: Include `[full-matrix]` anywhere in the message
   ```
   fix: resolve timing issue [full-matrix]
   ```

2. **PR title**: Include `[full-matrix]` in the title
   ```
   fix: resolve timing issue [full-matrix]
   ```

3. **PR label**: Add the `full-matrix` label to the PR

4. **Manual dispatch**: Use workflow_dispatch with `full_matrix: true`

5. **Merge to main**: Always runs full matrix automatically

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    GitHub Actions                            │
├─────────────────────────────────────────────────────────────┤
│  Workflow triggers                                           │
│       │                                                      │
│       ▼                                                      │
│  ┌─────────────────┐                                        │
│  │ runner-strategy │ Determines which runner to use         │
│  └────────┬────────┘                                        │
│           │                                                  │
│     ┌─────┴─────┐                                           │
│     ▼           ▼                                           │
│ ┌────────┐  ┌────────┐                                      │
│ │ self-  │  │ hosted │                                      │
│ │ hosted │  │ -test  │                                      │
│ │ -test  │  │        │                                      │
│ └───┬────┘  └────────┘                                      │
│     │           │                                            │
│     ▼           │                                            │
│ ┌────────┐      │                                            │
│ │ label- │◄─────┘ (only for self-hosted)                    │
│ │partial │                                                   │
│ │ -ci    │                                                   │
│ └────────┘                                                   │
└─────────────────────────────────────────────────────────────┘
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

This runs a Linux container alongside the macOS runner, allowing you to test both platforms locally.

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
- This setup is for a private repo with trusted contributors only

## Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | Runner container configuration |
| `.env.example` | Template for runner configuration |
| `.env` | Your runner config (gitignored) |
| `setup-runner.sh` | Setup and management script |
| `README.md` | This documentation |
