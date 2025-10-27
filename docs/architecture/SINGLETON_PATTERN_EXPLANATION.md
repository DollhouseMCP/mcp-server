# Understanding Singletons: From Pattern to Problem to Solution

**Audience**: Product Managers, Business Stakeholders, Technical Leaders
**Purpose**: Understand why singletons were used in DollhouseMCP, why they became a bottleneck, and what fixing them enables
**Reading Time**: 15 minutes

---

## Executive Summary

DollhouseMCP was built using the **singleton pattern** - a common software design where certain system components exist as single, shared instances. This made perfect sense for a single-user command-line tool but became a critical limitation when scaling to multi-user deployment.

**The Bottom Line:**
- **What singletons gave us**: Simple, fast development for single-user scenarios
- **What singletons cost us**: Inability to support multiple concurrent users without data corruption
- **What refactoring delivers**: True multi-user capability, enabling SaaS deployment and team features
- **Business impact**: Opens new revenue streams, market opportunities, and competitive positioning

---

## Section 1: What Are Singletons?

### The Simple Explanation

A **singleton** is a design pattern where only one instance of a particular object exists throughout your application's lifetime. No matter where in the code you access it, you're always talking to the same single instance.

### Real-World Analogy: The Town Square Clock

Imagine a town with one central clock in the square. Everyone in town looks at the same clock to know what time it is. There aren't multiple clocks - there's just THE clock.

**Benefits:**
- Everyone sees the same time (consistency)
- No confusion about which clock is "correct"
- Easy to find - everyone knows where it is
- Saves resources - no need to maintain multiple clocks

**Hidden Assumption:**
- This works great as long as you only have one town

When you need to serve multiple towns (multi-user scenarios), that single shared clock becomes a problem. Each town needs its own local time zone, schedules, and coordination.

### Code Example from DollhouseMCP

Let's look at how `PortfolioManager` uses the singleton pattern:

```typescript
export class PortfolioManager {
  private static instance: PortfolioManager;

  // Private constructor prevents creating new instances
  private constructor(config?: PortfolioConfig) {
    // Initialize the portfolio directory, element managers, etc.
    this.baseDir = path.join(homedir(), '.dollhouse', 'portfolio');
  }

  // Everyone gets the same instance
  public static getInstance(): PortfolioManager {
    if (!PortfolioManager.instance) {
      PortfolioManager.instance = new PortfolioManager();
    }
    return PortfolioManager.instance;
  }
}
```

**What this means in plain English:**
1. The first time someone asks for the PortfolioManager, it gets created
2. Every subsequent request returns that same first instance
3. It's impossible to create a second PortfolioManager
4. All parts of the application share the same portfolio state

---

## Section 2: Why Singletons Were Used in DollhouseMCP

### The Original Use Case: Single-User stdio Transport

DollhouseMCP initially communicated via **stdio** (standard input/output) - a simple pipe that connects one process to another. Think of it like a dedicated phone line between two people.

```
┌──────────────┐         stdio pipe         ┌──────────────┐
│              │◄──────────────────────────►│              │
│  Claude Code │    (one conversation)      │  DollhouseMCP│
│   (client)   │                            │   (server)   │
└──────────────┘                            └──────────────┘

                                            Single user state:
                                            • One active persona
                                            • One portfolio
                                            • One config
```

### Why Singletons Made Perfect Sense

In this environment, singletons were **the right choice**:

1. **Single User Guarantee**: Only one user could possibly be connected at a time
2. **Simple State Management**: One user = one state = one instance
3. **Performance**: No overhead of creating multiple instances
4. **Convenience**: Access managers from anywhere without passing dependencies
5. **Resource Efficiency**: Single file handles, single database connections

### The Embedded Assumptions

The singleton architecture baked in several critical assumptions:

| Assumption | Reality at Design Time | Reality for Multi-User |
|------------|----------------------|----------------------|
| "Only one user will ever be active" | ✅ True (stdio = 1:1) | ❌ False (SSE/WebSocket = 1:many) |
| "State can be shared globally" | ✅ Safe (single context) | ❌ Dangerous (state leakage) |
| "Configuration is system-wide" | ✅ Makes sense | ❌ Users need different configs |
| "Active persona is a singleton" | ✅ One user, one persona | ❌ Each user needs their own |

These weren't mistakes - they were **rational choices given the constraints at the time**.

---

## Section 3: The Problem with Singletons for Multi-User

### What Changes with Multi-User Architecture

Modern MCP deployment uses **Server-Sent Events (SSE)** or **WebSocket** transports, which allow multiple simultaneous connections:

```
┌──────────────┐                              ┌──────────────┐
│   User A     │───┐                          │              │
│ (Claude Code)│   │                          │              │
└──────────────┘   │    SSE/WebSocket         │              │
                   ├─────────────────────────►│  DollhouseMCP│
┌──────────────┐   │    (many connections)    │   (server)   │
│   User B     │───┤                          │              │
│ (Web Client) │   │                          │              │
└──────────────┘   │                          └──────────────┘
                   │
┌──────────────┐   │                          PROBLEM:
│   User C     │───┘                          Still has single
│  (API Key)   │                              shared instances!
└──────────────┘
```

### Concrete Example: State Collision

Let's walk through what happens with singleton managers when two users are active:

**Timeline of Disaster:**

```
T=0: Server starts
     - PortfolioManager singleton created
     - ConfigManager singleton created
     - activePersona = null

T=1: User A connects and activates "Creative Writer" persona
     - activePersona = "creative-writer"
     - State stored in singleton PortfolioManager

T=2: User B connects and activates "Code Reviewer" persona
     - activePersona = "code-reviewer"  ← OVERWRITES User A's setting!
     - State stored in SAME singleton PortfolioManager

T=3: User A asks for writing help
     - Receives response in "Code Reviewer" voice ❌
     - User A is confused - "I activated Creative Writer!"

T=4: User A deactivates persona
     - activePersona = null  ← AFFECTS User B too!
     - User B suddenly loses their Code Reviewer persona ❌

T=5: User C connects and loads portfolio
     - Triggers file system operations on shared PortfolioManager
     - May interrupt User A and User B's operations ❌
```

### Types of Failures

#### 1. State Leakage
**What it is**: One user's data bleeding into another user's session

