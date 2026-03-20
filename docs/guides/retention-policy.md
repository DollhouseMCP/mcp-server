# Retention Policy System

## Overview

The Retention Policy System in DollhouseMCP provides automatic cleanup of expired memory entries while prioritizing data safety through explicit user consent. This feature is designed for compliance use cases (legal retention, GDPR, storage management) where automatic expiration is required.

**Version**: 2.0.0+
**Status**: Production Ready (Opt-In)
**Issue**: #51

---

## Key Principles

### 1. Safety First: Disabled by Default

**IMPORTANT**: Retention enforcement is **DISABLED** by default. Nothing is automatically deleted without explicit user consent.

This design choice ensures:
- No accidental data loss
- Explicit opt-in for automatic cleanup
- Full visibility before any deletion
- Safe defaults for all use cases

### 2. Opt-In Enforcement

Users must explicitly enable retention enforcement in their configuration. The system requires conscious activation:

```yaml
retentionPolicy:
  enabled: true                    # Must be explicitly set
  enforcement_mode: manual          # Choose enforcement strategy
```

### 3. Multiple Safety Controls

Even when enabled, the system provides multiple layers of protection:
- **Dry run preview** - See what would be deleted before committing
- **Confirmation required** - Manual approval before deletion
- **Warning system** - Advance notice before items expire
- **Audit logging** - Complete history of all deletions
- **Backup system** - Deleted items preserved before removal

---

## Configuration

All retention policy settings are managed in `~/.dollhouse/config.yml` under the `retentionPolicy` section.

### Master Control

```yaml
retentionPolicy:
  # Master switch - must be true for any automatic enforcement
  enabled: false                    # Default: false (nothing auto-deleted)

  # When enforcement happens (see Enforcement Modes below)
  enforcement_mode: disabled        # Default: disabled
```

### Enforcement Modes

The `enforcement_mode` setting controls when retention policies are checked and enforced:

| Mode | Timing | Use Case | Safety Level |
|------|--------|----------|--------------|
| `disabled` | Never automatic | Default - manual cleanup only | Safest |
| `manual` | Explicit command only | User-triggered maintenance | Very Safe |
| `on_load` | When memory is loaded | Real-time enforcement | Moderate |
| `scheduled` | On schedule (future) | Background cleanup | Planned |

#### Disabled Mode (Default)

```yaml
enforcement_mode: disabled
```

- No automatic cleanup ever happens
- Retention policies are ignored
- Only explicit deletion commands work
- **Recommended for most users**

#### Manual Mode

```yaml
enforcement_mode: manual
```

- User must explicitly run enforcement command
- Full control over when cleanup happens
- Preview available before executing
- **Recommended for controlled cleanup**

#### On-Load Mode

```yaml
enforcement_mode: on_load
```

- Checks retention when memories are loaded
- Removes expired entries automatically
- **NOT recommended** - can cause unexpected deletions
- Use only when immediate cleanup is required

#### Scheduled Mode (Future)

```yaml
enforcement_mode: scheduled
```

- Run retention enforcement on a schedule
- Configurable intervals (daily, weekly, etc.)
- **Not yet implemented** - planned for future release

### Safety Controls

```yaml
retentionPolicy:
  safety:
    # Require explicit confirmation before any deletion
    require_confirmation: true      # Default: true

    # Always run dry-run preview before actual deletion
    dry_run_first: true             # Default: true

    # Show warning when entries approaching expiration
    warn_on_expiring: true          # Default: true

    # Days before expiration to start warning
    warning_threshold_days: 7       # Default: 7 days
```

#### Safety Control Details

**require_confirmation**
- When `true`: User must explicitly approve each deletion operation
- When `false`: Deletions happen automatically (risky)
- **Recommended**: Always keep `true`

**dry_run_first**
- When `true`: First run shows preview, second run with `force=true` actually deletes
- When `false`: Deletions happen immediately
- **Recommended**: Always keep `true` to prevent accidents

