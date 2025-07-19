# Branch Protection Configuration

## Overview
Branch protection was enabled on July 7, 2025, after achieving 100% CI pass rate.

## Current Settings

### Required Status Checks (7 total)
All must pass before merging:
1. Test (ubuntu-latest, Node 20.x)
2. Test (windows-latest, Node 20.x)
3. Test (macos-latest, Node 20.x)
4. Docker Build & Test (linux/amd64)
5. Docker Build & Test (linux/arm64)
6. Docker Compose Test
7. Validate Build Artifacts

### Configuration Details
- **Strict mode**: ✅ Enabled (branches must be up to date)
- **Required reviews**: 1
- **Dismiss stale reviews**: ✅ Yes (on new commits)
- **Code owner reviews**: ❌ Not required
- **Enforce for admins**: ❌ No (admins can bypass if needed)
- **Allow force pushes**: ❌ No
- **Allow deletions**: ❌ No

## Management Commands

### View Protection Status
```bash
gh api /repos/mickdarling/DollhouseMCP/branches/main/protection
```

### Update Protection Settings
```bash
# Create JSON file with settings
cat > branch-protection.json << 'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "Test (ubuntu-latest, Node 20.x)",
      "Test (windows-latest, Node 20.x)", 
      "Test (macos-latest, Node 20.x)",
      "Docker Build & Test (linux/amd64)",
      "Docker Build & Test (linux/arm64)",
      "Docker Compose Test",
      "Validate Build Artifacts"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 1
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF

gh api --method PUT /repos/mickdarling/DollhouseMCP/branches/main/protection --input branch-protection.json
```

### Disable Protection (Emergency Only)
```bash
gh api --method DELETE /repos/mickdarling/DollhouseMCP/branches/main/protection
```

## Important Notes

1. **All PRs must pass checks**: No exceptions for direct pushes
2. **Keep branches updated**: Merge main into feature branches regularly
3. **Admin bypass**: Available but should be used sparingly
4. **Auto-merge disabled**: Repository doesn't allow auto-merge

## Troubleshooting

### PR Blocked from Merging
1. Check all status checks are passing: `gh pr checks <PR-NUMBER>`
2. Ensure branch is up to date: `git pull origin main && git push`
3. Verify you have approval: `gh pr view <PR-NUMBER>`

### Emergency Merge
If absolutely necessary, use admin privileges:
```bash
gh pr merge <PR-NUMBER> --merge --admin
```

## Benefits
- Prevents broken code from reaching main
- Ensures consistent code quality
- Maintains CI reliability
- Provides audit trail via PRs