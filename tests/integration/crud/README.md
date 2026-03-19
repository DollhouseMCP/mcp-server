# CRUD+Activate Test Suite

**Comprehensive integration testing for all DollhouseMCP element types**

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Configuration System](#configuration-system)
- [Adding New Element Types](#adding-new-element-types)
- [Extending Tests](#extending-tests)
- [Capability System](#capability-system)
- [Test Helpers](#test-helpers)
- [Migration Path](#migration-path)
- [Troubleshooting](#troubleshooting)
- [Current Status](#current-status)
- [Contributing](#contributing)
- [References](#references)

---

## Overview

### What This Test Suite Does

This test suite provides **comprehensive, parameterized integration testing** for all 6 DollhouseMCP element types:

- 📝 **Personas** - Behavioral AI profiles
- 🛠️ **Skills** - Discrete capability modules
- 📋 **Templates** - Reusable content structures
- 🤖 **Agents** - Autonomous goal-oriented actors
- 💾 **Memories** - Persistent context storage
- 🎭 **Ensembles** - Multi-element orchestration

### Why Capability-Based Architecture?

**Traditional Approach (Type-Specific):**
```typescript
// ❌ Bad: Hardcoded type checks
if (elementType === 'personas') {
  testActivation();
} else if (elementType === 'ensembles') {
  testNesting();
  testActivation();
}
// Must update code for each new type
```

**Capability-Based Approach:**
```typescript
// ✅ Good: Configuration-driven
if (config.capabilities.supportsActivation) {
  testActivation(config.activationConfig);
}
if (config.capabilities.supportsNesting) {
  testNesting(config.nestingConfig);
}
// Add new type = add config, tests run automatically
```

### How It Validates All Element Types

**Single parameterized test suite** runs identical test scenarios across all element types:

1. **Registry-Driven**: Iterates over `ELEMENT_TYPE_REGISTRY`
2. **Configuration-Based**: Each type has a config file defining its capabilities
3. **Generic Helpers**: Shared assertions work for any element type
4. **Capability Detection**: Tests conditionally execute based on element capabilities

**Result**: ~277 tests validating all operations for all types with zero code duplication.

### Key Statistics

| Metric | Value |
|--------|-------|
| **Total Tests** | 277 |
| **Element Types Covered** | 6 |
| **Test Files** | 15 |
| **Lines of Code** | 5,522 |
| **Test Categories** | CREATE, READ, UPDATE, DELETE, VALIDATE, ACTIVATE |
| **Capability Types** | 4 (Activation, Nesting, State Files, References) |
| **Current Pass Rate** | 80.5% (223/277) |
| **Execution Time** | ~15-20 seconds |

---

## Architecture

### Capability-Based Testing Concept

**Core Principle**: Tests are selected and executed based on **element capabilities**, not hardcoded type checks.

```typescript
// Configuration defines what the element CAN do
interface ElementCapabilities {
  supportsActivation?: ActivationConfig;   // Can it be executed?
  supportsNesting?: NestingConfig;         // Can it contain other elements?
  hasStateFile?: StateConfig;              // Does it have separate state?
  supportsReferences?: ReferenceConfig;    // Can it reference others?
}

// Test suite uses capabilities to decide what to test
if (config.capabilities.supportsActivation) {
  describe('ACTIVATE', () => {
    // Run activation tests
  });
}
```

### Directory Structure

```
tests/integration/crud/
├── README.md                          ← You are here
├── ARCHITECTURE.md                    ← Deep dive into design decisions
├── EXAMPLES.md                        ← Complete walkthroughs
│
├── ElementCRUD.test.ts               ← Main parameterized test suite (1,017 lines)
│
├── config/                           ← Element type configurations
│   ├── types.ts                      ← TypeScript interfaces (386 lines)
│   ├── elementTypeRegistry.ts        ← Central registry (115 lines)
│   ├── personaConfig.ts              ← Persona configuration (247 lines)
│   ├── skillConfig.ts                ← Skill configuration (323 lines)
│   ├── templateConfig.ts             ← Template configuration (364 lines)
│   ├── agentConfig.ts                ← Agent configuration (299 lines)
│   ├── memoryConfig.ts               ← Memory configuration (355 lines)
│   └── ensembleConfig.ts             ← Ensemble configuration (416 lines)
│
├── helpers/                          ← Shared test utilities
│   ├── crudTestHelpers.ts            ← Generic assertions (349 lines)
│   ├── elementFactories.ts           ← Test data generators (328 lines)
│   ├── serverSetup.ts                ← Server lifecycle management (307 lines)
│   ├── capabilityDetector.ts         ← Capability detection (320 lines)
│   └── activationHelpers.ts          ← Activation testing (332 lines)
│
└── fixtures/                         ← Test data
    └── testData.ts                   ← Shared test scenarios (364 lines)
```

### How Components Work Together

```
┌─────────────────────────────────────────────────────────────┐
│                  ElementCRUD.test.ts                        │
│                  (Main Test Suite)                          │
└─────────────────────────────────────────────────────────────┘
                            ↓
                   describe.each(ELEMENT_TYPE_REGISTRY)
                            ↓
┌─────────────────────────────────────────────────────────────┐
│                 For Each Element Type                       │
├─────────────────────────────────────────────────────────────┤
│  1. Load config from registry                               │
│  2. Use factory to generate test data                       │
│  3. Run universal CRUD tests (CREATE, READ, UPDATE, DELETE) │
│  4. Check capabilities:                                     │
│     • If supportsActivation → run ACTIVATE tests            │
│     • If supportsNesting → run NESTING tests                │
│     • If hasStateFile → run STATE tests                     │
│     • If supportsReferences → run REFERENCE tests           │
└─────────────────────────────────────────────────────────────┘
                            ↓
              Uses helpers for assertions
                            ↓
┌───────────────┬──────────────┬─────────────┬───────────────┐
│ crudTestHelpers│elementFactories│serverSetup│activationHelpers│
│ • assertCreated│ • createMinimal│ • setup()  │ • executeActivate│
│ • assertUpdated│ • createComplete│• dispose()│ • verifyActive  │
│ • assertDeleted│ • createInvalid│ • callTool│ • testFailure   │
└───────────────┴──────────────┴─────────────┴───────────────┘
```

### Configuration → Test Flow Diagram

```
┌─────────────────────────────────────────┐
│  personaConfig.ts                       │
├─────────────────────────────────────────┤
│  type: PERSONA                          │
│  displayName: "Personas"                │
│  factory: createPersonaTestData()       │
│  capabilities: {                        │
│    supportsActivation: {                │
│      activationStrategy: "behavior"     │
│      requiresContext: false             │
│    }                                    │
│  }                                      │
│  validExamples: [...]                   │
│  invalidExamples: [...]                 │
│  validators: [...]                      │
└─────────────────────────────────────────┘
                ↓
        Added to Registry
                ↓
┌─────────────────────────────────────────┐
│  elementTypeRegistry.ts                 │
├─────────────────────────────────────────┤
│  export const ELEMENT_TYPE_REGISTRY = [ │
│    PERSONA_CONFIG,                      │
│    SKILL_CONFIG,                        │
│    ...                                  │
│  ]                                      │
└─────────────────────────────────────────┘
                ↓
        Used by Test Suite
                ↓
┌─────────────────────────────────────────┐
│  ElementCRUD.test.ts                    │
├─────────────────────────────────────────┤
│  describe.each(ELEMENT_TYPE_REGISTRY)(  │
│    'CRUD: $displayName',                │
│    (config) => {                        │
│      // Universal tests                 │
│      describe('CREATE', ...)            │
│      describe('READ', ...)              │
│                                         │
│      // Capability-based tests          │
│      if (config.capabilities            │
│          .supportsActivation) {         │
│        describe('ACTIVATE', ...)        │
│      }                                  │
│    }                                    │
│  )                                      │
└─────────────────────────────────────────┘
                ↓
          Test Execution
                ↓
┌─────────────────────────────────────────┐
│  Test Results                           │
├─────────────────────────────────────────┤
│  ✅ CREATE: Personas - minimal          │
│  ✅ CREATE: Personas - complete         │
│  ✅ READ: Personas - by name            │
│  ✅ UPDATE: Personas - description      │
│  ✅ DELETE: Personas - success          │
│  ✅ ACTIVATE: Personas - basic          │
│  ... 40 more persona tests             │
│  ... 231 more tests for other types    │
└─────────────────────────────────────────┘
```

---

## Quick Start

### Running the Entire Suite

```bash
# Run all CRUD+Activate tests (not yet in main test suite)
npm test -- tests/integration/crud/ElementCRUD.test.ts

# Run with coverage
npm test -- tests/integration/crud/ElementCRUD.test.ts --coverage

# Run in watch mode for development
npm test -- tests/integration/crud/ElementCRUD.test.ts --watch
```

### Running Specific Element Types

Use Jest's test name pattern matching:

```bash
# Test only Personas
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "Personas"

# Test only Ensembles
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "Ensembles"

# Test only Skills
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "Skills"
```

### Running Specific Operations

```bash
# Test only CREATE operations across all types
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "CREATE"

# Test only ACTIVATE operations
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "ACTIVATE"

# Test only UPDATE operations for Personas
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "Personas.*UPDATE"
```

### Debugging Failed Tests

```bash
# Run with verbose output
npm test -- tests/integration/crud/ElementCRUD.test.ts --verbose

# Run only failed tests from last run
npm test -- tests/integration/crud/ElementCRUD.test.ts --onlyFailures

# Run specific test by full name
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "CREATE: Personas - should create minimal element"
```

### Understanding Test Output

```
PASS  tests/integration/crud/ElementCRUD.test.ts (15.3s)
  CRUD+Activate Operations: Personas
    CREATE Operations
      ✓ should create minimal element (245ms)
      ✓ should create complete element (198ms)
      ✓ should reject invalid element (156ms)
    UPDATE Operations
      ✓ should update description field (223ms)
      ✓ should update nested metadata field (201ms)
    ACTIVATE Operations
      ✓ should activate persona successfully (189ms)
      ✓ should handle activation context (167ms)

Test Suites: 1 passed, 1 total
Tests:       223 passed, 54 failed, 277 total
Snapshots:   0 total
Time:        15.342s
```

**Reading Results:**
- ✅ **Green checkmark**: Test passed
- ❌ **Red X**: Test failed (see error details below)
- ⏱️ **Time in parentheses**: Individual test execution time
- 📊 **Summary**: Overall pass/fail counts

---

## Configuration System

### ElementTypeTestConfig Interface

The core configuration interface that defines everything needed to test an element type:

```typescript
interface ElementTypeTestConfig {
  // ============================================================================
  // Identity: What is this element type?
  // ============================================================================
  type: ElementType;              // Enum value (e.g., ElementType.PERSONA)
  displayName: string;            // Human-readable name (e.g., "Personas")

  // ============================================================================
  // Test Data Generation: How to create test instances?
  // ============================================================================
  factory: ElementFactory;        // Function to generate test data
  validExamples: ElementData[];   // Valid test cases
  invalidExamples: Array<{        // Invalid test cases
    data: ElementData;
    expectedError: string;
  }>;

  // ============================================================================
  // Field Specifications: What fields exist and how to test them?
  // ============================================================================
  requiredFields: string[];       // Fields that must be present
  editableFields: FieldConfig[];  // Fields that can be updated
  nestedFields?: Record<string, FieldConfig>;  // Complex nested structures

  // ============================================================================
  // Capabilities: What can this element type DO?
  // ============================================================================
  capabilities: {
    supportsActivation?: ActivationConfig;   // Can be executed/activated?
    supportsNesting?: NestingConfig;         // Can contain other elements?
    hasStateFile?: StateConfig;              // Has separate state file?
    supportsReferences?: ReferenceConfig;    // Can reference other elements?
  };

  // ============================================================================
  // Validation Rules: How to validate correctness?
  // ============================================================================
  validators: ValidationRule[];   // Type-specific validation logic
}
```

### How to Read a Config File

Let's examine `personaConfig.ts` as an example:

```typescript
// 1. IDENTITY - Who is this config for?
export const PERSONA_CONFIG: ElementTypeTestConfig = {
  type: ElementType.PERSONA,
  displayName: 'Personas',

  // 2. FACTORY - How to generate test data
  factory: createPersonaTestData,  // Function that creates valid persona data

  // 3. VALID EXAMPLES - Sample valid personas
  validExamples: [
    {
      name: 'Minimal Persona',
      description: 'A minimal valid persona',
      content: 'You are helpful.',
      metadata: {}
    },
    {
      name: 'Complete Persona',
      description: 'A persona with all optional fields',
      content: 'You are a creative writer...',
      metadata: {
        triggers: ['write', 'create'],
        version: '2.1.0',
        category: 'creative'
      }
    }
  ],

  // 4. INVALID EXAMPLES - What should fail validation
  invalidExamples: [
    {
      data: {
        name: 'Test',
        description: 'Test',
        content: ''  // ❌ Empty content is invalid
      },
      expectedError: 'instruction'  // Error message should contain "instruction"
    }
  ],

  // 5. REQUIRED FIELDS - What must be present
  requiredFields: ['name', 'description', 'content'],

  // 6. EDITABLE FIELDS - What can be updated and how to test
  editableFields: [
    {
      path: 'description',
      displayName: 'Description',
      type: 'string',
      required: true,
      validValues: ['Updated description', 'Different description'],
      invalidValues: [
        { value: '', expectedError: 'required|empty' }
      ]
    },
    {
      path: 'metadata.triggers',
      displayName: 'Triggers',
      type: 'array',
      required: false,
      validValues: [['new', 'triggers'], ['single']]
    }
  ],

  // 7. CAPABILITIES - What can this element type do?
  capabilities: {
    supportsActivation: {
      activationStrategy: 'behavior-change',  // How it activates
      requiresContext: false,                 // Needs context data?
      expectedResultType: 'state-change',     // What happens when activated
      testContexts: [
        {
          description: 'Basic activation',
          context: undefined,
          expectedOutcome: 'Persona becomes active'
        }
      ]
    }
    // No nesting, state files, or references for personas
  },

  // 8. VALIDATORS - Type-specific validation logic
  validators: [
    {
      name: 'content-required',
      description: 'Content/instructions must be present',
      validate: (data) => ({
        valid: Boolean(data.content && data.content.trim()),
        message: 'Persona instructions (content) are required'
      }),
      severity: 'error'
    }
  ]
};
```

### What Each Capability Flag Does

#### 1. `supportsActivation`

**Meaning**: This element type can be "executed" or "activated" - it performs an action when invoked.

**Configuration Options**:
```typescript
supportsActivation: {
  activationStrategy: 'behavior-change' | 'execution' | 'rendering' | 'orchestration' | 'context-loading',
  requiresContext: boolean,              // Does activation need context data?
  expectedResultType: 'state-change' | 'output' | 'side-effect' | 'multi-element',
  testContexts: ActivationContext[]      // Sample contexts to test with
}
```

**Test Examples**:
```typescript
// When present, these tests run:
✅ should activate element successfully
✅ should handle activation with context
✅ should support activation strategies
✅ should handle activation failures
✅ should verify element becomes active
✅ should support multiple test contexts
```

**Element Types**:
- ✅ Personas (activates to change AI behavior)
- ✅ Skills (activates to enable capability)
- ✅ Templates (activates to render output)
- ✅ Agents (activates to execute goals)
- ✅ Ensembles (activates multiple elements)
- ❌ Memories (passive storage, not activated)

#### 2. `supportsNesting`

**Meaning**: This element type can contain other elements within it.

**Configuration Options**:
```typescript
supportsNesting: {
  maxDepth: number,                      // Maximum nesting levels
  allowedTypes: ElementType[],           // Which types can be nested
  detectCircular: boolean,               // Check for circular dependencies?
  nestingField: string                   // Field path where nested elements stored
}
```

**Test Examples**:
```typescript
// When present, these tests run:
✅ should nest elements up to max depth
✅ should reject nesting beyond max depth
✅ should detect circular dependencies
✅ should only allow configured types
✅ should activate nested elements
✅ should handle nested element failures
```

**Element Types**:
- ✅ Ensembles (can contain any element type)
- ❌ All other types (don't support nesting)

#### 3. `hasStateFile`

**Meaning**: This element type maintains a separate state file (beyond the main YAML definition).

**Configuration Options**:
```typescript
hasStateFile: {
  fileExtension: string,                 // e.g., ".state.yaml"
  stateSchema?: Record<string, any>,     // Schema for state validation
  cleanupOnDelete: boolean               // Delete state file when element deleted?
}
```

**Test Examples**:
```typescript
// When present, these tests run:
✅ should create state file on first activation
✅ should persist state across activations
✅ should load state on element load
✅ should handle state file corruption
✅ should cleanup state on deletion
✅ should validate state schema
```

**Element Types**:
- ✅ Agents (maintain execution state)
- ✅ Memories (maintain entry state)
- ❌ Personas, Skills, Templates, Ensembles (state in main file)

#### 4. `supportsReferences`

**Meaning**: This element type can reference other elements (dependencies, relationships).

**Configuration Options**:
```typescript
supportsReferences: {
  referenceTypes: ReferenceType[],       // Types of references supported
  bidirectional: boolean,                // Are references two-way?
  referenceField: string                 // Field path where references stored
}

enum ReferenceType {
  INTERNAL = 'internal',    // Reference to another element
  EXTERNAL = 'external',    // External resource
  DEPENDENCY = 'dependency' // Required dependency
}
```

**Test Examples**:
```typescript
// When present, these tests run:
✅ should resolve element references
✅ should detect missing references
✅ should handle circular references
✅ should support bidirectional references
✅ should validate reference types
```

**Element Types**:
- ✅ Ensembles (reference nested elements)
- ✅ Templates (reference included templates)
- ⚠️ Skills, Agents (potential future feature)
- ❌ Personas, Memories (no references currently)

### Example Walkthrough: Ensemble Config

Let's walk through the ensemble configuration to see all capabilities in action:

```typescript
export const ENSEMBLE_CONFIG: ElementTypeTestConfig = {
  // IDENTITY
  type: ElementType.ENSEMBLE,
  displayName: 'Ensembles',

  // FACTORY
  factory: createEnsembleTestData,

  // VALID EXAMPLE
  validExamples: [
    {
      name: 'Complete Ensemble',
      description: 'An ensemble with all features',
      metadata: {
        activationStrategy: 'parallel',
        conflictResolution: 'merge',
        contextSharing: true,
        allowNested: true,
        maxNestingDepth: 5,
        elements: [
          {
            name: 'helper-persona',
            type: ElementType.PERSONA,
            role: 'primary',
            order: 1
          }
        ]
      }
    }
  ],

  // REQUIRED FIELDS
  requiredFields: ['name', 'description'],

  // EDITABLE FIELDS
  editableFields: [
    {
      path: 'metadata.activationStrategy',
      displayName: 'Activation Strategy',
      type: 'enum',
      required: false,
      validValues: ['sequential', 'parallel', 'conditional'],
      invalidValues: [
        { value: 'invalid', expectedError: 'strategy|invalid' }
      ]
    }
  ],

  // CAPABILITIES - Ensembles have both activation AND nesting!
  capabilities: {
    supportsActivation: {
      activationStrategy: 'orchestration',
      requiresContext: false,
      expectedResultType: 'multi-element',
      testContexts: [
        {
          description: 'Sequential activation',
          context: { strategy: 'sequential' },
          expectedOutcome: 'Elements activate in order'
        },
        {
          description: 'Parallel activation',
          context: { strategy: 'parallel' },
          expectedOutcome: 'All elements activate simultaneously'
        }
      ]
    },
    supportsNesting: {
      maxDepth: 10,
      allowedTypes: [
        ElementType.PERSONA,
        ElementType.SKILL,
        ElementType.TEMPLATE,
        ElementType.AGENT,
        ElementType.MEMORY,
        ElementType.ENSEMBLE  // Can nest ensembles!
      ],
      detectCircular: true,
      nestingField: 'metadata.elements'
    }
  },

  // VALIDATORS
  validators: [
    {
      name: 'activation-strategy-valid',
      validate: (data) => {
        const validStrategies = ['sequential', 'parallel', 'conditional'];
        return {
          valid: validStrategies.includes(data.metadata?.activationStrategy),
          message: `Must be one of: ${validStrategies.join(', ')}`
        };
      },
      severity: 'error'
    }
  ]
};
```

**Tests Generated for Ensembles**:
- ✅ 40+ universal CRUD tests (same as all types)
- ✅ 10+ activation tests (due to `supportsActivation`)
- ✅ 15+ nesting tests (due to `supportsNesting`)
- **Total**: ~65 tests for ensembles alone

---

## Adding New Element Types

### Step-by-Step Guide

#### Step 1: Create Config File

Create `tests/integration/crud/config/myTypeConfig.ts`:

```typescript
import { ElementType } from '../../../../src/portfolio/types.js';
import { ElementTypeTestConfig, ElementData } from './types.js';

// Factory function
function createMyTypeTestData(overrides?: Partial<ElementData>): ElementData {
  const base: ElementData = {
    name: overrides?.name || 'Test MyType',
    description: overrides?.description || 'A test element',
    metadata: {
      // Your type-specific metadata
      someField: 'default-value',
      ...(overrides?.metadata || {})
    }
  };
  return { ...base, ...overrides };
}

export const MY_TYPE_CONFIG: ElementTypeTestConfig = {
  // Continue below...
};
```

#### Step 2: Define Capabilities

Determine what your element type can do:

```typescript
export const MY_TYPE_CONFIG: ElementTypeTestConfig = {
  type: ElementType.MY_TYPE,
  displayName: 'MyTypes',
  factory: createMyTypeTestData,

  // Define capabilities
  capabilities: {
    // Can this type be activated?
    supportsActivation: {
      activationStrategy: 'execution',  // How it activates
      requiresContext: true,            // Needs context data
      expectedResultType: 'output',     // Produces output
      testContexts: [
        {
          description: 'Basic activation',
          context: { mode: 'default' },
          expectedOutcome: 'Element executes successfully'
        }
      ]
    },

    // Can this type nest other elements? (probably not)
    // supportsNesting: undefined,

    // Does it have a state file?
    hasStateFile: {
      fileExtension: '.state.yaml',
      cleanupOnDelete: true
    },

    // Can it reference other elements?
    // supportsReferences: undefined
  }
};
```

#### Step 3: Add Valid/Invalid Examples

```typescript
export const MY_TYPE_CONFIG: ElementTypeTestConfig = {
  // ... previous fields ...

  validExamples: [
    {
      name: 'Minimal MyType',
      description: 'Minimal valid example',
      metadata: {
        someField: 'value'
      }
    },
    {
      name: 'Complete MyType',
      description: 'Fully populated example',
      metadata: {
        someField: 'value',
        optionalField: 'optional-value',
        complexField: {
          nested: 'data'
        }
      }
    }
  ],

  invalidExamples: [
    {
      data: {
        name: 'Invalid',
        description: 'Missing required field',
        metadata: {}  // Missing someField
      },
      expectedError: 'someField is required'
    }
  ]
};
```

#### Step 4: Define Validators

```typescript
export const MY_TYPE_CONFIG: ElementTypeTestConfig = {
  // ... previous fields ...

  validators: [
    {
      name: 'name-required',
      description: 'Name must be present',
      validate: (data) => ({
        valid: Boolean(data.name && data.name.trim()),
        message: 'Name is required'
      }),
      severity: 'error'
    },
    {
      name: 'someField-required',
      description: 'someField must be present in metadata',
      validate: (data) => ({
        valid: Boolean(data.metadata?.someField),
        message: 'metadata.someField is required'
      }),
      severity: 'error'
    },
    {
      name: 'complexField-structure',
      description: 'complexField must have valid structure',
      validate: (data) => {
        if (!data.metadata?.complexField) return { valid: true };
        return {
          valid: typeof data.metadata.complexField === 'object',
          message: 'complexField must be an object'
        };
      },
      severity: 'warning'
    }
  ]
};
```

#### Step 5: Specify Fields

```typescript
export const MY_TYPE_CONFIG: ElementTypeTestConfig = {
  // ... previous fields ...

  requiredFields: ['name', 'description', 'metadata.someField'],

  editableFields: [
    {
      path: 'description',
      displayName: 'Description',
      type: 'string',
      required: true,
      validValues: ['Updated description'],
      invalidValues: [
        { value: '', expectedError: 'required' }
      ]
    },
    {
      path: 'metadata.someField',
      displayName: 'Some Field',
      type: 'string',
      required: true,
      validValues: ['new-value', 'another-value']
    },
    {
      path: 'metadata.optionalField',
      displayName: 'Optional Field',
      type: 'string',
      required: false,
      validValues: ['optional-1', 'optional-2']
    }
  ],

  nestedFields: {
    'metadata.complexField': {
      path: 'metadata.complexField',
      displayName: 'Complex Field',
      type: 'object',
      required: false,
      validValues: [
        { nested: 'value1' },
        { nested: 'value2', extra: 'data' }
      ]
    }
  }
};
```

#### Step 6: Update Registry

Edit `tests/integration/crud/config/elementTypeRegistry.ts`:

```typescript
import { MY_TYPE_CONFIG } from './myTypeConfig.js';

export const ELEMENT_TYPE_REGISTRY: ElementTypeTestConfig[] = [
  PERSONA_CONFIG,
  SKILL_CONFIG,
  TEMPLATE_CONFIG,
  AGENT_CONFIG,
  MEMORY_CONFIG,
  ENSEMBLE_CONFIG,
  MY_TYPE_CONFIG  // ← Add your config here
];
```

#### Step 7: Run Tests

```bash
# Run tests for your new type
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "MyTypes"

# Expected output:
# CRUD+Activate Operations: MyTypes
#   CREATE Operations
#     ✓ should create minimal element
#     ✓ should create complete element
#     ✓ should reject invalid element
#   UPDATE Operations
#     ✓ should update description field
#     ✓ should update someField
#   DELETE Operations
#     ✓ should delete element successfully
#   VALIDATE Operations
#     ✓ should validate correct element
#     ✓ should detect missing required fields
#   ACTIVATE Operations (if supportsActivation defined)
#     ✓ should activate element successfully
#     ✓ should handle activation context
#   STATE Operations (if hasStateFile defined)
#     ✓ should create state file
#     ✓ should persist state
```

#### Step 8: Verify Coverage

```bash
# Run with coverage to see what's tested
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "MyTypes" --coverage

# Check coverage report
# Should show high coverage for:
# - MyType element class
# - MyType manager class
# - MCP tool handlers for MyType
```

### Template Config File

Copy this template to get started quickly:

```typescript
/**
 * [YourType] element type test configuration
 *
 * Brief description of what this element type does.
 */

import { ElementType } from '../../../../src/portfolio/types.js';
import { ElementTypeTestConfig, ElementData } from './types.js';

/**
 * Factory function to create test data
 */
function createYourTypeTestData(overrides?: Partial<ElementData>): ElementData {
  const base: ElementData = {
    name: overrides?.name || 'Test YourType',
    description: overrides?.description || 'A test element',
    metadata: {
      // Add your default metadata fields
      ...(overrides?.metadata || {})
    }
  };
  return { ...base, ...overrides };
}

export const YOUR_TYPE_CONFIG: ElementTypeTestConfig = {
  // ============================================================================
  // Identity
  // ============================================================================
  type: ElementType.YOUR_TYPE,
  displayName: 'YourTypes',

  // ============================================================================
  // Test Data Generation
  // ============================================================================
  factory: createYourTypeTestData,

  validExamples: [
    {
      name: 'Minimal YourType',
      description: 'A minimal valid example',
      metadata: {}
    }
  ],

  invalidExamples: [],

  // ============================================================================
  // Field Specifications
  // ============================================================================
  requiredFields: ['name', 'description'],

  editableFields: [
    {
      path: 'description',
      displayName: 'Description',
      type: 'string',
      required: true,
      validValues: ['Updated description']
    }
  ],

  nestedFields: {},

  // ============================================================================
  // Capabilities
  // ============================================================================
  capabilities: {
    // Add capabilities as needed
  },

  // ============================================================================
  // Validation Rules
  // ============================================================================
  validators: [
    {
      name: 'name-required',
      description: 'Name must be present',
      validate: (data) => ({
        valid: Boolean(data.name && data.name.trim()),
        message: 'Name is required'
      }),
      severity: 'error'
    }
  ]
};
```

---

## Extending Tests

### Adding New Test Scenarios

To add a new test scenario that runs for all element types:

```typescript
// In ElementCRUD.test.ts

describe.each(ELEMENT_TYPE_REGISTRY)(
  'CRUD+Activate Operations: $displayName',
  (config) => {
    // ... existing tests ...

    // Add new scenario here
    describe('CONCURRENT OPERATIONS', () => {
      it('should handle concurrent creates', async () => {
        const element1 = config.factory({ name: 'concurrent-1' });
        const element2 = config.factory({ name: 'concurrent-2' });

        // Run creates in parallel
        const [result1, result2] = await Promise.all([
          createElementViaTool(context, config.type, element1),
          createElementViaTool(context, config.type, element2)
        ]);

        // Assert both succeeded
        assertElementCreated(result1, element1);
        assertElementCreated(result2, element2);
      });

      it('should handle concurrent updates to same element', async () => {
        const element = config.factory();
        await createElementViaTool(context, config.type, element);

        // Attempt concurrent updates
        const results = await Promise.all([
          editElementViaTool(context, config.type, element.name, 'description', 'Update 1'),
          editElementViaTool(context, config.type, element.name, 'description', 'Update 2')
        ]);

        // One should succeed, one might fail (implementation dependent)
        const succeeded = results.filter(r => !r.isError);
        expect(succeeded.length).toBeGreaterThan(0);
      });
    });
  }
);
```

### Adding New Capabilities

To add a new capability that can be tested:

#### 1. Define Capability Interface

In `config/types.ts`:

```typescript
export interface ElementCapabilities {
  supportsActivation?: ActivationConfig;
  supportsNesting?: NestingConfig;
  hasStateFile?: StateConfig;
  supportsReferences?: ReferenceConfig;

  // NEW: Add your capability
  supportsVersioning?: VersioningConfig;
}

export interface VersioningConfig {
  versionField: string;           // Where version is stored
  versionFormat: 'semver' | 'numeric' | 'date';
  autoIncrement: boolean;         // Auto-increment on updates?
  historyTracking: boolean;       // Keep version history?
}
```

#### 2. Add Capability to Configs

In each element config that supports it:

```typescript
export const PERSONA_CONFIG: ElementTypeTestConfig = {
  // ... other fields ...

  capabilities: {
    supportsActivation: { /* ... */ },

    // Add new capability
    supportsVersioning: {
      versionField: 'metadata.version',
      versionFormat: 'semver',
      autoIncrement: true,
      historyTracking: false
    }
  }
};
```

#### 3. Add Tests for Capability

In `ElementCRUD.test.ts`:

```typescript
describe.each(ELEMENT_TYPE_REGISTRY)(
  'CRUD+Activate Operations: $displayName',
  (config) => {
    // ... existing tests ...

    // Conditional test suite for versioning
    if (config.capabilities.supportsVersioning) {
      describe('VERSIONING', () => {
        const versionConfig = config.capabilities.supportsVersioning;

        it('should auto-increment version on update', async () => {
          const element = config.factory({
            metadata: { version: '1.0.0' }
          });
          await createElementViaTool(context, config.type, element);

          await editElementViaTool(
            context,
            config.type,
            element.name,
            'description',
            'Updated'
          );

          const result = await getElementDetailsViaTool(
            context,
            config.type,
            element.name
          );

          expect(result.metadata.version).toBe('1.0.1');
        });

        it('should track version history if enabled', async () => {
          if (!versionConfig.historyTracking) {
            return; // Skip if history not tracked
          }

          // Test version history tracking
        });
      });
    }
  }
);
```

### Modifying Existing Capabilities

To modify an existing capability (e.g., add new activation strategy):

#### 1. Update Type Definition

```typescript
export interface ActivationConfig {
  activationStrategy:
    | 'behavior-change'
    | 'execution'
    | 'rendering'
    | 'orchestration'
    | 'context-loading'
    | 'lazy-loading';  // ← New strategy
  // ... other fields ...
}
```

#### 2. Update Element Configs

```typescript
export const SKILL_CONFIG: ElementTypeTestConfig = {
  capabilities: {
    supportsActivation: {
      activationStrategy: 'lazy-loading',  // Use new strategy
      requiresContext: true,
      expectedResultType: 'side-effect'
    }
  }
};
```

#### 3. Update Tests

```typescript
describe('ACTIVATE Operations', () => {
  it('should support lazy-loading activation', async () => {
    if (config.capabilities.supportsActivation?.activationStrategy !== 'lazy-loading') {
      return;
    }

    // Test lazy-loading specific behavior
  });
});
```

### Best Practices

1. **Keep Tests Generic**
   - Avoid hardcoding element type names
   - Use `config.displayName` in test descriptions
   - Use `config.factory()` to generate test data

2. **Use Capability Detection**
   - Always check capabilities before running conditional tests
   - Use helper functions from `capabilityDetector.ts`

3. **Provide Clear Test Names**
   ```typescript
   // ✅ Good: Describes what and why
   it('should reject nested elements beyond max depth', ...)

   // ❌ Bad: Vague description
   it('should work correctly', ...)
   ```

4. **Test Both Success and Failure**
   ```typescript
   it('should create element successfully', ...)
   it('should reject invalid element data', ...)
   it('should handle concurrent creation conflicts', ...)
   ```

5. **Clean Up After Tests**
   ```typescript
   afterEach(async () => {
     // Delete test elements
     await deleteElementViaTool(context, config.type, testElementName);
   });
   ```

---

## Capability System

### Overview

The capability system is the core innovation that makes this test suite **extensible and maintainable**. Instead of hardcoding type-specific logic, tests detect and respond to element capabilities.

### All Capabilities in Detail

#### supportsActivation

**What it means**: The element can be "executed" or "activated" - it performs an action beyond just storing data.

**When to use**: Element types that have runtime behavior (personas, skills, templates, agents, ensembles).

**Configuration**:
```typescript
supportsActivation: {
  // How does activation work?
  activationStrategy:
    | 'behavior-change'   // Changes AI behavior (personas)
    | 'execution'         // Executes code/logic (agents)
    | 'rendering'         // Renders output (templates)
    | 'orchestration'     // Coordinates others (ensembles)
    | 'context-loading',  // Loads context (memories)

  // Does activation require context data?
  requiresContext: boolean,

  // What type of result is produced?
  expectedResultType:
    | 'state-change'      // Changes state (personas)
    | 'output'            // Produces output (templates)
    | 'side-effect'       // Has side effects (agents)
    | 'multi-element',    // Affects multiple elements (ensembles)

  // Sample contexts for testing
  testContexts: [
    {
      description: 'Activation with default settings',
      context: { mode: 'default' },
      expectedOutcome: 'Element activates successfully'
    }
  ]
}
```

**Test scenarios generated**:
```typescript
✅ should activate element successfully
✅ should handle activation with context
✅ should verify element becomes active
✅ should support activation strategy
✅ should handle activation failures
✅ should test each provided context
✅ should support multiple simultaneous activations (if applicable)
```

**Example: Persona Activation**
```typescript
// Config
capabilities: {
  supportsActivation: {
    activationStrategy: 'behavior-change',
    requiresContext: false,
    expectedResultType: 'state-change'
  }
}

// Test
it('should activate persona and change AI behavior', async () => {
  await createElementViaTool(context, ElementType.PERSONA, personaData);

  const result = await activateElementViaTool(
    context,
    ElementType.PERSONA,
    personaData.name
  );

  assertElementActivated(result);
  await verifyElementActive(context, ElementType.PERSONA, personaData.name);
});
```

#### supportsNesting

**What it means**: The element can contain other elements within its structure.

**When to use**: Element types that orchestrate or compose other elements (currently only ensembles).

**Configuration**:
```typescript
supportsNesting: {
  // Maximum levels of nesting allowed
  maxDepth: 10,

  // Which element types can be nested?
  allowedTypes: [
    ElementType.PERSONA,
    ElementType.SKILL,
    ElementType.TEMPLATE,
    ElementType.AGENT,
    ElementType.MEMORY,
    ElementType.ENSEMBLE  // Can nest itself!
  ],

  // Should circular dependencies be detected and prevented?
  detectCircular: true,

  // Where are nested elements stored? (dot notation)
  nestingField: 'metadata.elements'
}
```

**Test scenarios generated**:
```typescript
✅ should nest elements successfully
✅ should respect max nesting depth
✅ should reject nesting beyond max depth
✅ should only allow configured types to be nested
✅ should detect circular dependencies
✅ should activate nested elements when parent activates
✅ should handle nested element failures gracefully
✅ should support nested element of each allowed type
```

**Example: Ensemble Nesting**
```typescript
// Config
capabilities: {
  supportsNesting: {
    maxDepth: 10,
    allowedTypes: [ElementType.PERSONA, ElementType.SKILL],
    detectCircular: true,
    nestingField: 'metadata.elements'
  }
}

// Test
it('should nest persona within ensemble', async () => {
  // Create persona
  await createElementViaTool(context, ElementType.PERSONA, personaData);

  // Create ensemble with nested persona
  const ensemble = {
    name: 'test-ensemble',
    description: 'Ensemble with nested persona',
    metadata: {
      elements: [
        {
          name: personaData.name,
          type: ElementType.PERSONA,
          role: 'primary',
          order: 1
        }
      ]
    }
  };

  const result = await createElementViaTool(
    context,
    ElementType.ENSEMBLE,
    ensemble
  );

  assertElementCreated(result, ensemble);

  // Verify nesting
  const details = await getElementDetailsViaTool(
    context,
    ElementType.ENSEMBLE,
    ensemble.name
  );

  expect(details.metadata.elements).toHaveLength(1);
  expect(details.metadata.elements[0].name).toBe(personaData.name);
});
```

#### hasStateFile

**What it means**: The element maintains a separate state file (beyond the main YAML definition) for runtime state.

**When to use**: Element types that need to persist execution state separately from their definition (agents, memories).

**Configuration**:
```typescript
hasStateFile: {
  // File extension for state files
  fileExtension: '.state.yaml',

  // Schema for validating state structure (optional)
  stateSchema: {
    lastExecuted: 'date',
    executionCount: 'number',
    previousResults: 'array'
  },

  // Should state file be deleted when element is deleted?
  cleanupOnDelete: true
}
```

**Test scenarios generated**:
```typescript
✅ should create state file on first activation
✅ should persist state across activations
✅ should load state when element is loaded
✅ should handle missing state file gracefully
✅ should handle corrupted state file
✅ should validate state against schema (if provided)
✅ should cleanup state file on element deletion (if cleanupOnDelete: true)
```

**Example: Agent State File**
```typescript
// Config
capabilities: {
  hasStateFile: {
    fileExtension: '.state.yaml',
    stateSchema: {
      lastExecuted: 'date',
      goalProgress: 'number'
    },
    cleanupOnDelete: true
  }
}

// Test
it('should create and persist agent state', async () => {
  await createElementViaTool(context, ElementType.AGENT, agentData);

  // First activation creates state file
  await activateElementViaTool(context, ElementType.AGENT, agentData.name);

  // Verify state file exists
  const stateFile = path.join(
    portfolioPath,
    'agents',
    `${agentData.name}.state.yaml`
  );
  const stateExists = await fs.access(stateFile)
    .then(() => true)
    .catch(() => false);

  expect(stateExists).toBe(true);

  // Verify state content
  const stateContent = await fs.readFile(stateFile, 'utf-8');
  const state = yaml.parse(stateContent);

  expect(state.lastExecuted).toBeDefined();
  expect(typeof state.goalProgress).toBe('number');
});
```

#### supportsReferences

**What it means**: The element can reference other elements (dependencies, includes, relationships).

**When to use**: Element types that depend on or interact with other elements (ensembles, templates, potentially skills/agents).

**Configuration**:
```typescript
supportsReferences: {
  // Types of references supported
  referenceTypes: [
    ReferenceType.INTERNAL,    // Reference to another element in portfolio
    ReferenceType.EXTERNAL,    // Reference to external resource
    ReferenceType.DEPENDENCY   // Required dependency on another element
  ],

  // Are references bidirectional?
  bidirectional: false,

  // Where are references stored? (dot notation)
  referenceField: 'metadata.dependencies'
}
```

**Test scenarios generated**:
```typescript
✅ should resolve internal references
✅ should detect missing references
✅ should handle external references
✅ should validate reference types
✅ should detect circular references
✅ should support bidirectional references (if bidirectional: true)
✅ should fail activation if dependency missing
```

**Example: Template Includes**
```typescript
// Config
capabilities: {
  supportsReferences: {
    referenceTypes: [ReferenceType.INTERNAL],
    bidirectional: false,
    referenceField: 'metadata.includes'
  }
}

// Test
it('should resolve template includes', async () => {
  // Create base template
  await createElementViaTool(context, ElementType.TEMPLATE, baseTemplate);

  // Create template that includes the base
  const composite = {
    name: 'composite-template',
    description: 'Template with includes',
    metadata: {
      includes: [baseTemplate.name]
    }
  };

  await createElementViaTool(context, ElementType.TEMPLATE, composite);

  // Activate should resolve includes
  const result = await activateElementViaTool(
    context,
    ElementType.TEMPLATE,
    composite.name
  );

  // Verify include was resolved
  expect(result.content).toContain('content from base template');
});
```

---

## Test Helpers

### crudTestHelpers.ts

**Purpose**: Generic assertion functions for CRUD operations.

**Key Functions**:

```typescript
// Assert element was created
assertElementCreated(result: any, expectedData: Partial<ElementData>): void
// Usage:
const result = await createElementViaTool(context, type, data);
assertElementCreated(result, data);

// Assert element was retrieved
assertElementRetrieved(result: any, expectedData: Partial<ElementData>): void
// Usage:
const result = await getElementDetailsViaTool(context, type, name);
assertElementRetrieved(result, expectedData);

// Assert element was updated
assertElementUpdated(result: any, oldData: Partial<ElementData>, newData: Partial<ElementData>): void
// Usage:
const result = await editElementViaTool(context.server, name, type, { description: 'new value' });
assertElementUpdated(result, oldData, newData);

// Assert element was deleted
assertElementDeleted(result: any, elementId: string): void
// Usage:
const result = await deleteElementViaTool(context, type, name);
assertElementDeleted(result, name);

// Assert validation completed
assertElementValidated(result: any, expectedErrors?: string[]): void
// Usage:
const result = await validateElementViaTool(context, type, name);
assertElementValidated(result, ['missing required field']);

// Assert activation succeeded
assertElementActivated(result: any, expectedState?: Record<string, any>): void
// Usage:
const result = await activateElementViaTool(context, type, name);
assertElementActivated(result);

// Assert operation failed
assertOperationFailed(result: any, expectedError?: string): void
// Usage:
const result = await createElementViaTool(context, type, invalidData);
assertOperationFailed(result, 'required field missing');

// Field value assertions
assertFieldValue(actualData: any, fieldPath: string, expectedValue: any): void
assertFieldExists(data: any, fieldPath: string): void
assertFieldNotExists(data: any, fieldPath: string): void

// Array assertions
assertArrayLength(array: any[], expectedCount: number): void
assertArrayContains(array: any[], predicate: (item: any) => boolean): void

// Utility functions
getNestedValue(obj: any, path: string): any
setNestedValue(obj: any, path: string, value: any): void
deepClone<T>(obj: T): T
waitFor(condition: () => boolean | Promise<boolean>, timeout?: number): Promise<void>
```

### elementFactories.ts

**Purpose**: Generate test data for elements.

**Key Functions**:

```typescript
// Create minimal valid element
createMinimalElement(config: ElementTypeTestConfig, overrides?: Partial<ElementData>): ElementData
// Usage:
const minimalPersona = createMinimalElement(PERSONA_CONFIG);
const customMinimal = createMinimalElement(PERSONA_CONFIG, { name: 'custom-name' });

// Create complete element with all fields
createCompleteElement(config: ElementTypeTestConfig, overrides?: Partial<ElementData>): ElementData
// Usage:
const completeSkill = createCompleteElement(SKILL_CONFIG);

// Create invalid element for testing validation
createInvalidElement(config: ElementTypeTestConfig, invalidationType: string): ElementData
// Usage:
const missingField = createInvalidElement(config, 'missing-required-field');
const tooLong = createInvalidElement(config, 'name-too-long');

// Generate unique name
generateUniqueName(prefix: string): string
// Usage:
const name = generateUniqueName('test-persona'); // 'test-persona-1699901234567'

// Get default value for field type
getDefaultValueForField(fieldConfig: FieldConfig): any
// Usage:
const defaultValue = getDefaultValueForField({ type: 'string', required: true });
```

### serverSetup.ts

**Purpose**: Manage test server lifecycle and MCP tool calls.

**Key Functions**:

```typescript
// Setup test server
setupTestServer(): Promise<TestServerContext>
// Usage:
beforeAll(async () => {
  context = await setupTestServer();
});

// Dispose test server
context.dispose(): Promise<void>
// Usage:
afterAll(async () => {
  await context.dispose();
});

// Call MCP tools
createElementViaTool(context: TestServerContext, type: ElementType, data: ElementData): Promise<any>
editElementViaTool(server: DollhouseMCPServer, name: string, type: ElementType, input: Record<string, unknown>): Promise<any>
deleteElementViaTool(context: TestServerContext, type: ElementType, name: string): Promise<any>
validateElementViaTool(context: TestServerContext, type: ElementType, name: string): Promise<any>
listElementsViaTool(context: TestServerContext, type: ElementType): Promise<any>
getElementDetailsViaTool(context: TestServerContext, type: ElementType, name: string): Promise<any>
activateElementViaTool(context: TestServerContext, type: ElementType, name: string, context?: any): Promise<any>
getActiveElementsViaTool(context: TestServerContext, type: ElementType): Promise<any>

// Usage:
const result = await createElementViaTool(context, ElementType.PERSONA, personaData);
const details = await getElementDetailsViaTool(context, ElementType.PERSONA, 'test-persona');
```

### capabilityDetector.ts

**Purpose**: Detect and query element capabilities.

**Key Functions**:

```typescript
// Check if capability exists
hasActivationSupport(config: ElementTypeTestConfig): boolean
hasNestingSupport(config: ElementTypeTestConfig): boolean
hasStateFileSupport(config: ElementTypeTestConfig): boolean
hasReferenceSupport(config: ElementTypeTestConfig): boolean

// Usage:
if (hasActivationSupport(config)) {
  // Run activation tests
}

// Get capability configuration
getActivationConfig(config: ElementTypeTestConfig): ActivationConfig | undefined
getNestingConfig(config: ElementTypeTestConfig): NestingConfig | undefined
getStateConfig(config: ElementTypeTestConfig): StateConfig | undefined
getReferenceConfig(config: ElementTypeTestConfig): ReferenceConfig | undefined

// Usage:
const activationConfig = getActivationConfig(config);
if (activationConfig) {
  expect(activationConfig.activationStrategy).toBe('behavior-change');
}

// Extract specific capability details
getMaxNestingDepth(config: ElementTypeTestConfig): number | undefined
detectsCircularDependencies(config: ElementTypeTestConfig): boolean
getTestContexts(config: ElementTypeTestConfig): ActivationContext[]
getActivationStrategy(config: ElementTypeTestConfig): string | undefined

// Usage:
const maxDepth = getMaxNestingDepth(config) || 1;
const contexts = getTestContexts(config);
contexts.forEach(ctx => {
  it(`should ${ctx.description}`, async () => {
    // Test with this context
  });
});
```

### activationHelpers.ts

**Purpose**: Specialized utilities for activation testing.

**Key Functions**:

```typescript
// Prepare activation context
prepareActivationContext(config: ElementTypeTestConfig, contextData?: any): any
// Usage:
const context = prepareActivationContext(config, { mode: 'strict' });

// Execute activation
executeActivation(context: TestServerContext, type: ElementType, name: string, activationContext?: any): Promise<any>
// Usage:
const result = await executeActivation(context, ElementType.AGENT, 'test-agent', { goal: 'complete task' });

// Verify activation result
verifyActivationResult(result: any, expectedType: string): void
// Usage:
verifyActivationResult(result, 'state-change');

// Verify element is active
verifyElementActive(context: TestServerContext, type: ElementType, name: string): Promise<boolean>
// Usage:
const isActive = await verifyElementActive(context, ElementType.PERSONA, 'test-persona');
expect(isActive).toBe(true);

// Execute with multiple test contexts
executeActivationWithContexts(context: TestServerContext, type: ElementType, name: string, contexts: ActivationContext[]): Promise<any[]>
// Usage:
const results = await executeActivationWithContexts(context, type, name, testContexts);
results.forEach((result, i) => {
  verifyActivationResult(result, testContexts[i].expectedOutcome);
});

// Test activation failure scenarios
testActivationFailure(context: TestServerContext, type: ElementType, name: string, expectedError: string): Promise<void>
// Usage:
await testActivationFailure(context, type, 'nonexistent', 'not found');

// Create element ready for activation
createActivatableElement(context: TestServerContext, config: ElementTypeTestConfig): Promise<ElementData>
// Usage:
const element = await createActivatableElement(context, AGENT_CONFIG);
// Element is created and ready to activate
```

---

## Migration Path to Schema-Based System

### Current Implementation (Config-Driven)

**Today**, tests use configuration files:

```typescript
// personaConfig.ts
export const PERSONA_CONFIG: ElementTypeTestConfig = {
  type: ElementType.PERSONA,
  displayName: 'Personas',
  factory: createPersonaTestData,
  capabilities: {
    supportsActivation: { /* ... */ }
  },
  validators: [ /* ... */ ]
};
```

**Tests consume configs**:
```typescript
describe.each(ELEMENT_TYPE_REGISTRY)(
  'CRUD: $displayName',
  (config) => {
    // Use config to drive tests
  }
);
```

### Future Vision (Schema-Driven)

**Future**, element types defined by schemas:

```yaml
# schemas/persona.schema.yaml
type: persona
displayName: Personas
description: Behavioral AI profiles

fields:
  name:
    type: string
    required: true
    maxLength: 100

  description:
    type: string
    required: true
    maxLength: 500

  content:
    type: string
    required: true
    description: "AI behavioral instructions"

  metadata:
    type: object
    properties:
      triggers:
        type: array
        items: string
        description: "Activation trigger words"

      category:
        type: enum
        values: [creative, technical, general]

capabilities:
  activation:
    strategy: behavior-change
    requiresContext: false
    resultType: state-change

validation:
  - rule: content-not-empty
    field: content
    message: "Persona instructions are required"
```

**Tests consume schemas** (future):
```typescript
// Load schema and convert to test config
const personaSchema = await loadSchema('persona.schema.yaml');
const config = personaSchema.toTestConfig();

// Same test code works!
describe.each(SCHEMA_REGISTRY)(
  'CRUD: $displayName',
  (config) => {
    // Identical tests, schema-driven
  }
);
```

### How Configs Will Map to Schemas

| Config Property | Schema Property | Conversion |
|----------------|-----------------|------------|
| `type` | `type` | Direct mapping |
| `displayName` | `displayName` | Direct mapping |
| `factory` | `fields` + `defaults` | Generate factory from schema |
| `validExamples` | `examples` | Direct mapping |
| `invalidExamples` | `validation.examples` | Generate from validation rules |
| `requiredFields` | `fields[].required` | Extract required fields |
| `editableFields` | `fields[].editable` | Extract editable fields |
| `capabilities` | `capabilities` | Direct mapping |
| `validators` | `validation` | Convert rules to functions |

### What Needs to Change (Minimal)

**1. Add Schema Loader** (new file):
```typescript
// config/schemaLoader.ts
export async function loadSchemaConfig(schemaPath: string): Promise<ElementTypeTestConfig> {
  const schema = await parseSchema(schemaPath);

  return {
    type: schema.type,
    displayName: schema.displayName,
    factory: generateFactoryFromSchema(schema),
    validExamples: schema.examples?.valid || [],
    invalidExamples: generateInvalidExamples(schema.validation),
    requiredFields: extractRequiredFields(schema.fields),
    editableFields: extractEditableFields(schema.fields),
    capabilities: mapCapabilities(schema.capabilities),
    validators: generateValidators(schema.validation)
  };
}
```

**2. Update Registry** (one line change):
```typescript
// Before (config-driven)
export const ELEMENT_TYPE_REGISTRY: ElementTypeTestConfig[] = [
  PERSONA_CONFIG,
  SKILL_CONFIG,
  // ...
];

// After (schema-driven)
export const ELEMENT_TYPE_REGISTRY: ElementTypeTestConfig[] = await Promise.all([
  loadSchemaConfig('schemas/persona.schema.yaml'),
  loadSchemaConfig('schemas/skill.schema.yaml'),
  // ...
]);
```

**3. Tests Stay Identical** (zero changes):
```typescript
// This code works for both config-driven and schema-driven!
describe.each(ELEMENT_TYPE_REGISTRY)(
  'CRUD+Activate: $displayName',
  (config) => {
    // All existing tests unchanged
  }
);
```

### Code Example: Migration in Action

**Before (Current)**:
```typescript
// tests/integration/crud/config/personaConfig.ts
export const PERSONA_CONFIG: ElementTypeTestConfig = {
  type: ElementType.PERSONA,
  displayName: 'Personas',
  factory: createPersonaTestData,
  capabilities: {
    supportsActivation: {
      activationStrategy: 'behavior-change',
      requiresContext: false,
      expectedResultType: 'state-change'
    }
  }
};
```

**After (Future)**:
```yaml
# schemas/persona.schema.yaml
type: persona
displayName: Personas

capabilities:
  activation:
    strategy: behavior-change
    requiresContext: false
    resultType: state-change
```

```typescript
// tests/integration/crud/config/elementTypeRegistry.ts
import { loadSchemaConfig } from './schemaLoader.js';

export const ELEMENT_TYPE_REGISTRY = await Promise.all([
  loadSchemaConfig('schemas/persona.schema.yaml'),
  loadSchemaConfig('schemas/skill.schema.yaml'),
  // ...
]);
```

**Test Code** (unchanged):
```typescript
// tests/integration/crud/ElementCRUD.test.ts
describe.each(ELEMENT_TYPE_REGISTRY)(
  'CRUD+Activate: $displayName',
  (config) => {
    if (config.capabilities.supportsActivation) {
      it('should activate element', async () => {
        // Works with both config-driven and schema-driven!
      });
    }
  }
);
```

### Benefits of Migration Path

1. **Zero Test Rewrites**: Test code remains identical
2. **Gradual Migration**: Can migrate one type at a time
3. **Single Source of Truth**: Schemas define types once
4. **Type Safety**: TypeScript interfaces preserve type safety
5. **Extensibility**: New types = new schema file, tests auto-run

---

## Troubleshooting

### Common Issues and Solutions

#### Issue: Test Fails - "Element not found"

**Symptoms**:
```
❌ should retrieve element details
Error: Element 'test-persona-123456' not found
```

**Cause**: Element was not created, or was deleted by previous test.

**Solution**:
```typescript
// Ensure element is created before testing
beforeEach(async () => {
  testElement = config.factory();
  await createElementViaTool(context, config.type, testElement);
});

// Clean up after each test
afterEach(async () => {
  await deleteElementViaTool(context, config.type, testElement.name);
});
```

#### Issue: Error Message Format Mismatch

**Symptoms**:
```
❌ should reject invalid element
Expected error to contain "required" but got "Field 'name' must be provided"
```

**Cause**: Actual error message doesn't match expected pattern.

**Solution 1**: Update expected error pattern to be more flexible:
```typescript
// Before
expectedError: 'required'

// After (regex pattern)
expectedError: 'required|must be provided|is necessary'
```

**Solution 2**: Update config to match actual error:
```typescript
invalidExamples: [
  {
    data: { name: '', description: 'test' },
    expectedError: 'must be provided'  // Match actual error
  }
]
```

#### Issue: Timing Issues - "Operation in progress"

**Symptoms**:
```
❌ should handle concurrent updates
Error: Element is locked by another operation
```

**Cause**: File locking or race condition.

**Solution**:
```typescript
// Add delays between operations
await createElementViaTool(context, config.type, element);
await new Promise(resolve => setTimeout(resolve, 100));  // Wait 100ms
await editElementViaTool(context.server, element.name, config.type, { description: value });

// Or use sequential execution
for (const operation of operations) {
  await operation();  // Wait for each to complete
}
```

#### Issue: State Cleanup Problems

**Symptoms**:
```
❌ should start with clean state
Error: Element 'test-agent-previous' already exists
```

**Cause**: Previous tests didn't clean up properly.

**Solution**:
```typescript
// Global cleanup before all tests
beforeAll(async () => {
  // Delete all test elements
  const elements = await listElementsViaTool(context, config.type);
  for (const el of elements) {
    if (el.name.startsWith('test-')) {
      await deleteElementViaTool(context, config.type, el.name);
    }
  }
});

// Or use unique names per test
it('should create element', async () => {
  const uniqueName = `test-${Date.now()}-${Math.random()}`;
  const element = config.factory({ name: uniqueName });
  // ...
});
```

#### Issue: Build Errors - "Cannot find module"

**Symptoms**:
```
Error: Cannot find module './config/personaConfig.js'
```

**Cause**: TypeScript build failed or import path incorrect.

**Solution**:
```bash
# Rebuild TypeScript
npm run build

# Check import paths use .js extension (not .ts)
import { PERSONA_CONFIG } from './config/personaConfig.js';  // ✅
import { PERSONA_CONFIG } from './config/personaConfig.ts';  // ❌
```

#### Issue: Capability Tests Skipped

**Symptoms**:
```
Test suite: 40 tests
Activation tests: 0 skipped

Expected: Activation tests should run for personas
```

**Cause**: Capability not properly defined in config.

**Solution**:
```typescript
// Verify capability is defined
capabilities: {
  supportsActivation: {  // Must be defined, not undefined
    activationStrategy: 'behavior-change',
    requiresContext: false,
    expectedResultType: 'state-change'
  }
}

// Check test uses correct detection
if (hasActivationSupport(config)) {  // Use helper function
  describe('ACTIVATE', () => {
    // Tests here
  });
}
```

#### Issue: Memory Leaks in Long Test Runs

**Symptoms**:
```
FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory
```

**Cause**: Not disposing server context properly.

**Solution**:
```typescript
// Ensure cleanup in afterAll
afterAll(async () => {
  if (context) {
    await context.dispose();  // Critical!
    context = null;
  }
}, 30000);  // Allow time for cleanup

// Or increase heap size for tests
// In package.json:
"test:integration": "NODE_OPTIONS='--max-old-space-size=4096' jest ..."
```

#### Issue: Flaky Tests - Passes Sometimes, Fails Others

**Symptoms**:
```
Run 1: ✅ All tests passed
Run 2: ❌ 3 tests failed
Run 3: ✅ All tests passed
```

**Cause**: Race conditions, timing dependencies, or shared state.

**Solution**:
```typescript
// Increase timeouts for slow operations
it('should activate element', async () => {
  // ...
}, 10000);  // 10 second timeout

// Add explicit waits
await waitFor(
  () => verifyElementActive(context, type, name),
  5000  // Wait up to 5 seconds
);

// Isolate test state
beforeEach(async () => {
  // Create fresh test data each time
  testElement = config.factory({ name: generateUniqueName('test') });
});
```

---

## Current Status & Future Work

### What's Implemented (80.5% Pass Rate)

**✅ Completed**:
- Foundation & infrastructure (100%)
- Configuration system for all 6 element types (100%)
- Generic CRUD test suite (100%)
- Capability detection system (100%)
- Test helper modules (100%)
- Element factories (100%)
- Server setup utilities (100%)
- Activation testing framework (100%)

**Test Coverage**:
- **Total Tests**: 277
- **Passing**: 223 (80.5%)
- **Failing**: 54 (19.5%)
- **Element Types**: 6/6 (100%)
- **CRUD Operations**: All covered
- **Activation Tests**: All implemented

**Lines of Code**:
- Total: 5,522 lines
- Test suite: 1,017 lines
- Configs: 2,521 lines
- Helpers: 1,636 lines
- Fixtures: 364 lines

### What's Not Yet Implemented (Remaining 54 Failures)

**❌ Known Failures** (to be addressed):

1. **Validation Tests** (~20 failures)
   - Some validation rules not yet implemented in managers
   - Error message format inconsistencies
   - Missing field validation edge cases

2. **Edit Operation Tests** (~15 failures)
   - Nested field editing for some types
   - Complex metadata updates
   - Concurrent edit handling

3. **Activation Context Tests** (~10 failures)
   - Context propagation for ensembles
   - Strategy-specific activation behavior
   - Failure recovery mechanisms

4. **State File Tests** (~5 failures)
   - State persistence for agents
   - State cleanup on deletion
   - Corrupted state handling

5. **Nesting Tests** (~4 failures)
   - Deep nesting edge cases
   - Circular dependency detection refinement
   - Nested activation propagation

### Roadmap for 100% Pass Rate

**Phase 1: Fix Validation (Week 1)**
- Implement missing validation rules in element managers
- Standardize error message formats
- Add field-level validation for all types
- **Target**: 20 additional passing tests

**Phase 2: Fix Edit Operations (Week 2)**
- Implement nested field editing
- Add concurrent edit handling
- Fix metadata update edge cases
- **Target**: 15 additional passing tests

**Phase 3: Fix Activation Tests (Week 3)**
- Implement context propagation
- Add strategy-specific behavior
- Implement failure recovery
- **Target**: 10 additional passing tests

**Phase 4: Fix State/Nesting (Week 4)**
- Implement state file persistence for agents
- Fix state cleanup
- Refine nesting edge cases
- **Target**: 9 additional passing tests

**Milestone**: 277/277 tests passing (100%)

### Future Enhancement Ideas

**1. Performance Testing**
- Add performance benchmarks for CRUD operations
- Test with large numbers of elements (1000+)
- Measure activation overhead

**2. Concurrency Testing**
- Systematic concurrent operation testing
- Race condition detection
- Lock contention analysis

**3. Security Testing**
- Path traversal attack tests
- Malicious YAML injection tests
- Resource exhaustion tests

**4. Error Recovery Testing**
- Partial failure recovery
- Transaction rollback testing
- Consistency verification

**5. Integration with CI/CD**
- Add to main test suite
- Set up coverage thresholds
- Add performance regression detection

**6. Documentation Improvements**
- Video walkthroughs
- Interactive examples
- Migration guides for production schemas

---

## Contributing

### How to Report Issues

**1. Check Existing Issues**: Search for similar problems first.

**2. Create Detailed Report**:
```markdown
## Issue: [Brief Description]

### Environment
- Node version: 20.x
- npm version: 10.x
- OS: macOS 14.x

### Element Type
- Type: Personas / Skills / Templates / etc.
- Config: personaConfig.ts

### Test Scenario
- Operation: CREATE / UPDATE / DELETE / etc.
- Test: "should create minimal element"

### Expected Behavior
Element should be created successfully with minimal required fields.

### Actual Behavior
Error: "Field 'content' is required"

### Steps to Reproduce
1. Run: npm test -- tests/integration/crud/ElementCRUD.test.ts -t "Personas"
2. Observe failure on CREATE tests
3. Error message shows content validation issue

### Error Output
```
[Paste error stack trace]
```

### Possible Cause
Config missing 'content' in requiredFields array.
```

### How to Add New Test Scenarios

**1. Identify Gap**: What's not tested?

**2. Add to Main Test Suite**:
```typescript
// In ElementCRUD.test.ts
describe('EDGE CASES', () => {
  it('should handle very long element names', async () => {
    const longName = 'a'.repeat(500);
    const element = config.factory({ name: longName });

    const result = await createElementViaTool(context, config.type, element);

    // Should either succeed or fail gracefully
    if (result.isError) {
      assertOperationFailed(result, 'name too long');
    } else {
      assertElementCreated(result, element);
    }
  });
});
```

**3. Add Test Data to Configs** (if needed):
```typescript
invalidExamples: [
  // ... existing examples ...
  {
    data: { name: 'a'.repeat(500), description: 'test' },
    expectedError: 'name too long|exceeds maximum length'
  }
]
```

**4. Submit Pull Request**:
- Reference related issue
- Describe what's being tested
- Include test output showing pass/fail

### Code Review Expectations

**Reviewers Will Check**:
1. ✅ Tests are generic (work for all element types)
2. ✅ No hardcoded type-specific logic
3. ✅ Capability-based conditional testing
4. ✅ Clear test descriptions
5. ✅ Proper cleanup after tests
6. ✅ Documentation updated if needed

**Before Submitting PR**:
```bash
# Run full test suite
npm test -- tests/integration/crud/ElementCRUD.test.ts

# Check linting
npm run lint

# Verify build
npm run build

# Run security checks
npm run security:rapid
```

### Documentation Requirements

**When to Update Documentation**:
- Adding new capabilities
- Changing config interface
- Adding new test scenarios
- Fixing common issues

**What to Update**:
1. This README.md (for user-facing changes)
2. ARCHITECTURE.md (for design decisions)
3. EXAMPLES.md (for new patterns)
4. Code comments (for complex logic)

---

## References

### Related Issues

- **Issue #16**: Build comprehensive CRUD+Activate test suite for all element types
  - https://github.com/DollhouseMCP/mcp-server-v2-refactor/issues/16
  - This entire test suite

### Related Session Notes

- **SESSION_NOTES_2025-11-19_ISSUE16_CRUD_TEST_ARCHITECTURE.md**
  - Planning session for this test suite
  - Architecture decisions and rationale
  - Migration path design

- **SESSION_NOTES_2025-11-19_ISSUE14_ENSEMBLE_ARRAY_REFACTOR.md**
  - Ensemble array refactoring
  - Nesting implementation details
  - Original ensemble CRUD tests

### Element Type Documentation

- **Element Types Overview**: `/docs/reference/element-types.md`
- **Adding Elements Guide**: `/docs/developer-guide/adding-elements.md`
- **Element Architecture**: `/docs/architecture/element-architecture.md`

### MCP Tool Documentation

- **MCP Tool Reference**: `/docs/reference/api-reference.md`
- **Tool Handler Architecture**: `/docs/architecture/handlers.md`
- **ElementCRUDHandler**: `/src/handlers/ElementCRUDHandler.ts`

### Related Code

- **Element Type Config**: `/src/config/element-types.ts`
- **Element Type Enum**: `/src/portfolio/types.ts`
- **Base Element**: `/src/types/elements/IElement.ts`
- **Base Manager**: `/src/elements/base/BaseElementManager.ts`
- **Element CRUD Handlers**: `/src/handlers/element-crud/`

### Testing Documentation

- **Testing Strategy**: `/docs/developer-guide/testing-strategy.md`
- **Integration Tests Guide**: `/docs/developer-guide/integration-testing.md`
- **Jest Configuration**: `/tests/jest.config.cjs`

---

## Quick Reference

### Common Commands

```bash
# Run all CRUD tests
npm test -- tests/integration/crud/ElementCRUD.test.ts

# Run specific element type
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "Personas"

# Run specific operation
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "CREATE"

# Debug mode
npm test -- tests/integration/crud/ElementCRUD.test.ts --verbose

# Watch mode
npm test -- tests/integration/crud/ElementCRUD.test.ts --watch

# With coverage
npm test -- tests/integration/crud/ElementCRUD.test.ts --coverage
```

### File Locations

| What | Where |
|------|-------|
| Main test suite | `tests/integration/crud/ElementCRUD.test.ts` |
| Config registry | `tests/integration/crud/config/elementTypeRegistry.ts` |
| Config interfaces | `tests/integration/crud/config/types.ts` |
| Persona config | `tests/integration/crud/config/personaConfig.ts` |
| CRUD helpers | `tests/integration/crud/helpers/crudTestHelpers.ts` |
| Activation helpers | `tests/integration/crud/helpers/activationHelpers.ts` |

### Key Concepts

| Concept | Meaning |
|---------|---------|
| **Capability-based** | Tests selected by element capabilities, not type checks |
| **Parameterized** | Single test suite runs for all element types |
| **Configuration-driven** | Test behavior defined by config files |
| **Generic helpers** | Shared utilities work for any element type |
| **Registry pattern** | Central registry of all element type configs |

---

**Documentation Version**: 1.0.0
**Last Updated**: 2025-11-19
**Maintainer**: DollhouseMCP Team
**License**: AGPL-3.0