**warn_on_expiring**
- When `true`: System logs warnings for items approaching expiration
- Helps prevent surprise deletions
- Warnings appear in logs when items are within `warning_threshold_days`

### Audit Settings

```yaml
retentionPolicy:
  audit:
    # Log all retention deletions for audit trail
    log_deletions: true             # Default: true

    # Keep deleted entries in backup before permanent removal
    backup_before_delete: true      # Default: true

    # Days to keep backups of deleted entries
    backup_retention_days: 30       # Default: 30 days
```

#### Audit Control Details

**log_deletions**
- Records all deletion operations with timestamps
- Creates audit trail for compliance
- Includes: what was deleted, when, why (expired/capacity)

**backup_before_delete**
- Saves deleted entries to backup location
- Allows recovery if deletion was mistake
- Backups automatically cleaned after `backup_retention_days`

**backup_retention_days**
- How long to keep deleted entry backups
- After this period, backups are permanently removed
- Set higher for compliance scenarios (e.g., 365 for one year)

### Default Settings

```yaml
retentionPolicy:
  defaults:
    # Default TTL in days for new memory entries
    ttl_days: 30                    # Default: 30 days

    # Maximum entries before capacity enforcement
    max_entries: 1000               # Default: 1000 entries
```

These defaults apply when creating new memories unless overridden per-memory.

---

## Use Cases

### Legal/Compliance Retention

Law firms, accounting firms, and businesses with legal retention requirements:

```yaml
retentionPolicy:
  enabled: true
  enforcement_mode: manual          # Controlled cleanup
  safety:
    require_confirmation: true
    dry_run_first: true
    warn_on_expiring: true
    warning_threshold_days: 30      # One month warning
  audit:
    log_deletions: true             # Required for compliance
    backup_before_delete: true
    backup_retention_days: 365      # Keep backups one year
  defaults:
    ttl_days: 2555                  # 7 years (legal standard)
    max_entries: 10000
```

**Workflow**:
1. Create memories with 7-year retention
2. System warns 30 days before expiration
3. Manual review before deletion
4. Audit log for compliance proof
5. One-year backup retention

### Privacy-Focused (Signal-Style)

Auto-expiring messages for privacy-conscious users:

```yaml
retentionPolicy:
  enabled: true
  enforcement_mode: on_load         # Automatic cleanup
  safety:
    require_confirmation: false     # Auto-delete expired
    dry_run_first: false
    warn_on_expiring: false
    warning_threshold_days: 1
  audit:
    log_deletions: true
    backup_before_delete: false     # No backups (privacy)
    backup_retention_days: 0
  defaults:
    ttl_days: 7                     # One week maximum
    max_entries: 100
```

**Workflow**:
1. Memories auto-expire after 7 days
2. Deleted immediately on next load
3. No backups kept (privacy)
4. Minimal audit logging

### Storage Management

Managing disk space with automatic cleanup:

```yaml
retentionPolicy:
  enabled: true
  enforcement_mode: scheduled       # (Future) Run cleanup nightly
  safety:
    require_confirmation: false
    dry_run_first: false
    warn_on_expiring: true
    warning_threshold_days: 7
  audit:
    log_deletions: true
    backup_before_delete: true
    backup_retention_days: 7        # Short backup window
  defaults:
    ttl_days: 90                    # 3 months
    max_entries: 5000
```

### GDPR Right to be Forgotten

Implementing GDPR data deletion requirements:

```yaml
retentionPolicy:
  enabled: true
  enforcement_mode: manual          # Manual deletion for compliance
  safety:
    require_confirmation: true      # Document each deletion
    dry_run_first: true
    warn_on_expiring: true
    warning_threshold_days: 14
  audit:
    log_deletions: true             # Required for GDPR proof
    backup_before_delete: true
    backup_retention_days: 90       # 90-day grace period
  defaults:
    ttl_days: 365                   # One year default
    max_entries: 10000
```

---

## How Retention Works

### Per-Memory Entry TTL

