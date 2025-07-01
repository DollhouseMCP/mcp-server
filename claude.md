# Claude Project Context: DollhouseMCP

## Project Overview

DollhouseMCP is a professional Model Context Protocol (MCP) server that enables dynamic AI persona management from markdown files. It allows Claude and other compatible AI assistants to activate and switch between different behavioral personas, with an integrated marketplace for sharing and monetizing personas.

**Repository**: https://github.com/mickdarling/DollhouseMCP  
**Website**: https://dollhousemcp.com  
**Author**: Mick Darling (mick@mickdarling.com)  
**License**: AGPL-3.0 with Platform Stability Commitments  

## Project Status: Phase 1 Complete ✅

### Completed (Phase 1 - Foundation):
✅ **Fresh Repository Setup** - Clean DollhouseMCP repository with AGPL-3.0 license  
✅ **Complete Rebranding** - All references updated from persona-mcp-server to DollhouseMCP  
✅ **Advanced Unique ID System** - Format: `what-it-is_YYYYMMDD-HHMMSS_who-made-it`  
✅ **Enhanced Metadata Schema** - Categories, pricing, AI generation flags, age ratings  
✅ **Anonymous User Support** - Auto-generated IDs like `anon-clever-fox-x7k2`  
✅ **Backwards Compatibility** - Existing personas automatically get unique IDs  

### Next Steps (Phase 2 - User Experience):
🔄 **Chat-Based Marketplace Tools** - browse_marketplace, search_personas, install_persona  
🔄 **User Account System** - Login, private personas, cloud sync  
🔄 **Persona Creation Tools** - create_persona, edit_persona, publish_persona  

### Future (Phase 3 - Business Platform):
📋 **DollhouseMCP.com Website** - Classic web interface with user accounts  
📋 **Payment Processing** - Premium persona monetization (80/20 creator/platform split)  
📋 **Community Features** - Reviews, ratings, categories, moderation  

## Current Project Structure

```
DollhouseMCP/
├── src/
│   └── index.ts              # Main MCP server implementation (DollhouseMCPServer)
├── dist/                     # Compiled JavaScript (auto-generated)
├── personas/                 # Persona definition files with enhanced metadata
│   ├── creative-writer.md    # Updated with unique ID system
│   ├── technical-analyst.md
│   ├── eli5-explainer.md
│   ├── business-consultant.md
│   └── debug-detective.md
├── package.json              # Project config (dollhousemcp, AGPL-3.0, dollhousemcp.com)
├── tsconfig.json             # TypeScript configuration
├── LICENSE                   # AGPL-3.0 with custom platform stability terms
├── README.md                 # Comprehensive documentation (needs updating)
└── claude.md                 # This context file
```

## Technical Architecture

### Core Server Implementation (`src/index.ts`)
- **Framework**: TypeScript with MCP SDK
- **Transport**: StdioServerTransport for Claude Desktop integration
- **Class**: `DollhouseMCPServer` (renamed from PersonaMCPServer)
- **File Management**: Uses `gray-matter` for YAML frontmatter parsing
- **Persona Loading**: Dynamic loading with unique ID generation
- **Error Handling**: Comprehensive error handling with McpError types

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
- `debug-detective_20250701-154234_Persona MCP Server`
- `custom-persona_20250701-160000_anon-clever-fox-x7k2`

**Benefits**:
- Alphabetical sorting shows type first, then chronological
- Most recent personas appear at top of each category
- Unique across all users and time periods
- Human-readable yet systematically organized

### Anonymous User ID Generation
```typescript
const ADJECTIVES = ['clever', 'swift', 'bright', 'bold', 'wise', 'calm', 'keen', 'witty', 'sharp', 'cool'];
const ANIMALS = ['fox', 'owl', 'cat', 'wolf', 'bear', 'hawk', 'deer', 'lion', 'eagle', 'tiger'];

// Generates: anon-clever-fox-x7k2
function generateAnonymousId(): string
```

### Current MCP Tools
1. **`list_personas`** - Display all personas with enhanced metadata and visual indicators
2. **`activate_persona`** - Activate by name, filename, or unique ID
3. **`get_active_persona`** - Get current persona info
4. **`deactivate_persona`** - Return to default mode
5. **`get_persona_details`** - View complete persona details
6. **`reload_personas`** - Refresh from filesystem

