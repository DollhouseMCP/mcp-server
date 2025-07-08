# Auto-Update Troubleshooting Guide

## Common Issues and Solutions

### 1. Update Check Fails

#### Symptom
```
Error: Failed to check for updates
Network error or API timeout
```

#### Possible Causes
- Network connectivity issues
- GitHub API rate limiting
- Firewall blocking connections
- DNS resolution problems

#### Solutions

1. **Check network connectivity**
   ```bash
   ping api.github.com
   curl -I https://api.github.com
   ```

2. **Check rate limit status**
   ```
   get_server_status
   # Look for "Rate Limit: X/10 requests remaining"
   ```

3. **Wait for rate limit reset**
   ```bash
   # Rate limits reset every 60 seconds
   sleep 60
   check_for_updates
   ```

4. **Use a proxy if behind firewall**
   ```bash
   export DOLLHOUSE_UPDATE_PROXY=http://proxy:8080
   ```

### 2. Update Download Fails

#### Symptom
```
Error: Failed to download update
Clone failed with exit code 128
```

#### Possible Causes
- Insufficient disk space
- Git not installed or outdated
- Authentication issues
- Corrupted git cache

#### Solutions

1. **Check disk space**
   ```bash
   df -h .
   # Need at least 500MB free
   ```

2. **Verify Git installation**
   ```bash
   git --version
   # Should be 2.20.0 or higher
   ```

3. **Clear Git cache**
   ```bash
   rm -rf ~/.git-credential-cache
   git config --global --unset credential.helper
   ```

4. **Manual update**
   ```bash
   git pull origin main
   npm install
   npm run build
   ```

### 3. Build Failures

#### Symptom
```
Error: Build failed
TypeScript compilation errors
```

#### Possible Causes
- Incompatible Node.js version
- Missing dependencies
- TypeScript version mismatch
- Corrupted node_modules

#### Solutions

1. **Check Node.js version**
   ```bash
   node --version
   # Should be 18.0.0 or higher
   ```

2. **Clean install dependencies**
   ```bash
   rm -rf node_modules package-lock.json
   npm install
   ```

3. **Clear npm cache**
   ```bash
   npm cache clean --force
   ```

4. **Check for TypeScript errors**
   ```bash
   npx tsc --noEmit
   ```

### 4. Backup Creation Fails

#### Symptom
```
Error: Failed to create backup
Permission denied or disk full
```

#### Possible Causes
- Insufficient permissions
- Disk space issues
- Backup directory not writable
- Too many existing backups

#### Solutions

1. **Check permissions**
   ```bash
   ls -la .backup*
   # Should be writable by current user
   ```

2. **Clean old backups**
   ```bash
   rm -rf .backup-2024*  # Remove old year backups
   ```

3. **Change backup location**
   ```bash
   export DOLLHOUSE_BACKUP_DIR=/tmp/dollhouse-backups
   ```

4. **Skip backup (not recommended)**
   ```bash
   export DOLLHOUSE_SKIP_BACKUP=true
   ```

### 5. Rollback Issues

#### Symptom
```
Error: Rollback failed
Cannot restore from backup
```

#### Possible Causes
- Backup corrupted
- Insufficient permissions
- Current installation corrupted
- Missing backup files

#### Solutions

1. **List available backups**
   ```bash
   ls -la .backup-*
   ```

2. **Manual rollback**
   ```bash
   # Create safety backup first
   cp -r . .backup-manual-$(date +%s)
   
   # Restore from specific backup
   rm -rf src dist node_modules
   cp -r .backup-2025-01-08-1600/* .
   npm install
   npm run build
   ```

3. **Check backup integrity**
   ```bash
   # Verify backup has key files
   ls .backup-*/package.json
   ls .backup-*/src/index.ts
   ```

### 6. Permission Errors

#### Symptom
```
Error: EACCES: permission denied
Cannot write to directory
```

#### Solutions

