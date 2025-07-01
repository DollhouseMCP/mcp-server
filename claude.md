# Claude Project Context: DollhouseMCP

## Project Overview

DollhouseMCP is a professional Model Context Protocol (MCP) server that enables dynamic AI persona management from markdown files. It allows Claude and other compatible AI assistants to activate and switch between different behavioral personas, with an integrated GitHub-powered marketplace for sharing and monetizing personas.

**Repository**: https://github.com/mickdarling/DollhouseMCP  
**Marketplace**: https://github.com/mickdarling/DollhouseMCP-Personas  
**Website**: https://dollhousemcp.com (planned)  
**Author**: Mick Darling (mick@mickdarling.com)  
**License**: AGPL-3.0 with Platform Stability Commitments  

## Project Status: Phase 2B Complete ✅

### Completed (Phase 1 - Foundation):
✅ **Fresh Repository Setup** - Clean DollhouseMCP repository with AGPL-3.0 license  
✅ **Complete Rebranding** - All references updated from persona-mcp-server to DollhouseMCP  
✅ **Advanced Unique ID System** - Format: `what-it-is_YYYYMMDD-HHMMSS_who-made-it`  
✅ **Enhanced Metadata Schema** - Categories, pricing, AI generation flags, age ratings  
✅ **Anonymous User Support** - Auto-generated IDs like `anon-clever-fox-x7k2`  
✅ **Backwards Compatibility** - Existing personas automatically get unique IDs  

### Completed (Phase 2A - GitHub Marketplace & User Identity):
✅ **GitHub Marketplace Integration** - Complete API-powered marketplace browsing  
✅ **User Identity System** - Environment-based user management and attribution  
✅ **Marketplace Tools** - Browse, search, install, submit personas via GitHub API  
✅ **Community Workflow** - GitHub issue-based submission for marketplace inclusion  
✅ **Local-First Architecture** - Full functionality without cloud infrastructure  

### Completed (Phase 2B - Chat-Based Persona Management):
✅ **Complete Persona CRUD Operations** - create_persona, edit_persona, validate_persona tools  
✅ **Guided Chat Interface** - User-friendly persona creation through conversational commands  
✅ **Comprehensive Validation** - Quality checks with detailed reports and recommendations  
✅ **Real-time Editing** - Modify any persona field with automatic version bumping  
✅ **Error Handling & UX** - Clear feedback, conflict detection, and helpful guidance  

### Next Steps (Phase 2C - Private Personas & Advanced Features):
🔄 **Local Private Persona Support** - User-specific directories and privacy controls  
🔄 **Enhanced Management Features** - Templates, bulk operations, advanced search  
🔄 **Collaboration Tools** - Persona sharing, forking, versioning  

### Future (Phase 3 - Business Platform):
📋 **DollhouseMCP.com Website** - Classic web interface with user accounts  
📋 **Payment Processing** - Premium persona monetization (80/20 creator/platform split)  
📋 **Cloud Sync & Storage** - Cross-device private persona synchronization  
📋 **Community Features** - Reviews, ratings, advanced search, recommendations  

## Current Project Structure

```
DollhouseMCP/
├── src/
│   └── index.ts              # Main MCP server (DollhouseMCPServer class)
├── dist/                     # Compiled JavaScript (auto-generated)
├── personas/                 # Local persona collection
│   ├── creative-writer.md    # Enhanced with unique ID system
│   ├── technical-analyst.md
│   ├── eli5-explainer.md
│   ├── business-consultant.md
│   └── debug-detective.md
├── package.json              # Project config (dollhousemcp, AGPL-3.0)
├── tsconfig.json             # TypeScript configuration
├── LICENSE                   # AGPL-3.0 with platform stability terms
├── README.md                 # User documentation (needs updating)
└── claude.md                 # This context file
```

```
DollhouseMCP-Personas/         # Marketplace repository (GitHub)
├── README.md                  # Marketplace documentation
├── personas/
│   ├── creative/             # Category-based organization
│   ├── professional/
│   ├── educational/
│   ├── gaming/
│   └── personal/
├── marketplace.json           # Marketplace metadata
└── submission-guidelines.md   # Contribution guidelines
```

## Current MCP Tools (17 Available)

### **Core Persona Management**
1. **`list_personas`** - Display all local personas with enhanced metadata
2. **`activate_persona`** - Activate by name, filename, or unique ID
3. **`get_active_persona`** - Get current persona info
4. **`deactivate_persona`** - Return to default mode
5. **`get_persona_details`** - View complete persona details
6. **`reload_personas`** - Refresh from filesystem

