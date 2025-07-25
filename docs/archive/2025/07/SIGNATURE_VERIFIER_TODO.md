# SignatureVerifier Implementation TODO

## Current Status
The SignatureVerifier is implemented but tests are failing due to mock setup issues.

## Fix Required

In `__tests__/unit/auto-update/SignatureVerifier.test.ts`:

The mock setup needs to be fixed. Current error:
```
TypeError: mockSafeExec.mockImplementation is not a function
```

## Solution
The issue is that the jest.mock() call needs to happen after the import. Try this pattern:

```typescript
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { SignatureVerifier } from '../../../src/update/SignatureVerifier.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Create mock
const mockSafeExec = jest.fn();

// Mock the module
jest.mock('../../../src/utils/git.js', () => ({
  safeExec: mockSafeExec
}));
```

Or use manual mocks approach.

## What SignatureVerifier Does

1. **Tag Verification**: Verifies GPG signatures on git tags
2. **Checksum Verification**: Validates file checksums (SHA256)
3. **Trusted Keys**: Maintains list of trusted GPG keys
4. **Development Mode**: Allows unsigned releases in dev

## Integration Points

1. **UpdateChecker**: 
   - Calls `verifyTagSignature()` when checking releases
   - Shows signature status in results
   - Can require signed releases in production

2. **UpdateManager**:
   - Could verify downloaded artifacts before installation
   - Currently only UpdateChecker uses it

## Security Benefits

1. **Authenticity**: Ensures releases come from trusted maintainers
2. **Integrity**: Prevents tampering with releases
3. **Supply Chain**: Protects against compromised releases
4. **Transparency**: Shows who signed each release

## Testing Coverage

Once fixed, tests cover:
- Valid signed tags
- Unsigned tags (allowed in dev)
- Invalid signatures
- Trusted key verification
- GPG not installed
- Checksum verification
- Release artifact verification

## Production Considerations

1. **GPG Required**: Production deployments need GPG installed
2. **Key Management**: Need to add trusted maintainer keys
3. **Signing Process**: Releases must be tagged and signed
4. **Documentation**: Need docs on how to sign releases