1. **Fix ownership**
   ```bash
   sudo chown -R $(whoami) .
   ```

2. **Fix permissions**
   ```bash
   chmod -R u+w .
   ```

3. **Run with correct user**
   ```bash
   su - dollhouse-user
   ```

### 7. Rate Limiting

#### Symptom
```
Error: Rate limit exceeded
Try again in X seconds
```

#### Solutions

1. **Check current limit**
   ```
   get_server_status
   ```

2. **Wait for reset**
   ```bash
   # Default reset is 60 seconds
   sleep 60
   ```

3. **Increase rate limit**
   ```bash
   export DOLLHOUSE_RATE_LIMIT_MAX=20
   ```

### 8. Signature Verification Fails

#### Symptom
```
Error: GPG signature verification failed
Update may not be authentic
```

#### Solutions

1. **Import trusted keys**
   ```bash
   gpg --keyserver keyserver.ubuntu.com --recv-keys ABC123
   ```

2. **Skip verification (not recommended)**
   ```bash
   export DOLLHOUSE_SKIP_SIGNATURE=true
   ```

3. **Check key trust**
   ```bash
   gpg --list-keys --with-fingerprint
   ```

## Diagnostic Commands

### System Information
```bash
# Full diagnostics
get_server_status

# Node.js info
node --version
npm --version

# Git info
git --version
git config --list

# Disk space
df -h .

# Memory
free -h  # Linux
vm_stat  # macOS
```

### Update System Status
```bash
# Check configuration
env | grep DOLLHOUSE_

# View recent logs
tail -f update.log

# List backups
ls -la .backup-*

# Check file permissions
ls -la src/update/
```

### Network Diagnostics
```bash
# Test GitHub connectivity
curl -I https://api.github.com

# Check DNS
nslookup api.github.com

# Test with wget
wget --spider https://github.com

# Trace route
traceroute api.github.com
```

## Log Files

### Update Logs
Default location: `./update.log`

```bash
# View recent updates
tail -100 update.log

# Search for errors
grep -i error update.log

# Check specific date
grep "2025-01-08" update.log
```

### Enable Debug Logging
```bash
export DOLLHOUSE_LOG_LEVEL=debug
export NODE_ENV=development
```

## Recovery Procedures

### Complete System Recovery

If the system is completely broken:

1. **Clone fresh copy**
   ```bash
   git clone https://github.com/DollhouseMCP/mcp-server.git dollhouse-fresh
   cd dollhouse-fresh
   ```

2. **Copy user data**
   ```bash
   cp -r ../DollhouseMCP/personas .
   cp ../DollhouseMCP/.env .
   ```

3. **Install and build**
   ```bash
   npm install
   npm run build
   ```

4. **Test functionality**
   ```bash
   npm start
   ```

### Emergency Downgrade

To downgrade to a specific version:

```bash
# Checkout specific version
git checkout v1.1.0

# Clean install
rm -rf node_modules package-lock.json
npm install
npm run build
```

## Getting Help

### Before Requesting Help

1. **Check this guide** for your specific issue
2. **Review recent changes** in update.log
3. **Try manual update** as a workaround
4. **Collect diagnostic information**

### Information to Provide

When reporting issues, include:

```
1. Error message (complete)
2. DollhouseMCP version
3. Node.js version
4. Operating system
5. Recent actions taken
6. Relevant log excerpts
7. Environment variables (sanitized)
```

### Support Channels

1. **GitHub Issues**: https://github.com/DollhouseMCP/mcp-server/issues
2. **Email Support**: mick@mickdarling.com
3. **Community Discord**: [Coming Soon]

## Prevention Tips

1. **Regular Backups**: Keep external backups of important data
2. **Test Updates**: Always test in development first
3. **Monitor Logs**: Check logs after updates
4. **Stay Informed**: Follow release notes
5. **Plan Maintenance**: Schedule updates during low usage