### **GitHub Marketplace Integration** ⭐ NEW
7. **`browse_marketplace`** - Browse personas by category using GitHub API
8. **`search_marketplace`** - Search across all personas with GitHub Search
9. **`get_marketplace_persona`** - View detailed persona info from marketplace
10. **`install_persona`** - One-click download and local installation
11. **`submit_persona`** - Submit via automated GitHub issue creation

### **User Identity Management** ⭐ NEW
12. **`set_user_identity`** - Set username for persona attribution
13. **`get_user_identity`** - View current identity status
14. **`clear_user_identity`** - Return to anonymous mode

### **Chat-Based Persona Management** ⭐ NEW (Phase 2B)
15. **`create_persona`** - Guided persona creation through chat interface
16. **`edit_persona`** - Modify existing persona metadata and content
17. **`validate_persona`** - Comprehensive format and quality validation

## Technical Architecture

### Core Server Implementation (`src/index.ts`)
- **Framework**: TypeScript with MCP SDK v0.5.0
- **Transport**: StdioServerTransport for Claude Desktop integration
- **Class**: `DollhouseMCPServer` (renamed from PersonaMCPServer)
- **File Management**: Uses `gray-matter` for YAML frontmatter parsing
- **GitHub Integration**: Native GitHub API calls with error handling
- **User Management**: Environment-based identity with session persistence

### Enhanced Persona Metadata Schema
```typescript
interface PersonaMetadata {
  name: string;                    // Display name
  description: string;             // Brief description
  unique_id?: string;              // Auto-generated if missing
  author?: string;                 // Creator username or anonymous ID
  triggers?: string[];             // Activation keywords
  version?: string;                // Version number
  category?: string;               // Room category (creative, professional, etc.)
  age_rating?: 'all' | '13+' | '18+';  // Content rating
  content_flags?: string[];        // Content warnings/features
  ai_generated?: boolean;          // AI vs human created
  generation_method?: 'human' | 'ChatGPT' | 'Claude' | 'hybrid';
  price?: string;                  // 'free' or '$X.XX'
  revenue_split?: string;          // Creator/platform split
  license?: string;                // Content license
  created_date?: string;           // Creation date
}
```

### Unique ID System
**Format**: `what-it-is_YYYYMMDD-HHMMSS_who-made-it`

**Examples**:
- `creative-writer_20250701-150000_dollhousemcp`
- `debug-detective_20250701-154234_mick`
- `custom-persona_20250701-160000_anon-clever-fox-x7k2`

**Benefits**:
- Alphabetical sorting shows type first, then chronological
- Most recent personas appear at top of each category
- Unique across all users and time periods
- Human-readable yet systematically organized

### GitHub Marketplace Architecture

**Repository**: `github.com/mickdarling/DollhouseMCP-Personas`
**API Integration**: 
- Contents API for browsing and downloading
- Search API for finding personas
- Issues API for community submissions

**Workflow**:
1. **Browse** → GitHub Contents API → Category listings
2. **Search** → GitHub Search API → Content-based results  
3. **Install** → Download & decode Base64 → Save locally
4. **Submit** → Generate GitHub issue → Community review

### User Identity System
**Environment Variables**:
- `DOLLHOUSE_USER` - Username for persona attribution
- `DOLLHOUSE_EMAIL` - Contact email (optional)

**Features**:
- Session-based identity management
- Automatic persona attribution
- Anonymous fallback with generated IDs
- Environment persistence across sessions

### Enhanced List Display Format
```
🔹 Creative Writer (creative-writer_20250701-150000_dollhousemcp)
   An imaginative storyteller focused on engaging narratives
   📁 creative | 🎭 dollhousemcp | 🔖 free | 👤 Human
   Age: all | Version: 1.0
   Triggers: creative, story, narrative, imagination, writing
```

## Installation & Usage

### Current Setup (Phase 2A)
```bash
# Clone and build
git clone https://github.com/mickdarling/DollhouseMCP.git
cd DollhouseMCP
npm install
npm run build

# Set user identity (optional)
export DOLLHOUSE_USER="your-username"
export DOLLHOUSE_EMAIL="your-email@example.com"
```

### Claude Desktop Configuration
```json
{
  "mcpServers": {
    "dollhousemcp": {
      "command": "node",
      "args": ["/path/to/DollhouseMCP/dist/index.js"]
    }
  }
}
```

### Usage Examples

**Marketplace Browsing:**
```
browse_marketplace                    # See all categories
browse_marketplace "creative"         # Browse creative personas
search_marketplace "writing"          # Search for writing personas
get_marketplace_persona "creative/storyteller.md"  # View details
install_persona "creative/storyteller.md"          # Install locally
```

