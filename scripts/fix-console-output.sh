#!/bin/bash

# Script to replace console calls with logger in all TypeScript files
# This ensures MCP protocol compatibility

echo "Updating console calls to use MCP-safe logger..."

# Update BackupManager.ts
sed -i '' "s/console\.error('Warning: Could not backup all personas:', error);/logger.warn('Could not backup all personas:', error);/" src/update/BackupManager.ts
sed -i '' "s/console\.error(\`Failed to delete backup \${backup.path}:\`, error);/logger.error(\`Failed to delete backup \${backup.path}:\`, error);/" src/update/BackupManager.ts

# Update SignatureVerifier.ts 
sed -i '' "s/console\.error('Failed to import GPG key:', error);/logger.error('Failed to import GPG key:', error);/" src/update/SignatureVerifier.ts

# Update GitHubClient.ts
sed -i '' "s/console\.log('GitHub token validation failed, proceeding without authentication');/logger.info('GitHub token validation failed, proceeding without authentication');/" src/marketplace/GitHubClient.ts

# Update index.ts
sed -i '' "s/console\.warn(\`Personas directory path is not absolute: \${this.personasDir}\`);/logger.warn(\`Personas directory path is not absolute: \${this.personasDir}\`);/" src/index.ts

# Update PersonaLoader.ts
sed -i '' "s/console\.error(/logger.error(/g" src/persona/PersonaLoader.ts

# Update securityMonitor.ts - this needs special handling
# We'll do this manually in the code

echo "Adding logger imports to files..."

# Add logger import to files that need it
for file in src/update/BackupManager.ts src/update/SignatureVerifier.ts src/marketplace/GitHubClient.ts src/persona/PersonaLoader.ts; do
  if ! grep -q "import { logger }" "$file"; then
    # Add import after the first import line
    sed -i '' '1,/^import/ {/^import/a\
import { logger } from "../utils/logger.js";
}' "$file"
  fi
done

echo "Done! Please review the changes and test before committing."