### Enhanced List Display Format
```
🔹 Creative Writer (creative-writer_20250701-150000_dollhousemcp)
   An imaginative storyteller focused on engaging narratives
   📁 creative | 🎭 dollhousemcp | 🔖 free | 👤 Human
   Age: all | Version: 1.0
   Triggers: creative, story, narrative, imagination, writing
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

### User Tiers (Planned)
1. **Anonymous**: Local use, community uploads (public domain)
2. **Registered**: Private cloud storage, free public personas
3. **Creator**: Monetization rights, 80/20 split, analytics

### Content Categories ("Rooms")
- 🏢 Professional (Excel, coding, business)
- 🎭 Creative (writing, art, storytelling)
- 🎲 Gaming (RPG, character creation)
- 🔬 Educational (tutoring, explanations)
- 🏠 Personal (productivity, lifestyle)
- 🔞 Adult (18+ content, clearly marked)
- 👨‍👩‍👧‍👦 Family-Friendly (child-appropriate)

## Installation & Setup

### Current Setup (Phase 1)
```bash
git clone https://github.com/mickdarling/DollhouseMCP.git
cd DollhouseMCP
npm install
npm run build
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
- ✅ **Backwards Compatibility**: Existing personas get auto-generated IDs
- 🔄 **Integration Testing**: Needs testing with Claude Desktop

## Implementation Roadmap

### Phase 2: User Experience (Next)
1. **Enhanced MCP Tools**:
   - `browse_marketplace` - Browse by category/room
   - `search_personas` - Find by keywords/author
   - `install_persona` - Download from marketplace
   - `update_persona` - Update to latest version
   - `check_updates` - See available updates

2. **Persona Management**:
   - `create_persona` - Guided creation through chat
   - `edit_persona` - Modify existing personas
   - `publish_persona` - Submit to marketplace
   - `backup_personas` - Export collection
   - `restore_personas` - Import collection

3. **User System Foundation**:
   - Basic user identification
   - Private persona storage
   - Cross-device sync

### Phase 3: Business Platform (Future)
1. **Website Development** (dollhousemcp.com):
   - User registration and authentication
   - Web-based persona browser and creator
   - Payment processing integration
   - Community features (reviews, ratings)

2. **Marketplace Backend**:
   - RESTful API for persona CRUD operations
   - Payment processing (Stripe integration)
   - Revenue sharing automation
   - Content moderation tools

3. **Advanced Features**:
   - Mobile app development
   - Advanced analytics
   - Enterprise features
   - API partnerships

## Security & Compliance

### Current Implementation
- **No Hardcoded Secrets**: All sensitive config via environment variables
- **Input Validation**: Persona identifiers validated before use
- **Error Isolation**: Persona failures don't affect server stability
- **AGPL Compliance**: Source disclosure requirements for network use

### Planned Security Features
- User authentication and authorization
- Content validation and moderation
- Payment processing security (PCI compliance)
- GDPR compliance for EU users
- Regular security audits

## Project History & Transformation

This project evolved from a working prototype (`persona-mcp-server`) to a production-ready platform:

### Phase 1 Transformation (Completed July 1, 2025):
1. **Repository Migration**: Fresh start with clean git history
2. **Complete Rebranding**: All references updated to DollhouseMCP
3. **License Upgrade**: MIT → AGPL-3.0 with platform stability commitments
4. **Advanced ID System**: Unique, sortable, human-readable persona identifiers
5. **Enhanced Metadata**: Comprehensive schema for marketplace features
6. **Anonymous Support**: Automatic ID generation for anonymous contributors

### Technical Debt Addressed:
- ✅ Clean separation from original MIT-licensed codebase
- ✅ Professional TypeScript architecture with proper typing
- ✅ Comprehensive metadata schema ready for marketplace
- ✅ Backwards compatibility maintained for existing users
- ✅ Foundation laid for multi-user, multi-device scenarios

## Next Session Goals

**Immediate Priority (Phase 2 Start)**:
1. Implement chat-based marketplace tools (browse, search, install)
2. Add persona creation/editing interfaces through MCP
3. Begin user system foundation (login, private storage)
4. Update README.md and other documentation files

**Success Metrics**:
- Users can browse personas by category through chat
- Users can create new personas without touching files
- Private persona storage works across devices
- Documentation reflects all current capabilities

This represents a solid foundation for building the definitive persona marketplace platform while maintaining ethical business practices and user trust.