**User Identity:**
```
set_user_identity "mick"             # Set your username  
get_user_identity                    # Check current status
clear_user_identity                  # Return to anonymous
```

**Persona Management:**
```
list_personas                        # See local collection
activate_persona "Creative Writer"   # Activate persona
submit_persona "Creative Writer"     # Submit to marketplace
```

**Chat-Based Persona Creation & Editing:**
```
create_persona "Study Buddy" "A helpful tutor" "educational" "You are a patient tutor..."
edit_persona "Study Buddy" "description" "An encouraging academic mentor"
edit_persona "Study Buddy" "instructions" "You are a supportive tutor who..."
validate_persona "Study Buddy"      # Check quality and format
```

## Business Model & Legal Framework

### Licensing Strategy
- **Core Server**: AGPL-3.0 (prevents proprietary competing platforms)
- **Platform Terms**: Custom with creator-friendly 80/20 revenue split
- **Persona Content**: CC-BY-SA-4.0 for free, custom licenses for premium

### Platform Stability Commitments (Ulysses Contract)
- 90-day advance notice for monetization changes
- 12-month revenue sharing locks
- Full data portability rights
- 180-day transition periods for ownership changes
- Community advisory input on policy changes

### User Tiers (Current & Planned)
1. **Anonymous**: Local use, community uploads (public domain)
2. **Registered** (Phase 2A): Environment-based identity, marketplace participation
3. **Creator** (Phase 3): Cloud accounts, monetization rights, 80/20 split, analytics

### Content Categories ("Rooms")
- 🏢 Professional (Excel, coding, business, consulting)
- 🎭 Creative (writing, art, storytelling, imagination)
- 🎲 Gaming (RPG, character creation, game assistance)
- 🔬 Educational (tutoring, explanations, teaching)
- 🏠 Personal (productivity, lifestyle, habits)
- 🔞 Adult (18+ content, clearly marked and separated)
- 👨‍👩‍👧‍👦 Family-Friendly (child-appropriate, educational)

## Development Workflow

### Current Build System
- **Source**: `src/` directory (TypeScript)
- **Output**: `dist/` directory (JavaScript + declarations)
- **Target**: ES2022 with ESM modules
- **Package**: `dollhousemcp` on npm (planned)

### Available Scripts
- `npm run build` - Compile TypeScript
- `npm run start` - Run compiled server
- `npm run dev` - Development mode with auto-reload
- `npm run clean` - Remove compiled files
- `npm run rebuild` - Clean and rebuild
- `npm run setup` - Install dependencies and build

### Testing Status
- ✅ **Build System**: TypeScript compilation working
- ✅ **Server Startup**: DollhouseMCP server boots correctly
- ✅ **Persona Loading**: Unique ID generation and metadata parsing
- ✅ **GitHub Integration**: Marketplace browsing and installation working
- ✅ **User Identity**: Environment-based attribution functional
- 🔄 **Integration Testing**: Needs testing with Claude Desktop in real scenarios

## Implementation Roadmap

### Phase 2B: Enhanced User Experience (Next)
**Priority: High**
1. **Persona Creation Tools**:
   - `create_persona` - Guided creation with templates and validation
   - `edit_persona` - In-place editing of existing personas
   - `validate_persona` - Format and metadata validation
   - `export_persona` - Export for sharing or backup

2. **Local Private Personas**:
   - User-specific directories (`personas/private-{username}/`)
   - Private persona management separate from public collection
   - Preparation for cloud sync architecture

3. **Enhanced Management**:
   - Persona templates and wizards
   - Bulk operations (import/export collections)
   - Advanced search and filtering of local personas
   - Persona analytics and usage tracking

### Phase 2C: Advanced Local Features (Future)
**Priority: Medium**
1. **Collaboration Features**:
   - Persona forking and versioning
   - Local persona sharing (file-based)
   - Comment and annotation system

2. **Advanced Tools**:
   - Persona performance analytics
   - A/B testing framework for personas
   - Automated quality scoring

### Phase 3: Business Platform (Future)
**Priority: Low (Infrastructure Required)**
1. **Website Development** (dollhousemcp.com):
   - User registration and authentication
   - Web-based persona browser and creator
   - Payment processing integration
   - Community features (reviews, ratings)

2. **Cloud Infrastructure**:
   - RESTful API for persona CRUD operations
   - Cross-device synchronization
   - Private persona cloud storage
   - Advanced analytics and insights

3. **Monetization Features**:
   - Payment processing (Stripe integration)
   - Revenue sharing automation
   - Premium persona tiers
   - Enterprise features and APIs

## Security & Compliance

