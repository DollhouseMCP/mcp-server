# Testing Guide for @dollhousemcp/safety

This document provides comprehensive guidance for testing the safety package, including automated unit tests, integration testing strategies, and manual testing procedures for platform-specific GUI dialogs.

## Table of Contents

1. [Automated Testing](#automated-testing)
2. [Integration Testing](#integration-testing)
3. [Manual Testing](#manual-testing)
4. [Platform-Specific Testing](#platform-specific-testing)
5. [Security Testing](#security-testing)

## Automated Testing

### Running Tests

```bash
# Run all tests
npm test

# Run tests with coverage
npm test -- --coverage

# Run tests in watch mode
npm test -- --watch

# Run specific test file
npm test -- DisplayService.test.ts
```

### Test Coverage Requirements

- **Minimum coverage**: 90%
- **Critical paths**: 100% coverage required for security-sensitive functions

### What's Tested Automatically

| Component | Coverage | Notes |
|-----------|----------|-------|
| TieredSafetyService | Full | Logic flow, tier determination, regex caching |
| DisplayService | Partial | Mocked platform detection, error handling |
| AuditLogger | Full | Logging, formatting |
| Config | Full | Default values, validation |

### Mocking Strategy

The test suite uses Jest ESM mocking to simulate:

- **`os.platform()`**: Returns mock platform values (darwin, win32, linux, etc.)
- **`child_process.execSync()`**: Simulates command execution and responses

```typescript
// Example: Mock platform detection
jest.unstable_mockModule('os', () => ({
  platform: jest.fn().mockReturnValue('darwin'),
}));
```

## Integration Testing

### When Integration Tests Are Needed

Integration tests should be added when:

1. Testing interaction between multiple safety components
2. Verifying end-to-end safety tier determination
3. Testing configuration loading and application
4. Validating audit log output format

### Running Integration Tests

```bash
# Run integration tests
npm run test:integration

# Run with specific pattern
npm test -- --testPathPattern=integration
```

### Example Integration Test

```typescript
describe('Safety System Integration', () => {
  it('should escalate tier when agent chain depth exceeds threshold', async () => {
    const config = { ...DEFAULT_SAFETY_CONFIG, agentChain: { maxAutonomousDepth: 2 } };

    // Create nested execution context
    const parentContext = createExecutionContext('agent1', undefined, config);
    const childContext = createExecutionContext('agent2', parentContext, config);
    const grandchildContext = createExecutionContext('agent3', childContext, config);

    // Verify depth escalation
    expect(grandchildContext.depthEscalation).toBe(true);
    expect(grandchildContext.requiresHumanCheckin).toBe(true);
  });
});
```

## Manual Testing

### Why Manual Testing Is Required

The DisplayService shows native OS dialogs that:
- Require a GUI environment
- Need user interaction (clicking buttons)
- Display content that should NOT be visible to the LLM
- Behave differently across platforms

**Automated tests cannot verify:**
- Actual dialog appearance
- User interaction flow
- LLM-proof code hiding (verification that stdout doesn't contain secrets)

### Manual Test Checklist

#### Pre-Testing Setup

- [ ] Ensure you have a GUI environment (not SSH without X forwarding)
- [ ] Install required dialog tools (Linux only)
- [ ] Prepare test scripts

#### Test Scenarios

1. **Basic Dialog Display**
   ```typescript
   import { showVerificationDialog } from '@dollhousemcp/safety';

   const result = showVerificationDialog(
     'ABC123',
     'Please verify your identity'
   );
   console.log('Result:', result);
   ```

   - [ ] Dialog appears with correct title
   - [ ] Verification code is visible in dialog
   - [ ] Clicking OK returns `success: true`
   - [ ] Clicking Cancel returns `success: false`
   - [ ] **CRITICAL**: Verification code does NOT appear in console output

2. **Custom Options**
   ```typescript
   showVerificationDialog('XYZ789', 'Security check', {
     title: 'Custom Security Dialog',
     icon: 'error',
     buttons: ['Proceed', 'Abort'],
   });
   ```

   - [ ] Custom title is displayed
   - [ ] Error icon is shown
   - [ ] Custom button labels appear

3. **Special Characters (Security)**
   ```typescript
   showVerificationDialog(
     'CODE123',
     "Test with 'quotes' and $variables and `backticks`"
   );
   ```

   - [ ] Dialog displays without errors
   - [ ] Special characters render correctly
   - [ ] No command injection occurs

## Platform-Specific Testing

### macOS (darwin)

**Requirements:**
- macOS 10.x or later
- osascript (pre-installed)

**Test command:**
```bash
osascript -e 'display dialog "Test" with title "Test Dialog"'
```

**Verification:**
- [ ] Native macOS dialog appears
- [ ] Correct button order (default button is rightmost)
- [ ] Icon matches (note/caution/stop)

### Linux

**Requirements (one of):**
- zenity (GNOME)
- kdialog (KDE)
- xmessage (X11 fallback)

**Install test tools:**
```bash
# Debian/Ubuntu
sudo apt install zenity

# Fedora/RHEL
sudo dnf install zenity

# KDE systems
sudo apt install kdialog
```

**Test commands:**
```bash
# Test zenity
zenity --warning --text="Test message" --title="Test"

# Test kdialog
kdialog --sorry "Test message" --title "Test"

# Test xmessage
xmessage -center "Test message"
```

**Verification:**
- [ ] Correct dialog tool is used (zenity > kdialog > xmessage)
- [ ] Fallback chain works when primary tools missing
- [ ] Error message appears when no tools available (headless server)

### Windows (win32)

**Requirements:**
- Windows 10/11
- PowerShell 5.0+ (pre-installed)

**Test command:**
```powershell
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show('Test message', 'Test Title', 'OKCancel', 'Warning')
```

**Verification:**
- [ ] Native Windows MessageBox appears
- [ ] Correct icon type (Information/Warning/Error)
- [ ] Button clicks return correct results

## Security Testing

### LLM-Proof Verification Testing

The most critical security test: verification codes must NEVER appear in stdout.

**Test procedure:**

1. Run this test script:
   ```typescript
   import { showVerificationDialog } from '@dollhousemcp/safety';

   // The code 'SUPERSECRET123' should ONLY appear in the dialog
   const result = showVerificationDialog(
     'SUPERSECRET123',
     'Testing code visibility'
   );
   ```

2. Capture all output:
   ```bash
   node test-script.ts 2>&1 | tee output.log
   ```

3. Verify:
   ```bash
   # This should return NO matches
   grep -i "SUPERSECRET123" output.log
   ```

- [ ] **PASS**: Code not found in output.log
- [ ] **FAIL**: Code appears in output - SECURITY VULNERABILITY

### Shell Injection Testing

Test that malicious input cannot escape the shell:

```typescript
showVerificationDialog(
  'CODE',
  '$(whoami)',  // Should NOT execute
);

showVerificationDialog(
  'CODE',
  "'; rm -rf /; echo '",  // Should NOT execute
);
```

- [ ] Commands do not execute
- [ ] Dialog shows literal text
- [ ] No errors or crashes

### Fuzzing Recommendations

For comprehensive security testing, consider fuzzing with:
- Very long strings (>10,000 chars)
- Unicode and emoji characters
- Null bytes and control characters
- Nested quotes and escapes

## Troubleshooting

### Tests Fail with "Cannot find module"

Ensure you've built the package:
```bash
npm run build
```

### ESM Mocking Issues

Use `jest.unstable_mockModule()` for ESM modules, not `jest.mock()`.

### Platform Detection Issues in Tests

Verify mocks are set up before importing the tested module:
```typescript
// CORRECT: Mock before import
jest.unstable_mockModule('os', () => ({ platform: jest.fn() }));
const { platform } = await import('os');

// WRONG: Import before mock
import { platform } from 'os';
jest.mock('os');  // Too late!
```

## Continuous Integration

### CI Test Matrix

| Platform | Node Version | Status |
|----------|--------------|--------|
| ubuntu-latest | 20.x | Automated |
| windows-latest | 20.x | Automated |
| macos-latest | 20.x | Automated |

### CI Limitations

CI environments typically don't have GUI access, so:
- Dialog display tests are skipped
- Only mocked platform tests run
- Manual testing required for full coverage

---

*Last updated: December 23, 2024*