Each memory entry can have an individual expiration date:

```typescript
// When adding memory entry, system calculates expiry
const entry = await memory.addEntry(
  "Project completed successfully",
  ["project", "milestone"],
  { projectId: "ABC123" }
);

// Entry automatically gets expiresAt based on config
entry.expiresAt; // 30 days from now (using defaults.ttl_days)
```

### Element-Type Strategy Pattern

The retention system uses a **strategy pattern** to support different element types:

```typescript
// Each element type can have its own retention strategy
interface IRetentionStrategy {
  elementType: string;              // e.g., "memories", "skills", "templates"
  getRetainableItems(element);      // Get items subject to retention
  checkItem(item, config);          // Check if item should be retained
  removeItem(element, itemId);      // Remove expired item
  calculateExpiryDate(config);      // Calculate when item expires
  isPinned(item);                   // Check if item is pinned (never delete)
}
```

**Designed for 50+ element types**: Currently implemented for memories, but the architecture supports retention policies for all element types (skills, templates, agents, etc.).

### Retention Enforcement Flow

1. **Check enabled**: If `enabled: false`, stop immediately
2. **Check mode**: Only enforce if mode allows it
3. **Get items**: Retrieve all retainable items from element
4. **Check each item**:
   - Is it expired? (expiresAt < now)
   - Is it pinned? (never delete)
   - Is capacity exceeded? (too many items)
5. **Preview/Execute**:
   - If `dry_run_first: true` → show preview first
   - If `require_confirmation: true` → ask user
   - Else → execute deletion
6. **Audit**: Log deletions, create backups

---

## Configuration Examples

### Safest: Disabled (Default)

```yaml
retentionPolicy:
  enabled: false                    # Nothing auto-deleted
  enforcement_mode: disabled
  # All other settings ignored when enabled=false
```

### Safe: Manual Cleanup Only

```yaml
retentionPolicy:
  enabled: true
  enforcement_mode: manual          # Only via explicit command
  safety:
    require_confirmation: true      # User must approve
    dry_run_first: true             # Preview before delete
    warn_on_expiring: true
    warning_threshold_days: 7
  audit:
    log_deletions: true
    backup_before_delete: true
    backup_retention_days: 30
  defaults:
    ttl_days: 30
    max_entries: 1000
```

### Production: Background Cleanup

```yaml
retentionPolicy:
  enabled: true
  enforcement_mode: scheduled       # (Future) Automatic
  safety:
    require_confirmation: false     # Auto-approve
    dry_run_first: false            # Direct execution
    warn_on_expiring: true          # Still warn in logs
    warning_threshold_days: 7
  audit:
    log_deletions: true             # Full audit trail
    backup_before_delete: true
    backup_retention_days: 30
  defaults:
    ttl_days: 90
    max_entries: 5000
```

---

## Status and Warnings

### Checking Retention Status

The system provides status messages about current retention configuration:

```typescript
// Check if retention is enabled
service.isEnabled(); // false by default

// Get status message
service.getStatusMessage();
// "Retention enforcement is DISABLED globally. No items will be automatically deleted."

// Or when enabled:
// "Retention enforcement is ENABLED (mode: manual).
//  Global defaults:
//    - Default TTL: 30 days
//    - Max items: 1000
//    - Warning threshold: 7 days before expiry
//  ..."
```

### Warning System

When `warn_on_expiring: true`, the system logs warnings:

```typescript
// Example log output
[2025-01-26 10:15:00] WARN: Memory entry approaching expiration
  - Entry ID: mem_abc123
  - Expires at: 2025-02-02
  - Days until expiry: 6
  - Memory: project-notes
```

---

## Migration Guide

### From No Retention to Manual Retention

1. **Backup first**: Export all memories before enabling
2. **Enable with manual mode**:
   ```yaml
   retentionPolicy:
     enabled: true
     enforcement_mode: manual
   ```
