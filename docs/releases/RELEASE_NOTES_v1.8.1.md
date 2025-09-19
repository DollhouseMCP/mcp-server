# Release Notes - v1.8.1

## 🎯 Overview
Version 1.8.1 is a stability release focused on improving CI reliability and test consistency across all platforms.

## 🐛 Bug Fixes

### CI Test Reliability Improvements
- **Fixed GitHub API 409 Conflicts** (#954, #958)
  - Added retry mechanism for parallel CI job conflicts
  - Increased retry attempts from 3 to 5
  - Added 20% jitter to prevent thundering herd effect
  - Resolves persistent failures in `real-github-integration.test.ts`

- **Fixed Windows Performance Test Timing** (#957, #958)
  - Adjusted performance thresholds for Windows CI environments
  - Platform-specific detection for appropriate timing limits
  - Resolves `ToolCache.test.ts` and `portfolio-filtering.performance.test.ts` failures

### Other Improvements
- Updated website URL in package.json (#952)
- Comprehensive changelog documentation (#953)

## 📊 Test Coverage
- All tests passing across Ubuntu, macOS, and Windows
- Node.js 18.x, 20.x, and 22.x compatibility verified
- Extended Node Compatibility workflow now stable

## 🔧 Technical Details

### Changes to Retry Logic
```typescript
// Added jitter to retry delays
const jitterFactor = 0.8 + Math.random() * 0.4;
const currentDelay = Math.min(Math.floor(delayMs * jitterFactor), maxDelayMs);

// Increased max attempts for 409 conflicts
maxAttempts: 5  // was 3
```

### Platform-Specific Thresholds
```typescript
const isWindows = process.platform === 'win32';
const performanceThreshold = isCI ? (isWindows ? 75 : 50) : 10;
```

## 📦 Installation
```bash
npm install @dollhousemcp/mcp-server@1.8.1
```

## 🙏 Contributors
- CI reliability improvements and testing

## 📝 Full Changelog
For complete details, see the [CHANGELOG.md](./CHANGELOG.md)

---
*Released: September 15, 2025*