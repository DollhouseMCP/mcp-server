# Platform Badge Documentation

## Overview
This document describes the platform-specific CI badges implemented in the DollhouseMCP README.

## Badge Implementation

### Badge Structure
Each platform badge follows this pattern:
```markdown
[![ALT_TEXT](https://img.shields.io/badge/PLATFORM-STATUS-COLOR?logo=LOGO&logoColor=COLOR)](LINK "TOOLTIP")
```

### Current Badges

**Note**: All platform badges currently link to the same `core-build-test.yml` workflow because it runs a matrix build that tests all platforms simultaneously. The workflow uses GitHub Actions' matrix strategy to test Windows, macOS, and Linux in parallel.

#### Windows Badge
```markdown
[![Windows Build Status](https://img.shields.io/badge/Windows-✓_Tested-0078D4?logo=windows&logoColor=white)](https://github.com/mickdarling/DollhouseMCP/actions/workflows/core-build-test.yml?query=branch:main "Windows CI Build Status")
```
- **Color**: `#0078D4` (Windows Blue)
- **Logo**: Windows logo
- **ALT text**: "Windows Build Status"
- **Tooltip**: "Windows CI Build Status"

#### macOS Badge
```markdown
[![macOS Build Status](https://img.shields.io/badge/macOS-✓_Tested-000000?logo=apple&logoColor=white)](https://github.com/mickdarling/DollhouseMCP/actions/workflows/core-build-test.yml?query=branch:main "macOS CI Build Status")
```
- **Color**: `#000000` (Apple Black)
- **Logo**: Apple logo
- **ALT text**: "macOS Build Status"
- **Tooltip**: "macOS CI Build Status"

#### Linux Badge
```markdown
[![Linux Build Status](https://img.shields.io/badge/Linux-✓_Tested-FCC624?logo=linux&logoColor=black)](https://github.com/mickdarling/DollhouseMCP/actions/workflows/core-build-test.yml?query=branch:main "Linux CI Build Status")
```
- **Color**: `#FCC624` (Linux Yellow)
- **Logo**: Linux Tux logo
- **ALT text**: "Linux Build Status"
- **Tooltip**: "Linux CI Build Status"

## Accessibility Features

1. **ALT Text**: Each badge includes descriptive ALT text for screen readers
2. **Tooltips**: Hover tooltips provide additional context
3. **High Contrast**: Colors chosen for good visibility in both light/dark themes
4. **Semantic Links**: All badges link to relevant CI workflow pages

## Testing & Verification

### Automated Verification
Run the verification script:
```bash
./scripts/verify-badges.sh
```

### Manual Testing Checklist
- [ ] Verify badges display correctly in light theme
- [ ] Verify badges display correctly in dark theme
- [ ] Test all badge links navigate to correct workflow
- [ ] Verify tooltips appear on hover
- [ ] Test with screen reader for accessibility
- [ ] Confirm query parameter filters to main branch only

### Theme Testing
Append theme parameters to GitHub URLs:
- Light theme: `?theme=light`
- Dark theme: `?theme=dark`

## Maintenance

### Updating Badge Status
Currently badges show static "✓ Tested" status. Future enhancements could include:
- Dynamic pass/fail status from GitHub API
- Platform-specific test coverage percentages
- Last test run timestamps

### Adding New Platforms
To add a new platform badge:
1. Choose appropriate platform color and logo
2. Follow the badge structure pattern
3. Add ALT text and tooltip
4. Update this documentation
5. Run verification script

## Future Enhancements

1. **Dynamic Status**: Integrate with GitHub Actions API for real-time status
2. **Coverage Badges**: Add platform-specific test coverage percentages
3. **Version Badges**: Show tested Node.js versions per platform
4. **Performance Metrics**: Add build time indicators per platform

## References
- [Shields.io Documentation](https://shields.io/)
- [GitHub Actions Badge Documentation](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/adding-a-workflow-status-badge)
- [Web Accessibility Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)