**Business impact**:
- Privacy violations (User A sees User B's data)
- Compliance failures (GDPR, data isolation requirements)
- User trust erosion ("This app is showing me someone else's stuff")

**Real scenario**: User A submits a persona to their GitHub account, but the submission goes to User B's account because they logged in while the request was processing.

#### 2. Race Conditions
**What it is**: Operations from different users interfere with each other

**Business impact**:
- Unpredictable behavior ("It works sometimes, breaks others")
- Debugging nightmares (issues appear/disappear randomly)
- Support costs skyrocket (hard to reproduce issues)

**Real scenario**: User A and User B both try to reload the portfolio index simultaneously. The shared singleton tries to rebuild the same index twice, resulting in corrupted data structures or locked files.

#### 3. Data Corruption
**What it is**: Concurrent operations overwrite each other's work

**Business impact**:
- Lost work (user's changes disappear)
- Data integrity failures (invalid states)
- Recovery costs (support time, data restoration)

**Real scenario**: User A creates a new memory element while User B is editing an existing one. Both operations write to the shared portfolio state, and User B's changes get overwritten with User A's partially complete data.

#### 4. Configuration Conflicts
**What it is**: Users can't have different settings

**Business impact**:
- Feature limitations (can't offer per-user customization)
- Team friction (enterprise teams need different configs)
- Market restrictions (can't sell team/organization features)

**Real scenario**: User A (on free tier) and User B (on enterprise tier) should have different rate limits and feature access, but they share the same ConfigManager singleton, so both get the same settings.

### Why This Is a Show-Stopper for Growth

From a business perspective, singletons create a **hard ceiling** on product evolution:

| Business Goal | Blocked By Singletons |
|--------------|----------------------|
| SaaS Offering | ❌ Can't support multiple tenants safely |
| Team Features | ❌ Can't isolate team configurations |
| API Access | ❌ Can't handle concurrent API requests |
| Enterprise Sales | ❌ Can't meet isolation/security requirements |
| Scalability | ❌ Single bottleneck limits throughput |
| White-Label | ❌ Can't customize per-customer |

**In other words**: Singletons made DollhouseMCP fast to build but impossible to scale.

---

## Section 4: What Fixing Singletons Accomplishes

### The Refactored Approach: Dependency Injection

Instead of global singletons, we create **isolated instances per user context**:

**Before (Singleton):**
```typescript
// Anywhere in the code:
const portfolioManager = PortfolioManager.getInstance();
// Everyone gets the same instance ❌
```

**After (Dependency Injection):**
```typescript
// Each user connection creates its own context:
class UserContext {
  readonly portfolioManager: PortfolioManager;
  readonly configManager: ConfigManager;
  readonly activePersona: string | null;

  constructor(userId: string) {
    // NEW instance for THIS user
    this.portfolioManager = new PortfolioManager({ userId });
    this.configManager = new ConfigManager({ userId });
    this.activePersona = null;
  }
}

// When User A connects:
const userAContext = new UserContext('user-a');

// When User B connects:
const userBContext = new UserContext('user-b');

// Completely isolated! ✅
```

### Visual: Before and After Architecture

**Before (Singleton Architecture):**
```
User A ─┐
        ├──► Single PortfolioManager ◄── All users share state
User B ─┤         (global instance)       (state collisions!)
        │
User C ─┘    Single ConfigManager
             Single MemoryManager
             Single ActivePersona
```

**After (Per-User Instances):**
```
User A ──► UserContext A ──► PortfolioManager A
                         ──► ConfigManager A
                         ──► MemoryManager A
                         ──► ActivePersona A

User B ──► UserContext B ──► PortfolioManager B
                         ──► ConfigManager B
                         ──► MemoryManager B
                         ──► ActivePersona B

User C ──► UserContext C ──► PortfolioManager C
                         ──► ConfigManager C
                         ──► MemoryManager C
                         ──► ActivePersona C

Each user has their own isolated state! ✅
```

### What This Enables: Business Capabilities Unlocked

| Capability | How It Works | Business Value |
|-----------|-------------|----------------|
| **SaaS Deployment** | Multiple tenants on shared infrastructure | Recurring revenue model |
| **Team Workspaces** | Shared portfolios with individual contexts | Team/organization pricing tier |
| **API Access** | Handle concurrent API requests safely | Developer platform revenue |
| **Usage-Based Billing** | Track per-user metrics accurately | Flexible pricing strategies |
| **Enterprise Features** | Tenant-specific configs and security | Enterprise sales opportunities |
| **White-Label** | Customer-specific branding and settings | Partnership and reseller channels |
| **Audit & Compliance** | Per-user activity tracking | Meet enterprise security requirements |
| **Horizontal Scaling** | Multiple server instances | Support unlimited users |

### Performance and Reliability Improvements

**Before:**
- Single bottleneck for all operations
- Lock contention between users
- Failure cascades (one user's crash affects all)
- Unpredictable response times

**After:**
- Parallel processing per user
- No cross-user interference
- Failure isolation (one user's crash doesn't affect others)
- Predictable, consistent performance

### The Cost-Benefit Analysis

**Investment Required:**
- Refactor singleton managers to accept user context
- Update tool handlers to create/manage user contexts
- Add user identification and session management
- Test multi-user scenarios thoroughly

**Time to Implement**: 4-6 weeks of focused development

**Return on Investment**:
- **Immediate**: Enables SSE/WebSocket deployment
- **3 months**: SaaS beta with first paying customers
- **6 months**: Team features for 2-3x ARPU (Average Revenue Per User)
- **12 months**: Enterprise contracts with 10-100x ARPU

**Risk of NOT doing it**:
- Product stuck at single-user CLI forever
- Competition moves to multi-user while we can't
- Technical debt compounds (harder to fix later)
- Market opportunity window closes

---

## Section 5: The Refactor in Progress

### The Big Picture: index.ts Modularization

The main entry point (`src/index.ts`) is being refactored from **6,135 lines** down to ~**600 lines**. This isn't just about line count - it's about **separation of concerns**.

**What 6,000 lines tells us:**
- Everything is tangled together
- Hard to test individual components
- Difficult to understand what depends on what
- Changes in one area break unexpected things elsewhere

**What 600 lines enables:**
- Clear boundaries between components
- Easy to test in isolation
- Obvious dependency relationships
- Changes are localized and safe

### The Relationship Between Refactors

Removing singletons and modularizing index.ts are **two sides of the same coin**:

```
┌─────────────────────────────────────────────────────────────┐
│                    OLD ARCHITECTURE                         │
│                                                             │
│  ┌───────────────────────────────────────────────────┐    │
│  │  index.ts (6,135 lines)                          │    │
│  │                                                   │    │
│  │  • Direct calls to singleton.getInstance()      │    │
│  │  • Global state management                       │    │
│  │  • Mixed concerns (transport, tools, business)   │    │
│  │  • Hard-coded dependencies                       │    │
│  └───────────────────────────────────────────────────┘    │
│                          ↓                                  │
│         ┌─────────────────────────────────┐               │
│         │  Singleton Managers              │               │
│         │  (shared by all operations)      │               │
│         └─────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────┘
```

```
┌─────────────────────────────────────────────────────────────┐
│                    NEW ARCHITECTURE                         │
│                                                             │
│  ┌──────────────────────┐                                  │
│  │  index.ts (~600)     │  Thin orchestration layer        │
│  └──────────┬───────────┘                                  │
│             │                                               │
│             ├──► ConnectionHandler (SSE/WebSocket support) │
│             ├──► UserContextManager (per-user state)       │
│             ├──► ToolRegistry (modular tool system)        │
│             └──► ServerLifecycle (startup/shutdown)        │
│                                                             │
│  Per-User Context:                                         │
│  ┌──────────────────────────────────────────────────┐     │
│  │  UserContext (for User A)                        │     │
│  │    ├─ PortfolioManager (instance A)              │     │
│  │    ├─ ConfigManager (instance A)                 │     │
│  │    ├─ MemoryManager (instance A)                 │     │
│  │    └─ ActivePersona (User A's choice)            │     │
│  └──────────────────────────────────────────────────┘     │
│                                                             │
│  ┌──────────────────────────────────────────────────┐     │
│  │  UserContext (for User B)                        │     │
│  │    ├─ PortfolioManager (instance B)              │     │
│  │    ├─ ConfigManager (instance B)                 │     │
│  │    └─ ... (isolated from User A)                 │     │
│  └──────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
```

### What Each Refactor Enables

| Refactor | Technical Win | Business Win |
|----------|--------------|--------------|
| **Singleton Removal** | Per-user state isolation | Multi-user deployment |
| **Modularization** | Testable, maintainable code | Faster feature development |
| **Combined Effect** | Clean, scalable architecture | Competitive time-to-market |

### The Migration Path

The refactor is being done **incrementally** to minimize risk:

**Phase 1: Foundation (Current)**
- Modify managers to accept context/config instead of using singletons
- Create UserContextManager to coordinate per-user instances
- Add backwards compatibility layer (old code still works)

**Phase 2: Transport Layer**
- Update index.ts to detect connection type (stdio vs SSE/WebSocket)
- Route stdio connections through legacy path (singleton)
- Route SSE/WebSocket through new path (per-user context)

**Phase 3: Tool Migration**
- Update each tool handler to use UserContext
- Test with multi-user scenarios
- Gradually deprecate singleton code paths

**Phase 4: Cleanup**
- Remove singleton getInstance() methods
- Remove backwards compatibility layer
- Update documentation

**Phase 5: Optimization**
- Connection pooling
- Resource limits per user
- Advanced isolation features

---

## Glossary: Technical Terms Explained

**Singleton Pattern**: A design where only one instance of a class exists application-wide

**Dependency Injection**: Providing objects with their dependencies rather than having them create/fetch dependencies themselves

**State Leakage**: When one user's data or settings unintentionally affect another user

**Race Condition**: When the outcome depends on the timing/sequence of events (unpredictable)

**stdio Transport**: Communication via standard input/output (command-line pipes)

**SSE (Server-Sent Events)**: One-way communication from server to multiple clients (push notifications)

**WebSocket**: Two-way communication channel allowing real-time bidirectional data flow

**Refactoring**: Restructuring code without changing its external behavior

**Separation of Concerns**: Organizing code so each module handles one clear responsibility

**Modularization**: Breaking large files/systems into smaller, focused components

---

## Key Takeaways

### For Product Managers

1. **Singletons were the right choice for v1** (single-user CLI) but became a constraint for v2+ (multi-user deployment)
2. **The refactor isn't technical vanity** - it's the prerequisite for SaaS, teams, APIs, and enterprise features
3. **Timeline is 4-6 weeks** for core refactor, with immediate benefits for stability and future velocity
4. **ROI is clear**: Investment unlocks entire categories of revenue opportunities

### For Business Stakeholders

1. **Current state**: DollhouseMCP can only serve one user at a time safely
2. **Refactored state**: DollhouseMCP can serve unlimited users with complete isolation
3. **Market impact**: Moves us from "CLI tool" to "platform" category
4. **Competitive positioning**: Enables features competitors will need months to build

### For Technical Leaders

1. **This is foundational work** - all future multi-user features depend on it
2. **The refactor reduces complexity** - easier to onboard engineers, faster to ship features
3. **Testing becomes possible** - isolated components can be unit/integration tested properly
4. **Operational reliability improves** - failure isolation, better observability

---

## Questions and Answers

**Q: Can't we just limit it to one user and ship faster?**
A: Yes, short-term. But that permanently caps market opportunity at single-user CLI, missing SaaS revenue entirely.

**Q: How long until we can ship multi-user features?**
A: Core refactor: 4-6 weeks. First SaaS features: 2-4 weeks after that. Total: ~8-10 weeks to beta.

**Q: What's the risk if we don't do this?**
A: Product remains a niche CLI tool. Competition builds multi-user platforms while we're stuck. Market opportunity window closes.

**Q: Can we do this incrementally while shipping features?**
A: Yes. The refactor is designed to work alongside existing code. We can ship non-multi-user features during the transition.

**Q: What breaks during the migration?**
A: Nothing. We maintain backwards compatibility until everything is migrated, then flip the switch.

**Q: Is this like "paying technical debt"?**
A: Partially, but it's more "removing a design constraint." It's debt in the sense that we're correcting an assumption that no longer holds, but it's also investment in new capabilities.

---

## Conclusion

The singleton pattern served DollhouseMCP well in its initial single-user, CLI-focused incarnation. As the product evolves toward multi-user deployment, those same singletons become critical bottlenecks.

Refactoring away from singletons isn't about making the code "prettier" - it's about **removing the technical ceiling that prevents business growth**. The investment of 4-6 weeks unlocks SaaS deployment, team features, API access, and enterprise contracts - capabilities worth orders of magnitude more than the development cost.

Combined with the ongoing modularization of index.ts, this refactor transforms DollhouseMCP from a well-built single-user tool into a scalable, maintainable platform ready for the next phase of growth.

**The pattern that helped us build v1 must evolve to enable v2. That evolution is this refactor.**

---

*Document Version: 1.0*
*Last Updated: October 20, 2025*
*Author: Technical Bridge Builder persona*
*Audience: Product Managers, Business Stakeholders, Technical Leaders*
