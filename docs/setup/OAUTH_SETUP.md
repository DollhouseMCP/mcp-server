# OAuth Setup Guide for DollhouseMCP

This guide explains how to configure GitHub OAuth for the DollhouseMCP server.

## Prerequisites

- A GitHub account
- Admin access to create OAuth apps (for administrators)
- The DollhouseMCP server installed

## For Administrators / Self-Hosting

### Step 1: Create a GitHub OAuth App

1. Go to GitHub Settings:
   - Click your profile picture → Settings
   - Navigate to "Developer settings" (bottom of sidebar)
   - Click "OAuth Apps"
   - Click "New OAuth App"

2. Fill in the application details:
   - **Application name**: `DollhouseMCP Server` (or your preferred name)
   - **Homepage URL**: `https://github.com/DollhouseMCP/mcp-server` (or your fork)
   - **Application description**: `MCP server for dynamic AI persona management`
   - **Authorization callback URL**: `http://localhost:12345/callback`
     - Note: This URL is required but not used for device flow

3. Click "Register application"

### Step 2: Enable Device Flow

1. After creating the app, you'll be on the app settings page
2. Scroll down to find "Device Flow"
3. Check the box: ✅ **Enable Device Flow**
4. Click "Update application"

### Step 3: Get Your Client ID

1. Your Client ID is displayed at the top of the app settings page
2. It will look like: `Ov23liABCDEFGHIJKLMN`
3. Copy this ID - you'll need it for configuration

### Step 4: Configure the Environment Variable

Choose one of these methods:

#### Method A: Shell Export (Temporary)
```bash
export DOLLHOUSE_GITHUB_CLIENT_ID="your_client_id_here"
```

#### Method B: Shell Profile (Permanent)
Add to `~/.bashrc`, `~/.zshrc`, or your shell profile:
```bash
echo 'export DOLLHOUSE_GITHUB_CLIENT_ID="your_client_id_here"' >> ~/.zshrc
source ~/.zshrc
```

#### Method C: .env File (Development)
Create a `.env` file in the project root:
```bash
DOLLHOUSE_GITHUB_CLIENT_ID=your_client_id_here
```

#### Method D: Claude Desktop Configuration
In your Claude Desktop config file:
```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["/path/to/dollhousemcp/dist/index.js"],
      "env": {
        "DOLLHOUSE_GITHUB_CLIENT_ID": "your_client_id_here"
      }
    }
  }
}
```

### Step 5: Verify Configuration

Run this command to verify your setup:
```bash
echo "Client ID configured: $DOLLHOUSE_GITHUB_CLIENT_ID"
```

## For End Users

If you're using a DollhouseMCP server set up by someone else:

1. **Ask your administrator** for the server configuration
2. They should provide you with either:
   - A pre-configured server instance, or
   - Instructions with the client ID to use

If you're setting up your own instance, follow the administrator instructions above.

## How OAuth Works in DollhouseMCP

1. **Device Flow**: When you authenticate, the server uses GitHub's device flow
2. **User Code**: You'll receive a code like `AB12-CD34`
3. **Authorization**: Visit https://github.com/login/device and enter your code
4. **Token Storage**: Once authorized, your token is stored securely locally
5. **Persistence**: Authentication persists across server restarts

## Testing Your OAuth Setup

1. Start the MCP server with your client ID configured
2. In Claude Desktop, run: "set up GitHub authentication"
3. You should see:
   - A user code (like `AB12-CD34`)
   - Instructions to visit https://github.com/login/device
4. Complete the authorization on GitHub
5. Verify with: "check GitHub authentication status"

## Troubleshooting

### "GitHub OAuth client ID is not configured"

**Problem**: The environment variable isn't set
**Solution**: 
- Verify the variable name: `DOLLHOUSE_GITHUB_CLIENT_ID` (exact spelling)
- Check it's exported: `echo $DOLLHOUSE_GITHUB_CLIENT_ID`
- Restart your shell or source your profile after adding it

### "Invalid client_id"

**Problem**: GitHub doesn't recognize the client ID
**Solution**:
- Verify you copied the full client ID (no spaces)
- Check the OAuth app still exists in your GitHub settings
- Ensure Device Flow is enabled for the app

### "Authorization pending" never completes

**Problem**: The helper process might not be running
**Solution**:
- Check if the helper is running: `ps aux | grep oauth-helper`
- Look at logs: `cat ~/.dollhouse/oauth-helper.log`
- Try restarting the authentication process

### Can't find the OAuth app settings

**Navigation path**:
1. GitHub.com → Your Profile Picture
2. Settings (in dropdown)
3. Developer settings (bottom of left sidebar)
4. OAuth Apps
5. Click on your app name

## Security Best Practices

1. **Never share your OAuth tokens** - They provide access to your GitHub account
2. **Don't hardcode client IDs** in source code - Always use environment variables
3. **Rotate client IDs** if they're accidentally exposed
4. **Use separate OAuth apps** for development and production
5. **Monitor your OAuth app** - GitHub shows usage statistics and authorized users

## Advanced Configuration

### Multiple Environments

For development and production:
```bash
# Development
export DOLLHOUSE_GITHUB_CLIENT_ID_DEV="dev_client_id"

# Production  
export DOLLHOUSE_GITHUB_CLIENT_ID_PROD="prod_client_id"

# In your script
if [ "$NODE_ENV" = "production" ]; then
  export DOLLHOUSE_GITHUB_CLIENT_ID=$DOLLHOUSE_GITHUB_CLIENT_ID_PROD
else
  export DOLLHOUSE_GITHUB_CLIENT_ID=$DOLLHOUSE_GITHUB_CLIENT_ID_DEV
fi
```

### Docker Configuration

In `docker-compose.yml`:
```yaml
services:
  dollhousemcp:
    image: dollhousemcp/mcp-server
    environment:
      - DOLLHOUSE_GITHUB_CLIENT_ID=${DOLLHOUSE_GITHUB_CLIENT_ID}
```

### Kubernetes Secret

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: dollhousemcp-oauth
type: Opaque
stringData:
  client-id: "your_client_id_here"
```

## Getting Help

- **Documentation**: https://github.com/DollhouseMCP/mcp-server/docs
- **Issues**: https://github.com/DollhouseMCP/mcp-server/issues
- **Community**: Open an issue for OAuth setup help

## Summary

1. Create a GitHub OAuth app with Device Flow enabled
2. Set the `DOLLHOUSE_GITHUB_CLIENT_ID` environment variable
3. Test the authentication flow
4. Keep your client ID secure (but remember it's public by design)

That's it! Your DollhouseMCP server is now configured for GitHub OAuth authentication.