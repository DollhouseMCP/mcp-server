# GitHub OAuth Client ID Rotation Guide

## Why We're Rotating

The OAuth client ID `Ov23liOrPRXkNN7PMCBt` was accidentally hardcoded in the source code and is now exposed in the Git history of our public repository. While GitHub OAuth client IDs are designed to be public (unlike client secrets), having it in a public repo means anyone could impersonate the DollhouseMCP OAuth app.

## Step 1: Deactivate the Old OAuth App

1. **Go to GitHub OAuth Apps**
   - Navigate to: https://github.com/settings/developers
   - Or: GitHub → Settings → Developer settings → OAuth Apps

2. **Find "DollhouseMCP Collection" App**
   - Look for the app with Client ID: `Ov23liOrPRXkNN7PMCBt`
   - Click on the app name to view details

3. **Delete or Deactivate the App**
   - Scroll to the bottom of the app settings page
   - Click the **"Delete application"** button (red button)
   - Confirm the deletion
   - This immediately invalidates the exposed client ID

## Step 2: Create a New OAuth App

1. **Navigate to OAuth Apps**
   - Go to: https://github.com/settings/developers
   - Click **"New OAuth App"** button

2. **Fill in the Application Details**
   ```
   Application name: DollhouseMCP Server
   Homepage URL: https://github.com/DollhouseMCP/mcp-server
   Application description: MCP server for dynamic AI persona management
   Authorization callback URL: http://localhost:12345/callback
   ```
   
   **Note**: The callback URL isn't used for device flow but GitHub requires it. Use the localhost URL as shown.

3. **Configure Device Flow**
   - After creating the app, you'll see the app settings
   - Find the **"Device Flow"** section
   - ✅ Check **"Enable Device Flow"**
   - Click **"Update application"**

4. **Copy Your New Client ID**
   - Your new Client ID will be displayed at the top of the settings page
   - It will look like: `Ov23liXXXXXXXXXXXXXX`
   - **Keep this page open** - you'll need this ID

## Step 3: Configure Your Environment

### For Development

1. **Create a `.env` file** in your project root (if it doesn't exist):
   ```bash
   cd /Users/mick/Developer/Organizations/DollhouseMCP/active/mcp-server
   touch .env
   ```

2. **Add the client ID to `.env`**:
   ```bash
   echo "DOLLHOUSE_GITHUB_CLIENT_ID=your_new_client_id_here" >> .env
   ```
   Replace `your_new_client_id_here` with your actual new client ID

3. **Add `.env` to `.gitignore`** (if not already there):
   ```bash
   echo ".env" >> .gitignore
   ```

### For Production/Users

Users will need to set the environment variable when running the MCP server:

**Option 1: Export in shell**
```bash
export DOLLHOUSE_GITHUB_CLIENT_ID=your_new_client_id_here
```

**Option 2: In Claude Desktop config**
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

## Step 4: Test the New OAuth Flow

1. **Clear any existing auth tokens**:
   ```bash
   rm -rf ~/.dollhouse/.auth/
   ```

2. **Set your environment variable**:
   ```bash
   export DOLLHOUSE_GITHUB_CLIENT_ID=your_new_client_id_here
   ```

3. **Run the test script**:
   ```bash
   node test-oauth-helper.mjs
   ```

4. **Verify the flow**:
   - You should see the device flow start with a new user code
   - Visit https://github.com/login/device
   - Enter the code
   - Authorize the new "DollhouseMCP Server" app
   - Check that authentication completes successfully

## Step 5: Update Documentation

### Files to Update

1. **README.md** - Add OAuth setup instructions
2. **CONTRIBUTING.md** - Add note about not hardcoding client IDs
3. **docs/setup/OAUTH_SETUP.md** - Create detailed setup guide for users

### Example Setup Instructions for Users

```markdown
## OAuth Configuration

DollhouseMCP requires a GitHub OAuth app for authentication. 

### For Administrators/Self-Hosting

1. Create a GitHub OAuth App:
   - Go to GitHub Settings → Developer settings → OAuth Apps
   - Click "New OAuth App"
   - Set callback URL to: `http://localhost:12345/callback`
   - Enable Device Flow in the app settings

2. Set the environment variable:
   ```bash
   export DOLLHOUSE_GITHUB_CLIENT_ID=your_client_id
   ```

3. The server will use this ID for all OAuth operations.

### For End Users

Your administrator should provide you with the configured server.
If you're running your own instance, follow the administrator instructions above.
```

## Step 6: Security Best Practices Going Forward

1. **Never hardcode OAuth credentials** - Always use environment variables
2. **Use `.env` files for development** - Never commit them
3. **Document setup clearly** - Make it easy for users to configure their own apps
4. **Consider using dotenv** - For easier environment management:
   ```bash
   npm install dotenv
   ```
   Then in your code:
   ```javascript
   import dotenv from 'dotenv';
   dotenv.config();
   ```

## Verification Checklist

- [ ] Old OAuth app deleted from GitHub
- [ ] New OAuth app created with Device Flow enabled
- [ ] New client ID saved securely (not in code)
- [ ] Environment variable configured locally
- [ ] `.env` file added to `.gitignore`
- [ ] OAuth flow tested with new client ID
- [ ] Documentation updated with setup instructions
- [ ] Team notified of the change

## Important Notes

1. **The old client ID in Git history** will be harmless once the OAuth app is deleted
2. **Each developer** on the team needs to update their environment
3. **Production deployments** need the new environment variable
4. **Users** will need instructions for setting up their own OAuth apps

## Troubleshooting

### "GitHub OAuth client ID is not configured"
- Ensure `DOLLHOUSE_GITHUB_CLIENT_ID` is set in your environment
- Check spelling and case sensitivity
- Try `echo $DOLLHOUSE_GITHUB_CLIENT_ID` to verify it's set

### "Invalid client_id" from GitHub
- Verify you copied the client ID correctly (no extra spaces)
- Ensure the OAuth app has Device Flow enabled
- Check that the app hasn't been deleted

### Authentication not working after rotation
- Clear old tokens: `rm -rf ~/.dollhouse/.auth/`
- Restart the MCP server after setting the environment variable
- Verify the new OAuth app is active on GitHub

---

## Summary

By rotating the OAuth client ID and requiring environment variable configuration, we:
1. Invalidate the exposed client ID
2. Prevent future hardcoding accidents
3. Give users control over their OAuth configuration
4. Follow security best practices

The exposed ID in Git history becomes harmless once the corresponding OAuth app is deleted from GitHub.