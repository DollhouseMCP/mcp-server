# OAuth Client ID Migration Guide

## Overview

As of August 8, 2025, DollhouseMCP has migrated to a new OAuth client ID system. Each deployment should now use its own GitHub OAuth app for better security and isolation.

## Why the Change?

The original OAuth client ID was exposed in the Git history. While client IDs are public by design and this poses no immediate security risk, we've taken this opportunity to improve the OAuth architecture:

1. **Better Security**: Each deployment uses its own OAuth app
2. **Improved Isolation**: No shared credentials between deployments
3. **Enhanced Control**: Administrators have full control over their OAuth apps
4. **Clear Ownership**: Each OAuth app is clearly owned by the deployer

## Migration Steps

### For End Users

If you're using a DollhouseMCP server hosted by someone else, **no action is required**. The server administrator will handle the migration.

### For Self-Hosting Users

You need to create your own GitHub OAuth app and configure the client ID:

#### Step 1: Create Your OAuth App

1. Go to GitHub Settings:
   - Click your profile picture → Settings
   - Navigate to "Developer settings" (bottom of sidebar)
   - Click "OAuth Apps" → "New OAuth App"

2. Configure the app:
   - **Application name**: `DollhouseMCP - [Your Name/Org]`
   - **Homepage URL**: `https://github.com/DollhouseMCP/mcp-server`
   - **Authorization callback URL**: `http://localhost:12345/callback`
   - Click "Register application"

3. Enable Device Flow:
   - In your OAuth app settings, check ✅ **Enable Device Flow**
   - Copy your Client ID (format: `Ov23liXXXXXXXXXXXXXX`)

#### Step 2: Update Your Configuration

Choose one of these methods:

**Option A: Environment Variable (Recommended)**
```bash
# Add to your shell profile (.bashrc, .zshrc, etc)
export DOLLHOUSE_GITHUB_CLIENT_ID="your_new_client_id_here"
source ~/.zshrc  # or ~/.bashrc
```

**Option B: Claude Desktop Configuration**
```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["/path/to/dollhousemcp/dist/index.js"],
      "env": {
        "DOLLHOUSE_GITHUB_CLIENT_ID": "your_new_client_id_here"
      }
    }
  }
}
```

#### Step 3: Clear Old Authentication

If you had previously authenticated with the old client ID:

```bash
# In Claude Desktop or via MCP tools
clear_github_auth

# Then re-authenticate
setup_github_auth
```

## Verification

After migration, verify your setup:

1. Check the client ID is configured:
   ```bash
   echo $DOLLHOUSE_GITHUB_CLIENT_ID
   ```

2. Test authentication:
   ```bash
   # In Claude Desktop
   setup_github_auth
   ```

3. You should see your OAuth app name when authorizing on GitHub

## Troubleshooting

### "GitHub OAuth client ID is not configured"

This means the environment variable isn't set. Check:
- Variable name is exactly `DOLLHOUSE_GITHUB_CLIENT_ID`
- You've sourced your shell profile or restarted your terminal
- For Claude Desktop, you've restarted the application

### "Invalid client_id"

This means GitHub doesn't recognize your client ID:
- Verify you copied the complete client ID
- Check your OAuth app still exists in GitHub settings
- Ensure Device Flow is enabled for your app

### Old Token Still Being Used

If the system seems to be using an old token:

1. Clear the stored token:
   ```bash
   clear_github_auth
   ```

2. Check for any pending tokens:
   ```bash
   ls ~/.dollhouse/.auth/
   # Remove any pending_token.txt if present
   rm ~/.dollhouse/.auth/pending_token.txt
   ```

3. Re-authenticate with the new client ID:
   ```bash
   setup_github_auth
   ```

## Security Notes

- **Client IDs are public**: They're meant to be visible and don't provide access
- **Never share tokens**: The actual OAuth tokens are secret and encrypted
- **Each deployment = New app**: Don't reuse OAuth apps across deployments
- **Regular rotation**: Consider rotating your OAuth app periodically

## Benefits of Individual OAuth Apps

1. **Audit Trail**: See exactly who's using your OAuth app
2. **Rate Limits**: Your own rate limits, not shared
3. **Revocation Control**: Revoke access independently
4. **Usage Analytics**: GitHub provides usage statistics
5. **Customization**: Use your own app name and description

## Legacy Client ID

The old client ID (`Ov23liOrPRXkNN7PMCBt`) has been deactivated. Any attempts to use it will fail with an "Invalid client_id" error.

## Need Help?

- **Documentation**: See [OAuth Setup Guide](setup/OAUTH_SETUP.md)
- **Issues**: https://github.com/DollhouseMCP/mcp-server/issues
- **Security Concerns**: Report to security@dollhousemcp.com

## Timeline

- **August 8, 2025**: Old client ID rotated, new system implemented
- **August 9, 2025**: TokenManager updated to support OAuth device flow tokens
- **Ongoing**: All users should migrate to individual OAuth apps

---

*This migration improves security and gives you full control over your OAuth integration.*