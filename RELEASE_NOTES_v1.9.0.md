# Release Notes - v1.9.0

**Release Date**: September 19, 2025
**Type**: Minor Release
**Codename**: Memory Milestone

## 🎉 Highlights

We're excited to announce v1.9.0 of DollhouseMCP, featuring the highly anticipated **Memory element type**! This release marks a major milestone with PR #1000, introducing persistent context storage with enterprise-grade scalability and security features.

## ✨ New Features

### Memory Element Implementation 🧠
The Memory element provides persistent context storage with advanced features:

- **Smart Organization**: Automatic date-based folder structure (YYYY-MM-DD) prevents performance issues at scale
- **Deduplication**: SHA-256 content hashing prevents duplicate storage
- **Fast Search**: Built-in indexing for queries across thousands of entries
- **Privacy Controls**: Three-tier privacy levels (private, team, public)
- **Retention Policies**: Automatic cleanup based on age and capacity
- **Tag System**: Organize and find memories with flexible tagging
- **Rich Metadata**: Track statistics, timestamps, and context

### Performance Enhancements ⚡
- 60-second cache for date folder operations
- Atomic file operations prevent corruption
- Efficient collision handling with version suffixes
- Optimized search indexing for large datasets

### Security Improvements 🔒
- Comprehensive input validation and sanitization
- Security event audit logging throughout
- Memory size limits to prevent DoS attacks
- Content hash verification for integrity

## 📊 Technical Details

### Memory Storage Structure
```
~/.dollhouse/portfolio/memories/
├── 2025-09-18/
│   └── project-context.yaml
├── 2025-09-19/
│   ├── meeting-notes.yaml
│   └── code-review.yaml
```

### Key Capabilities
- Add unlimited entries per memory (with configurable limits)
- Search by content, tags, or metadata
- Automatic retention policy enforcement
- Statistics tracking (size, count, dates)
- Multiple storage backends (file system now, database support planned)

## 🐛 Bug Fixes

- Fixed CI test conflicts with GitHub integration tests (#1001)
- Resolved race conditions in concurrent file operations
- Fixed Unicode normalization issues in memory content

## 🔄 Changes

- Memory files now save to date-based folders instead of flat directory
- Content deduplication enabled by default
- Search indexing triggers automatically at 100+ entries

## ⚠️ Known Issues

- Prototype pollution warnings in ConfigManager (low priority, main branch only)
- Memory encryption not yet implemented (planned for v2.0)

## 📈 Statistics

- **89 tests** for memory functionality alone
- **100% pass rate** on all CI workflows
- **2 major PRs** merged (#1000, #1001)
- **3+ issues** resolved or advanced

## 🚀 Getting Started with Memories

### Create a Memory
```typescript
import { Memory } from '@dollhousemcp/mcp-server';

const memory = new Memory({
  name: 'project-context',
  description: 'Context for my project',
  tags: ['project', 'important']
});

// Add entries
await memory.addEntry('Design decision: Use TypeScript', ['decision', 'architecture']);
await memory.addEntry('Meeting notes from standup', ['meeting', 'daily']);
```

### Search Memories
```typescript
// Search by content
const results = await memory.search({ query: 'TypeScript' });

// Search by tags
const meetings = await memory.search({ tags: ['meeting'] });
```

## 💻 Installation

```bash
npm install @dollhousemcp/mcp-server@1.9.0
```

## 📋 Migration

No migration needed - Memories are a new feature with no existing data.

## 🙏 Acknowledgments

Special thanks to everyone who contributed to this milestone release, especially reaching PR #1000!

## 📝 Full Changelog

For a complete list of changes, see the [full changelog](https://github.com/DollhouseMCP/mcp-server/compare/v1.8.1...v1.9.0).

## 🔮 What's Next

- **v2.0.0**: Memory encryption and cloud sync
- **v1.10.0**: Enhanced search with fuzzy matching
- **v1.11.0**: Memory templates and presets

---

**Note**: This is an MVP release of the Memory feature. We welcome feedback and bug reports at our [GitHub repository](https://github.com/DollhouseMCP/mcp-server/issues).

🤖 Generated with [Claude Code](https://claude.ai/code)