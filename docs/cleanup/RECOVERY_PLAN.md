# Portfolio Cleanup Recovery Plan

**Created**: August 20, 2025, 16:13:23  
**Backup Location**: `/Users/mick/.dollhouse/portfolio.backup-20250820-161323`  
**Agent**: Safety Inspector  
**Status**: BACKUP VERIFIED ✓

## Emergency Recovery Information

### Backup Details
- **Backup Directory**: `/Users/mick/.dollhouse/portfolio.backup-20250820-161323`
- **Original Directory**: `/Users/mick/.dollhouse/portfolio`
- **Backup Timestamp**: August 20, 2025, 16:13:23
- **Total Files**: 615 files
- **Total Directories**: 12 directories
- **Backup Size**: 2.7MB

### Backup Verification Results
- ✅ File count matches: 615 files in both original and backup
- ✅ Directory count matches: 12 directories in both original and backup
- ✅ Size verification: 2.7MB for both directories
- ✅ File accessibility tested: Random file read successfully
- ✅ Backup integrity confirmed

## Complete Recovery Procedure

### Option 1: Full Portfolio Restore
```bash
# Stop any running MCP servers first
pkill -f "mcp-server"

# Remove current portfolio (if corrupted)
rm -rf /Users/mick/.dollhouse/portfolio

# Restore from backup
cp -r /Users/mick/.dollhouse/portfolio.backup-20250820-161323 /Users/mick/.dollhouse/portfolio

# Verify restoration
echo "Restored files count:"
find /Users/mick/.dollhouse/portfolio -type f | wc -l

# Should show: 615
```

### Option 2: Selective File Recovery
```bash
# Recover specific files or directories
cp -r "/Users/mick/.dollhouse/portfolio.backup-20250820-161323/[SPECIFIC_PATH]" "/Users/mick/.dollhouse/portfolio/[SPECIFIC_PATH]"

# Example: Recover just personas directory
cp -r "/Users/mick/.dollhouse/portfolio.backup-20250820-161323/personas" "/Users/mick/.dollhouse/portfolio/"
```

### Option 3: Emergency Backup Location
```bash
# If primary backup is inaccessible, additional backups exist at:
ls -la /Users/mick/.dollhouse/personas_backup_*
# Multiple timestamped backups available from August 19-20, 2025
```

## Verification Steps After Recovery

### 1. File Count Verification
```bash
# Check file count matches expected
find /Users/mick/.dollhouse/portfolio -type f | wc -l
# Expected: 615 files

find /Users/mick/.dollhouse/portfolio -type d | wc -l  
# Expected: 12 directories
```

### 2. Directory Structure Verification
```bash
# Verify core directories exist
ls -la /Users/mick/.dollhouse/portfolio/
# Should show: agents, ensembles, memories, personas, skills, templates, etc.
```

### 3. MCP Server Test
```bash
# Navigate to MCP server directory
cd /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server

# Test server startup
npm start
# Should start without errors and connect to restored portfolio
```

### 4. Claude Desktop Test
- Open Claude Desktop
- Verify MCP connection active
- Test basic portfolio operations (list personas, etc.)

## Safety Validation Checklist

Before proceeding with any recovery:
- [ ] No active MCP server processes running
- [ ] No file locks on portfolio directory
- [ ] Sufficient disk space available (>100MB free)
- [ ] Backup integrity verified
- [ ] Recovery command syntax verified

## Emergency Contacts & Resources

### Key Files for Reference
- **Coordination Document**: `/Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server/docs/cleanup/PORTFOLIO_CLEANUP_COORDINATION.md`
- **MCP Server Config**: `/Users/mick/.dollhouse/portfolio/config.json`
- **OAuth Settings**: `/Users/mick/.dollhouse/portfolio/.auth/`

### Common Issues & Solutions

#### Issue: "Permission Denied" During Recovery
```bash
# Fix permissions
sudo chown -R mick:staff /Users/mick/.dollhouse/portfolio
chmod -R u+rwX /Users/mick/.dollhouse/portfolio
```

#### Issue: MCP Server Won't Start After Recovery
1. Check config.json format: `cat /Users/mick/.dollhouse/portfolio/config.json`
2. Verify OAuth directory: `ls -la /Users/mick/.dollhouse/portfolio/.auth/`
3. Restart with verbose logging: `npm start -- --verbose`

#### Issue: File Count Mismatch
```bash
# Compare with backup
echo "Backup files:"
find /Users/mick/.dollhouse/portfolio.backup-20250820-161323 -type f | wc -l
echo "Current files:"
find /Users/mick/.dollhouse/portfolio -type f | wc -l
```

## Backup Maintenance

### Additional Backup Creation
```bash
# Create new timestamped backup
BACKUP_DIR="$HOME/.dollhouse/portfolio.backup-$(date +%Y%m%d-%H%M%S)"
cp -r ~/.dollhouse/portfolio "$BACKUP_DIR"
echo "New backup created: $BACKUP_DIR"
```

### Backup Cleanup (After Successful Operation)
```bash
# Remove old persona backups (optional, after cleanup success)
rm -rf /Users/mick/.dollhouse/personas_backup_*

# Keep the main portfolio backup for safety
# Do NOT remove: /Users/mick/.dollhouse/portfolio.backup-20250820-161323
```

## Recovery Time Estimates

- **Full Portfolio Restore**: 30-60 seconds
- **Selective Recovery**: 10-30 seconds  
- **MCP Server Restart**: 10-20 seconds
- **Claude Desktop Reconnection**: 30-60 seconds
- **Total Recovery Window**: 2-3 minutes

## Post-Recovery Actions

1. Update coordination document with recovery status
2. Test all MCP functionality
3. Verify Claude Desktop operations
4. Document any issues encountered
5. Update backup retention policy

---

**CRITICAL**: This backup was created BEFORE cleanup operations began. It contains ALL original files including test data contamination. Use this only for emergency recovery or selective restoration of legitimate content.

**Backup Retention**: Keep this backup until cleanup operations are verified successful and new backups are created of the cleaned portfolio.