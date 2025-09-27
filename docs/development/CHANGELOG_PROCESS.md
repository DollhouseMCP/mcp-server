# Changelog Update Process

## Overview

The DollhouseMCP project uses a single-source-of-truth approach for version history. All changelog updates flow from `CHANGELOG.md` to generated documentation.

## Architecture

```
CHANGELOG.md (Source of Truth)
    ↓
generate-version-history.js
    ↓
docs/readme/chunks/11-changelog-full.md (Generated)
    ↓
build-readme.js
    ↓
README.md / README.npm.md (Final output)
```

## Process for Adding a New Version

### 1. Update CHANGELOG.md

Edit `CHANGELOG.md` at the repository root and add your new version entry following the [Keep a Changelog](https://keepachangelog.com/) format:

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- New features

### Changed
- Changes in existing functionality

### Fixed
- Bug fixes

### Security
- Security fixes
```

### 2. Generate the Version History Chunk

Run the generation script to create the README chunk from CHANGELOG.md:

```bash
npm run build:readme
```

This command:
1. Runs `scripts/generate-version-history.js` which reads `CHANGELOG.md`
2. Generates `docs/readme/chunks/11-changelog-full.md` with formatted version history
3. Assembles the complete README from all chunks

### 3. Verify the Changes

Check that your changes appear correctly:

```bash
# Check the generated chunk
head -50 docs/readme/chunks/11-changelog-full.md

# Check the final README
head -100 README.md | grep -A10 "Version History"
```

### 4. Commit Your Changes

Commit both the source and generated files:

```bash
git add CHANGELOG.md docs/readme/chunks/11-changelog-full.md README.md README.npm.md
git commit -m "docs: Update changelog for vX.Y.Z"
```

## Important Notes

### DO NOT:
- ❌ Edit `docs/readme/chunks/11-changelog-full.md` directly (it's generated)
- ❌ Edit version history in README.md directly (it's assembled from chunks)
- ❌ Add version entries to chunks without updating CHANGELOG.md

### DO:
- ✅ Always update CHANGELOG.md first
- ✅ Run the build scripts to regenerate
- ✅ Commit all changed files together
- ✅ Keep CHANGELOG.md as the complete history (all versions)

## Configuration

The version history generation is configured in `scripts/generate-version-history.js`:

- **minVersion**: Minimum version to include in README (default: '1.6.0')
- **maxVersions**: Maximum number of versions to show (default: null/unlimited)
- **includePreRelease**: Whether to include pre-release versions (default: false)

These settings control what subset of CHANGELOG.md appears in the README, allowing us to keep a complete history in CHANGELOG.md while showing a curated subset in the README.

## Troubleshooting

### Changes not appearing in README

1. Ensure you've updated CHANGELOG.md
2. Run `npm run build:readme`
3. Check for any errors in the console
4. Verify the chunk was generated: `ls -la docs/readme/chunks/11-changelog-full.md`

### Version appears in chunk but not README

The README might be using a different chunk or the build failed:

```bash
# Rebuild everything
npm run build:readme:github  # For GitHub README
npm run build:readme:npm     # For NPM README
```

### Merge conflicts in generated files

Always regenerate from source:

1. Resolve conflicts in CHANGELOG.md (source of truth)
2. Delete conflicted generated files
3. Run `npm run build:readme` to regenerate

## Related Documentation

- [Build Process](./BUILD_PROCESS.md)
- [Release Process](./RELEASE_PROCESS.md)
- [Version Management](./VERSION_MANAGEMENT.md)