3. **Test with dry run**: Run enforcement preview to see what would be deleted
4. **Review results**: Check if deletions are expected
5. **Execute carefully**: Run with confirmation required

### From Manual to Automatic

1. **Monitor manual runs**: Get comfortable with retention behavior
2. **Increase warning threshold**: Give yourself more notice
   ```yaml
   warning_threshold_days: 30  # One month warning
   ```
3. **Enable scheduled mode** (when available):
   ```yaml
   enforcement_mode: scheduled
   ```
4. **Keep safety controls**: Don't disable confirmation immediately

---

## Future Enhancements

### Planned Features

1. **Scheduled Enforcement** (enforcement_mode: scheduled)
   - Configurable intervals: hourly, daily, weekly
   - Background job execution
   - Metrics and reporting

2. **Per-Element-Type Configuration**
   - Override global defaults per element type
   - Example: memories (30 days), skills (permanent)

3. **Pinning Support**
   - Mark items as "pinned" to prevent deletion
   - Useful for important reference content

4. **Retention Policies for All Elements**
   - Skills, templates, agents, ensembles
   - Each with appropriate strategy

5. **Advanced Capacity Management**
   - LRU eviction (least recently used)
   - Priority-based retention
   - Smart cleanup algorithms

---

## Troubleshooting

### "Retention is disabled" warning

**Cause**: `enabled: false` in config (default)

**Solution**: Set `enabled: true` if you want automatic cleanup

### Items not being deleted

**Possible causes**:
1. `enforcement_mode: disabled` - Change to `manual` or higher
2. `dry_run_first: true` - Second run required with `force=true`
3. `require_confirmation: true` - User approval needed
4. Items not actually expired yet - Check `expiresAt` dates

### Unexpected deletions

**Immediate actions**:
1. Set `enforcement_mode: disabled` to stop deletions
2. Check backups (if `backup_before_delete: true`)
3. Review audit logs to see what was deleted

**Prevention**:
1. Always use `dry_run_first: true`
2. Keep `require_confirmation: true`
3. Use higher `warning_threshold_days`
4. Test on non-production data first

---

## Security Considerations

### Audit Trail

The retention system logs all deletion operations with:
- What was deleted (entry ID, content preview)
- When it was deleted (timestamp)
- Why it was deleted (expired, capacity, manual)
- Who triggered it (enforcement mode)

### Backup System

Deleted items are backed up (when enabled):
- Location: `~/.dollhouse/backups/retention/`
- Format: Same as original (YAML)
- Retention: Configurable (`backup_retention_days`)
- Recovery: Manual restoration possible

### Privacy Mode

For maximum privacy (no backups):

```yaml
audit:
  backup_before_delete: false
  backup_retention_days: 0
```

---

## Best Practices

### Development

- Keep retention **disabled** during development
- Use test memories with short TTL for testing
- Verify backups work before enabling in production

### Staging

- Enable **manual mode** in staging
- Test dry runs thoroughly
- Document expected retention behavior
- Run through complete deletion cycle

### Production

- Start with **manual mode**, not automatic
- Monitor logs for unexpected warnings
- Review audit trail regularly
- Keep backups enabled initially
- Document retention policy for compliance

### Compliance

- Document retention requirements
- Configure appropriate TTL for each memory type
- Enable full audit logging
- Preserve backups for required period
- Test recovery procedures
- Include retention in disaster recovery plan

---

## Summary

The Retention Policy System provides automatic cleanup of expired memory entries with a **safety-first** approach:

1. **Disabled by default** - No surprises, no accidental deletions
2. **Opt-in enforcement** - Users choose when and how
3. **Multiple safety controls** - Preview, confirmation, warnings, backups
4. **Full audit trail** - Complete visibility into deletions
5. **Flexible configuration** - Adapt to different use cases
6. **Future-proof design** - Supports 50+ element types

**Remember**: Nothing is deleted automatically unless you explicitly enable retention enforcement.

---

*Last updated: January 26, 2025*
*Documentation version: 1.0.0*