### Current Implementation
- **No Hardcoded Secrets**: All sensitive config via environment variables
- **Input Validation**: Persona identifiers and user input validated
- **Error Isolation**: Persona failures don't affect server stability
- **AGPL Compliance**: Source disclosure requirements for network use
- **GitHub API**: Proper User-Agent and rate limiting considerations

### Planned Security Features
- User authentication and authorization (Phase 3)
- Content validation and moderation
- Payment processing security (PCI compliance)
- GDPR compliance for EU users
- Regular security audits and dependency updates

## Project History & Transformation

### Phase 1 Transformation (Completed July 1, 2025):
1. **Repository Migration**: Fresh start with clean git history
2. **Complete Rebranding**: All references updated to DollhouseMCP
3. **License Upgrade**: MIT → AGPL-3.0 with platform stability commitments
4. **Advanced ID System**: Unique, sortable, human-readable persona identifiers
5. **Enhanced Metadata**: Comprehensive schema for marketplace features
6. **Anonymous Support**: Automatic ID generation for anonymous contributors

### Phase 2A Transformation (Completed July 1, 2025):
1. **GitHub Marketplace**: Complete integration with DollhouseMCP-Personas repository
2. **User Identity System**: Environment-based user management and attribution
3. **Community Workflow**: GitHub issue-based submission and review process
4. **Local-First Architecture**: Full marketplace functionality without cloud dependency
5. **API Integration**: Robust GitHub API integration with error handling and user feedback

### Technical Debt Addressed:
- ✅ Clean separation from original MIT-licensed codebase
- ✅ Professional TypeScript architecture with comprehensive typing
- ✅ Marketplace-ready metadata schema and unique ID system
- ✅ Backwards compatibility maintained for existing users
- ✅ Foundation laid for multi-user, multi-device scenarios
- ✅ GitHub integration providing immediate marketplace value
- ✅ User attribution system ready for cloud expansion

## Current Capabilities Summary

### What Users Can Do NOW:
1. **Complete Persona Lifecycle Management**: Create, edit, validate, and manage personas via chat
2. **Local Persona Collection**: Full CRUD operations with real-time editing capabilities
3. **Marketplace Integration**: Browse, search, install, and submit personas to GitHub marketplace
4. **Chat-Based Creation**: Create new personas through guided conversational interface
5. **Real-Time Validation**: Comprehensive quality checks with detailed feedback reports
6. **User Attribution**: Environment-based identity system for proper crediting
7. **Community Collaboration**: Submit personas for review via automated GitHub workflow
8. **Cross-Platform Support**: Works on Windows, macOS, Linux with Node.js

### Technical Foundation Established:
1. **Scalable Architecture**: Ready for cloud features and user accounts
2. **Community Infrastructure**: GitHub-powered marketplace with full version control
3. **User Management**: Environment-based identity system ready for expansion
4. **Legal Framework**: AGPL licensing with platform stability commitments
5. **Business Model**: 80/20 revenue split framework ready for monetization

## Next Session Goals

**Immediate Priority (Phase 2C - Private Personas & Advanced Features)**:
1. **Local Private Persona Support**: User-specific directories (`personas/private-{username}/`)
2. **Enhanced Management Features**: Templates, bulk operations, advanced search/filtering
3. **Collaboration Tools**: Persona sharing, forking, versioning capabilities
4. **README Documentation Update**: Reflect all new Phase 2B capabilities

**Success Metrics**:
- Users can maintain private persona collections separate from public ones
- Template system accelerates persona creation workflows
- Bulk operations enable efficient persona management
- Documentation accurately reflects all current features and capabilities

**Long-term Vision**:
This represents a **transformative marketplace platform** that bridges the gap between individual AI productivity and community collaboration, while maintaining ethical business practices and user trust. The GitHub-powered foundation provides immediate value while building toward a comprehensive creator economy for AI personas.

## Development Environment Notes

**Current Working Directory**: `/Users/mick/Developer/MCP-Servers/DollhouseMCP/`  
**Git Status**: Clean, Phase 2B committed and pushed  
**Build Status**: All TypeScript compiling correctly (17 MCP tools)  
**Server Status**: Startup verified, all 17 MCP tools functional  
**Marketplace Status**: Fully operational with 5 initial personas across categories

**Current State (Phase 2B Complete)**:
1. ✅ Chat-based persona creation, editing, and validation tools implemented
2. ✅ GitHub marketplace repository populated with initial personas
3. ✅ Complete persona lifecycle management via conversational interface
4. ✅ Comprehensive validation system with quality feedback
5. ✅ User identity system with environment-based attribution

**Ready for Phase 2C**: Private persona support, templates, and advanced management features

This represents a **comprehensive persona management platform** with both local-first functionality and community marketplace integration, providing the foundation for the definitive AI persona ecosystem.