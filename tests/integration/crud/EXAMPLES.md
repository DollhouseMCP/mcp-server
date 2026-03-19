# CRUD+Activate Test Suite Examples

**Complete walkthroughs, example configurations, and debugging scenarios**

## Table of Contents

- [Complete Persona Configuration Walkthrough](#complete-persona-configuration-walkthrough)
- [Complete Ensemble Configuration Walkthrough](#complete-ensemble-configuration-walkthrough)
- [Example Test Execution Traces](#example-test-execution-traces)
- [Debugging Scenarios](#debugging-scenarios)
- [Adding a Custom Element Type](#adding-a-custom-element-type)
- [Common Patterns](#common-patterns)

---

## Complete Persona Configuration Walkthrough

### Overview

Personas are behavioral profiles that define AI personality. They support **activation** (changing AI behavior) but not nesting, state files, or references.

### Full Configuration File

Let's examine `tests/integration/crud/config/personaConfig.ts` in detail:

```typescript
/**
 * Persona element type test configuration
 *
 * Personas are behavioral profiles that define AI personality and interaction style.
 * They support activation which changes the AI's behavior immediately.
 */

import { ElementType } from '../../../../src/portfolio/types.js';
import { ElementTypeTestConfig, ElementData } from './types.js';

/**
 * Factory function to create test persona data
 *
 * This is the CORE DATA GENERATOR for persona tests.
 * Every persona test starts here.
 */
function createPersonaTestData(overrides?: Partial<ElementData>): ElementData {
  // Base structure with sensible defaults
  const base: ElementData = {
    name: overrides?.name || 'Test Persona',
    description: overrides?.description || 'A test persona for validation',
    content: overrides?.content || 'You are a helpful assistant focused on testing.',
    metadata: {
      triggers: ['test', 'validation'],
      version: '1.0.0',
      author: 'test-user',
      category: 'testing',
      // Merge any override metadata
      ...(overrides?.metadata || {})
    }
  };

  // Apply overrides at top level
  return { ...base, ...overrides };
}

/**
 * Persona type test configuration
 *
 * This config drives ALL persona tests in the suite.
 */
export const PERSONA_CONFIG: ElementTypeTestConfig = {
  // ============================================================================
  // SECTION 1: Identity
  // ============================================================================

  /**
   * ElementType enum value
   * Links this config to the ElementType.PERSONA enum
   */
  type: ElementType.PERSONA,

  /**
   * Human-readable name for test descriptions
   * Used in: describe('CRUD: $displayName', ...)
   */
  displayName: 'Personas',

  // ============================================================================
  // SECTION 2: Test Data Generation
  // ============================================================================

  /**
   * Factory function for generating test personas
   * Usage in tests: const persona = config.factory({ name: 'custom' });
   */
  factory: createPersonaTestData,

  /**
   * Valid example personas
   * These are used in tests to verify correct persona creation
   */
  validExamples: [
    // Example 1: Minimal Valid Persona
    {
      name: 'Minimal Persona',
      description: 'A minimal valid persona',
      content: 'You are helpful.',
      metadata: {}  // No optional fields
    },

    // Example 2: Complete Persona with All Fields
    {
      name: 'Complete Persona',
      description: 'A persona with all optional fields',
      content: 'You are a creative writer who loves poetry.',
      metadata: {
        triggers: ['write', 'create', 'compose'],
        version: '2.1.0',
        author: 'test-author',
        category: 'creative',
        age_rating: 'general',
        license: 'CC-BY-4.0',
        ai_generated: false,
        content_flags: ['creative', 'writing']
      }
    },

    // Example 3: Edge Case - Many Triggers
    {
      name: 'Trigger-Heavy Persona',
      description: 'Persona with many triggers',
      content: 'Multi-purpose assistant.',
      metadata: {
        triggers: ['help', 'assist', 'support', 'guide', 'advise', 'recommend']
      }
    }
  ],

  /**
   * Invalid example personas
   * These should FAIL validation
   */
  invalidExamples: [
    {
      data: {
        name: 'Test',
        description: 'Test',
        content: ''  // ❌ INVALID: Empty content
      },
      expectedError: 'instruction'  // Error should contain "instruction"
    }
    // NOTE: More invalid examples temporarily removed
    // Will be added back when validation is fully implemented
  ],

  // ============================================================================
  // SECTION 3: Field Specifications
  // ============================================================================

  /**
   * Required fields that MUST be present
   * Tests verify these fields exist and are non-empty
   */
  requiredFields: ['name', 'description', 'content'],

  /**
   * Editable fields with test values
   * Tests verify these fields can be updated
   */
  editableFields: [
    // Field 1: Description (required, string)
    {
      path: 'description',
      displayName: 'Description',
      type: 'string',
      required: true,
      validValues: [
        'Updated description',
        'A completely different description'
      ],
      invalidValues: [
        { value: '', expectedError: 'required|empty' },
        { value: 'A'.repeat(501), expectedError: 'length|size' }
      ]
    },

    // Field 2: Content/Instructions (required, string)
    {
      path: 'content',
      displayName: 'Instructions/Content',
      type: 'string',
      required: true,
      validValues: [
        'New instructions for the persona',
        'You are now a coding expert.'
      ],
      invalidValues: [
        { value: '', expectedError: 'required|empty' }
      ]
    },

    // Field 3: Triggers (optional, array)
    {
      path: 'metadata.triggers',
      displayName: 'Triggers',
      type: 'array',
      required: false,
      validValues: [
        ['new', 'triggers'],
        ['single-trigger']
      ]
    },

    // Field 4: Version (optional, string)
    {
      path: 'metadata.version',
      displayName: 'Version',
      type: 'string',
      required: false,
      validValues: ['2.0.0', '3.1.4']
    },

    // Field 5: Category (optional, string)
    {
      path: 'metadata.category',
      displayName: 'Category',
      type: 'string',
      required: false,
      validValues: ['creative', 'technical', 'general']
    }
  ],

  /**
   * Nested field configurations
   * For complex metadata structures
   */
  nestedFields: {
    'metadata.triggers': {
      path: 'metadata.triggers',
      displayName: 'Trigger Words',
      type: 'array',
      required: false,
      validValues: [
        ['write', 'create'],
        ['help']
      ]
    }
  },

  // ============================================================================
  // SECTION 4: Capabilities (CRITICAL!)
  // ============================================================================

  capabilities: {
    /**
     * Activation Capability
     * Personas CAN be activated - they change AI behavior
     */
    supportsActivation: {
      // How activation works for personas
      activationStrategy: 'behavior-change',

      // Does activation require context data?
      requiresContext: false,

      // What type of result does activation produce?
      expectedResultType: 'state-change',

      // Sample contexts to test with
      testContexts: [
        {
          description: 'Basic activation without context',
          context: undefined,
          expectedOutcome: 'Persona becomes active, AI behavior changes'
        },
        {
          description: 'Activation with user context',
          context: { user: 'test-user', session: 'test-session' },
          expectedOutcome: 'Persona activates with user context preserved'
        }
      ]
    }

    // Personas DO NOT support:
    // - supportsNesting (can't contain other elements)
    // - hasStateFile (state stored in main file)
    // - supportsReferences (don't reference other elements)
  },

  // ============================================================================
  // SECTION 5: Validation Rules
  // ============================================================================

  validators: [
    // Validator 1: Name Required
    {
      name: 'name-required',
      description: 'Name field must be present and non-empty',
      validate: (data) => ({
        valid: Boolean(data.name && data.name.trim()),
        message: 'Persona name is required'
      }),
      severity: 'error'
    },

    // Validator 2: Description Required
    {
      name: 'description-required',
      description: 'Description field must be present and non-empty',
      validate: (data) => ({
        valid: Boolean(data.description && data.description.trim()),
        message: 'Persona description is required'
      }),
      severity: 'error'
    },

    // Validator 3: Content Required
    {
      name: 'content-required',
      description: 'Content/instructions must be present and non-empty',
      validate: (data) => ({
        valid: Boolean(data.content && data.content.trim()),
        message: 'Persona instructions (content) are required'
      }),
      severity: 'error'
    },

    // Validator 4: Triggers Format
    {
      name: 'triggers-array',
      description: 'Triggers must be an array if present',
      validate: (data) => ({
        valid: !data.metadata?.triggers || Array.isArray(data.metadata.triggers),
        message: 'Triggers must be an array'
      }),
      severity: 'error'
    },

    // Validator 5: Version Format (Warning Only)
    {
      name: 'version-format',
      description: 'Version should follow semver if present',
      validate: (data) => {
        if (!data.metadata?.version) return { valid: true };
        const semverPattern = /^\d+\.\d+\.\d+/;
        return {
          valid: semverPattern.test(data.metadata.version),
          message: 'Version should follow semver format (e.g., 1.0.0)'
        };
      },
      severity: 'warning'  // Warning, not error
    }
  ]
};
```

### How Tests Use This Config

**Test 1: Create Minimal Persona**
```typescript
it('should create minimal persona', async () => {
  // Use factory with defaults
  const persona = config.factory();
  // persona = {
  //   name: 'Test Persona',
  //   description: 'A test persona...',
  //   content: 'You are helpful...',
  //   metadata: { triggers: ['test'], ... }
  // }

  const result = await createElementViaTool(context, config.type, persona);

  assertElementCreated(result, persona);
});
```

**Test 2: Create Complete Persona**
```typescript
it('should create complete persona', async () => {
  // Use first valid example
  const persona = config.validExamples[1];  // "Complete Persona"
  // persona = {
  //   name: 'Complete Persona',
  //   content: 'You are a creative writer...',
  //   metadata: { triggers: ['write', 'create'], version: '2.1.0', ... }
  // }

  const result = await createElementViaTool(context, config.type, persona);

  assertElementCreated(result, persona);
});
```

**Test 3: Test Activation**
```typescript
if (hasActivationSupport(config)) {  // TRUE for personas
  it('should activate persona', async () => {
    const persona = config.factory();
    await createElementViaTool(context, config.type, persona);

    // Get activation config
    const activationConfig = getActivationConfig(config)!;
    // activationConfig.activationStrategy = 'behavior-change'

    // Activate
    const result = await activateElementViaTool(
      context,
      config.type,
      persona.name
    );

    assertElementActivated(result);

    // Verify active
    const isActive = await verifyElementActive(
      context,
      config.type,
      persona.name
    );
    expect(isActive).toBe(true);
  });
}
```

**Test 4: Test Validation**
```typescript
it('should detect missing content', async () => {
  // Use invalid example
  const invalid = config.invalidExamples[0];
  // invalid.data = { name: 'Test', description: 'Test', content: '' }
  // invalid.expectedError = 'instruction'

  const result = await createElementViaTool(
    context,
    config.type,
    invalid.data
  );

  // Should fail
  assertOperationFailed(result, invalid.expectedError);
  expect(result.content[0].text).toMatch(/instruction/i);
});
```

---

## Complete Ensemble Configuration Walkthrough

### Overview

Ensembles are the **most complex** element type. They support:
- ✅ Activation (orchestrating multiple elements)
- ✅ Nesting (containing other elements)
- ❌ State files (state in main file)
- ✅ References (via nested elements)

### Key Differences from Personas

| Feature | Personas | Ensembles |
|---------|----------|-----------|
| Activation | ✅ Behavior change | ✅ Multi-element orchestration |
| Nesting | ❌ | ✅ Can contain any element type |
| State File | ❌ | ❌ |
| References | ❌ | ✅ Via `metadata.elements[]` |

### Full Configuration File

```typescript
/**
 * Ensemble element type test configuration
 *
 * Ensembles orchestrate multiple elements working together as a cohesive unit.
 * They support BOTH activation AND nesting - making them the most complex type.
 */

import { ElementType } from '../../../../src/portfolio/types.js';
import { ElementTypeTestConfig, ElementData } from './types.js';

/**
 * Factory function to create test ensemble data
 */
function createEnsembleTestData(overrides?: Partial<ElementData>): ElementData {
  const base: ElementData = {
    name: overrides?.name || 'Test Ensemble',
    description: overrides?.description || 'A test ensemble for validation',
    metadata: {
      // Activation settings
      activationStrategy: 'sequential',
      conflictResolution: 'first-write',  // Note: hyphen, not underscore!
      contextSharing: true,

      // Nesting settings
      allowNested: true,
      maxNestingDepth: 3,
      elements: [],  // No elements by default

      // Resource limits
      resourceLimits: {
        maxActiveElements: 10,
        maxExecutionTimeMs: 30000
      },

      // Merge overrides
      ...(overrides?.metadata || {})
    }
  };

  return { ...base, ...overrides };
}

export const ENSEMBLE_CONFIG: ElementTypeTestConfig = {
  // ============================================================================
  // Identity
  // ============================================================================
  type: ElementType.ENSEMBLE,
  displayName: 'Ensembles',

  // ============================================================================
  // Test Data Generation
  // ============================================================================
  factory: createEnsembleTestData,

  validExamples: [
    // Example 1: Minimal Ensemble (no nested elements)
    {
      name: 'Minimal Ensemble',
      description: 'A minimal valid ensemble',
      metadata: {
        activationStrategy: 'sequential',
        conflictResolution: 'first-write',
        elements: []  // Empty is valid
      }
    },

    // Example 2: Complete Ensemble with Nested Elements
    {
      name: 'Complete Ensemble',
      description: 'An ensemble with all optional fields',
      metadata: {
        // Activation config
        activationStrategy: 'parallel',
        conflictResolution: 'merge',
        contextSharing: true,

        // Nesting config
        allowNested: true,
        maxNestingDepth: 5,

        // NESTED ELEMENTS - This is what makes ensembles special!
        elements: [
          {
            name: 'helper-persona',
            type: ElementType.PERSONA,
            role: 'primary',
            order: 1,
            condition: undefined
          },
          {
            name: 'code-skill',
            type: ElementType.SKILL,
            role: 'supporting',
            order: 2,
            condition: undefined
          }
        ],

        // Resource limits
        resourceLimits: {
          maxActiveElements: 20,
          maxExecutionTimeMs: 60000
        }
      }
    },

    // Example 3: Nested Ensemble (ensemble within ensemble!)
    {
      name: 'Nested Ensemble',
      description: 'Ensemble with nested ensemble',
      metadata: {
        activationStrategy: 'sequential',
        conflictResolution: 'priority',
        allowNested: true,
        maxNestingDepth: 2,
        elements: [
          {
            name: 'sub-ensemble',
            type: ElementType.ENSEMBLE,  // ← Nested ensemble!
            role: 'primary',
            order: 1
          }
        ]
      }
    },

    // Example 4: Conditional Activation
    {
      name: 'Conditional Ensemble',
      description: 'Ensemble with conditional activation',
      metadata: {
        activationStrategy: 'conditional',
        conflictResolution: 'newest_wins',
        elements: [
          {
            name: 'primary-persona',
            type: ElementType.PERSONA,
            role: 'primary',
            order: 1,
            condition: 'context.mode === "strict"'  // Only if strict mode
          },
          {
            name: 'fallback-persona',
            type: ElementType.PERSONA,
            role: 'fallback',
            order: 2,
            condition: 'context.mode === "relaxed"'  // Only if relaxed mode
          }
        ]
      }
    }
  ],

  invalidExamples: [
    // Temporarily empty - validation not fully implemented yet
  ],

  // ============================================================================
  // Field Specifications
  // ============================================================================

  requiredFields: ['name', 'description'],  // No 'content' for ensembles!

  editableFields: [
    {
      path: 'description',
      displayName: 'Description',
      type: 'string',
      required: true,
      validValues: [
        'Updated ensemble description',
        'A completely different description'
      ],
      invalidValues: [
        { value: '', expectedError: 'required|empty' }
      ]
    },

    // Ensemble-specific fields
    {
      path: 'metadata.activationStrategy',
      displayName: 'Activation Strategy',
      type: 'enum',
      required: false,
      validValues: ['sequential', 'parallel', 'conditional', 'on_demand'],
      invalidValues: [
        { value: 'invalid', expectedError: 'strategy|invalid' }
      ]
    },

    {
      path: 'metadata.conflictResolution',
      displayName: 'Conflict Resolution',
      type: 'enum',
      required: false,
      validValues: ['first_wins', 'newest_wins', 'merge', 'priority', 'fail'],
      invalidValues: [
        { value: 'invalid', expectedError: 'conflict|resolution|invalid' }
      ]
    },

    {
      path: 'metadata.allowNested',
      displayName: 'Allow Nested',
      type: 'boolean',
      required: false,
      validValues: [true, false]
    },

    {
      path: 'metadata.maxNestingDepth',
      displayName: 'Max Nesting Depth',
      type: 'number',
      required: false,
      validValues: [1, 2, 3, 5],
      invalidValues: [
        { value: 0, expectedError: 'minimum|invalid' },
        { value: 11, expectedError: 'maximum|exceeded' }
      ]
    }
  ],

  nestedFields: {
    'metadata.elements': {
      path: 'metadata.elements',
      displayName: 'Ensemble Elements',
      type: 'array',
      required: false,
      validValues: [
        [
          {
            name: 'test-persona',
            type: ElementType.PERSONA,
            role: 'primary',
            order: 1
          }
        ]
      ]
    }
  },

  // ============================================================================
  // Capabilities - BOTH Activation AND Nesting!
  // ============================================================================

  capabilities: {
    /**
     * Activation: Orchestrates multiple elements
     */
    supportsActivation: {
      activationStrategy: 'orchestration',  // Different from persona!
      requiresContext: false,
      expectedResultType: 'multi-element',  // Activates multiple elements
      testContexts: [
        {
          description: 'Sequential activation',
          context: { strategy: 'sequential' },
          expectedOutcome: 'Elements activate in order, each completing before next'
        },
        {
          description: 'Parallel activation',
          context: { strategy: 'parallel' },
          expectedOutcome: 'All elements activate simultaneously'
        },
        {
          description: 'Conditional activation',
          context: { strategy: 'conditional', mode: 'strict' },
          expectedOutcome: 'Only elements matching conditions activate'
        }
      ]
    },

    /**
     * Nesting: Can contain other elements (ONLY ensemble has this!)
     */
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

    // Does NOT have:
    // - hasStateFile (state in main file)
  },

  // ============================================================================
  // Validation Rules
  // ============================================================================

  validators: [
    // ... (many validators, see full file)

    // Example: Nested Ensembles Depth Check
    {
      name: 'nested-ensembles-depth',
      description: 'Nested ensembles should respect depth limits',
      validate: (data) => {
        if (!data.metadata?.elements) return { valid: true };

        const hasNestedEnsemble = data.metadata.elements.some(
          (el: any) => el.type === ElementType.ENSEMBLE
        );

        if (hasNestedEnsemble && data.metadata.allowNested === false) {
          return {
            valid: false,
            message: 'Nested ensembles not allowed when allowNested is false'
          };
        }

        return { valid: true };
      },
      severity: 'error'
    }
  ]
};
```

### How Tests Use Ensemble Config

**Test 1: Create with Nested Elements**
```typescript
it('should create ensemble with nested persona', async () => {
  // First, create a persona to nest
  const persona = PERSONA_CONFIG.factory({ name: 'helper-persona' });
  await createElementViaTool(context, ElementType.PERSONA, persona);

  // Create ensemble referencing the persona
  const ensemble = config.factory({
    name: 'test-ensemble',
    metadata: {
      elements: [
        {
          name: 'helper-persona',  // Reference created persona
          type: ElementType.PERSONA,
          role: 'primary',
          order: 1
        }
      ]
    }
  });

  const result = await createElementViaTool(context, config.type, ensemble);

  assertElementCreated(result, ensemble);

  // Verify nesting
  const details = await getElementDetailsViaTool(
    context,
    config.type,
    ensemble.name
  );

  expect(details.metadata.elements).toHaveLength(1);
  expect(details.metadata.elements[0].name).toBe('helper-persona');
});
```

**Test 2: Test Nesting Capability**
```typescript
if (hasNestingSupport(config)) {  // TRUE for ensembles only!
  it('should respect max nesting depth', async () => {
    const nestingConfig = getNestingConfig(config)!;
    const maxDepth = nestingConfig.maxDepth;  // 10

    // Try to create deeply nested ensemble
    // (implementation creates depth+1 levels)

    const result = await createElementViaTool(/*...*/);

    // Should fail if depth exceeded
    if (depth > maxDepth) {
      assertOperationFailed(result, 'depth|exceeded');
    }
  });
}
```

**Test 3: Test Activation with Context**
```typescript
it('should activate with sequential strategy', async () => {
  // Create ensemble with two personas
  const ensemble = config.validExamples[1];  // "Complete Ensemble"

  await createElementViaTool(context, config.type, ensemble);

  // Activate with sequential context
  const testContext = config.capabilities.supportsActivation!.testContexts[0];
  // testContext.description = 'Sequential activation'
  // testContext.context = { strategy: 'sequential' }

  const result = await activateElementViaTool(
    context,
    config.type,
    ensemble.name,
    testContext.context
  );

  assertElementActivated(result);

  // Verify expected outcome
  // "Elements activate in order, each completing before next"
});
```

---

## Example Test Execution Traces

### Trace 1: Creating a Persona

**Command**:
```bash
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "Personas.*should create minimal"
```

**Execution Flow**:
```
1. Jest discovers test file
   ├─ Loads elementTypeRegistry.ts
   ├─ ELEMENT_TYPE_REGISTRY = [PERSONA_CONFIG, ...]
   └─ Sets up parameterized describe.each()

2. Test starts for PERSONA_CONFIG
   ├─ beforeAll() → setupTestServer()
   │   ├─ Creates temp portfolio directory
   │   ├─ Initializes MCP server
   │   ├─ Registers all tools
   │   └─ Returns TestServerContext (~500ms)
   │
   └─ Test: "should create minimal element"
       ├─ Generate test data
       │   └─ config.factory()
       │       └─ createPersonaTestData()
       │           └─ Returns {
       │                 name: 'Test Persona',
       │                 description: 'A test persona...',
       │                 content: 'You are helpful...',
       │                 metadata: { triggers: ['test'], ... }
       │               }
       │
       ├─ Call MCP tool
       │   └─ createElementViaTool(context, ElementType.PERSONA, persona)
       │       ├─ Calls MCP tool: createElement
       │       ├─ Arguments: { type: 'personas', name: 'Test Persona', ... }
       │       ├─ Server processes request
       │       │   ├─ Routes to ElementCRUDHandler
       │       │   ├─ Routes to PersonaManager.save()
       │       │   ├─ Validates persona data
       │       │   ├─ Writes YAML file to portfolio
       │       │   └─ Returns success response
       │       │
       │       └─ Returns MCP result (~50ms)
       │
       └─ Assert success
           └─ assertElementCreated(result, persona)
               ├─ Checks result.content[0].text contains '✅'
               ├─ Checks text contains 'created|success'
               ├─ Checks text contains 'Test Persona'
               └─ All checks pass → Test PASSES ✅ (~100ms total)
```

**Output**:
```
PASS  tests/integration/crud/ElementCRUD.test.ts (5.2s)
  CRUD+Activate Operations: Personas
    CREATE Operations
      ✓ should create minimal element (152ms)

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Time:        5.234s
```

### Trace 2: Activating an Ensemble (Multi-Capability)

**Command**:
```bash
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "Ensembles.*should activate.*sequential"
```

**Execution Flow**:
```
1. Test: "ACTIVATE: should activate with sequential strategy"
   │
   ├─ Check capability
   │   └─ hasActivationSupport(ENSEMBLE_CONFIG)
   │       └─ Returns true ✅
   │
   ├─ Create nested elements first
   │   ├─ Create persona: 'helper-persona'
   │   │   └─ createElementViaTool(context, PERSONA, persona)
   │   │       └─ Success ✅ (~50ms)
   │   │
   │   └─ Create skill: 'code-skill'
   │       └─ createElementViaTool(context, SKILL, skill)
   │           └─ Success ✅ (~50ms)
   │
   ├─ Create ensemble referencing them
   │   └─ ensemble.metadata.elements = [
   │         { name: 'helper-persona', type: PERSONA, order: 1 },
   │         { name: 'code-skill', type: SKILL, order: 2 }
   │       ]
   │   └─ createElementViaTool(context, ENSEMBLE, ensemble)
   │       ├─ Server validates:
   │       │   ├─ Nested elements exist ✅
   │       │   ├─ Nesting depth within limit ✅
   │       │   ├─ No circular references ✅
   │       │   └─ Types are allowed ✅
   │       │
   │       └─ Success ✅ (~80ms)
   │
   ├─ Activate ensemble
   │   └─ activateElementViaTool(context, ENSEMBLE, 'test-ensemble', {
   │         strategy: 'sequential'
   │       })
   │       ├─ Server orchestrates activation:
   │       │   ├─ Loads ensemble definition
   │       │   ├─ Reads metadata.elements array
   │       │   ├─ For each element in order:
   │       │   │   ├─ Activate 'helper-persona' (PERSONA)
   │       │   │   │   └─ Changes AI behavior ✅ (~60ms)
   │       │   │   │
   │       │   │   └─ Activate 'code-skill' (SKILL)
   │       │   │       └─ Enables skill capability ✅ (~60ms)
   │       │   │
   │       │   └─ All activations complete
   │       │
   │       └─ Returns success ✅ (~180ms total)
   │
   └─ Assert activation
       └─ assertElementActivated(result)
           ├─ Checks for 'activated|active|enabled'
           ├─ Verifies multi-element outcome
           └─ Test PASSES ✅ (~400ms total)
```

**Output**:
```
PASS  tests/integration/crud/ElementCRUD.test.ts (8.7s)
  CRUD+Activate Operations: Ensembles
    ACTIVATE Operations
      ✓ should activate with sequential strategy (387ms)

Test Suites: 1 passed, 1 total
Tests:       1 passed, 1 total
Time:        8.712s
```

---

## Debugging Scenarios

### Scenario 1: Test Fails - "Element Not Found"

**Symptom**:
```
❌ should retrieve element details
Error: Element 'test-persona-abc123' not found

Expected: Element details
Received: Error response
```

**Debugging Steps**:

**Step 1: Check if element was created**
```typescript
it('should retrieve element details', async () => {
  // Add debug logging
  console.log('Creating element...');
  const persona = config.factory();
  console.log('Element data:', JSON.stringify(persona, null, 2));

  const createResult = await createElementViaTool(context, config.type, persona);
  console.log('Create result:', createResult);

  // Verify creation succeeded
  expect(createResult.isError).toBe(false);
  assertElementCreated(createResult, persona);

  console.log('Retrieving element...');
  const result = await getElementDetailsViaTool(context, config.type, persona.name);
  console.log('Retrieve result:', result);

  assertElementRetrieved(result, persona);
});
```

**Step 2: Check element naming**
```typescript
// Problem: Element names with special characters may fail
const persona = config.factory({ name: 'test-persona-🎭' });  // ❌ Emoji might not work

// Solution: Use safe names
const persona = config.factory({ name: 'test-persona-abc' });  // ✅ Safe
```

**Step 3: Check test cleanup**
```typescript
// Problem: Previous test might have deleted the element
afterEach(async () => {
  console.log('Cleanup running...');
  // Only delete if test created it
  if (testElementCreated) {
    await deleteElementViaTool(context, config.type, testElementName);
  }
});
```

**Step 4: Check portfolio path**
```typescript
// Problem: Element might be in wrong directory
console.log('Portfolio path:', context.portfolioPath);
console.log('Element type:', config.type);
console.log('Expected file:', path.join(context.portfolioPath, config.type, `${persona.name}.yaml`));

// Check if file exists
const fs = require('fs/promises');
const filePath = path.join(context.portfolioPath, config.type, `${persona.name}.yaml`);
const exists = await fs.access(filePath).then(() => true).catch(() => false);
console.log('File exists:', exists);
```

### Scenario 2: Validation Test Fails - Wrong Error Message

**Symptom**:
```
❌ should reject invalid element
Expected error to match: /required/
Actual error: "Field 'content' must be provided"
```

**Debugging**:

**Step 1: Check actual error message**
```typescript
it('should reject invalid element', async () => {
  const invalid = config.invalidExamples[0];

  const result = await createElementViaTool(context, config.type, invalid.data);

  // Debug: Print actual error
  console.log('Error message:', result.content[0].text);
  console.log('Expected pattern:', invalid.expectedError);

  assertOperationFailed(result, invalid.expectedError);
});
```

**Output**:
```
Error message: Field 'content' must be provided
Expected pattern: required
```

**Step 2: Update expected error to match actual**
```typescript
// Before
invalidExamples: [
  {
    data: { name: 'Test', description: 'Test', content: '' },
    expectedError: 'required'  // Too strict
  }
]

// After
invalidExamples: [
  {
    data: { name: 'Test', description: 'Test', content: '' },
    expectedError: 'must be provided|required'  // Flexible regex
  }
]
```

### Scenario 3: Capability Test Skipped Unexpectedly

**Symptom**:
```
Test suite: 40 tests
Expected activation tests: 10
Actual activation tests: 0

Why were activation tests skipped?
```

**Debugging**:

**Step 1: Check capability definition**
```typescript
// In config file
capabilities: {
  supportsActivation: {  // ✅ Defined
    activationStrategy: 'behavior-change',
    // ...
  }
}

// vs

capabilities: {
  supportsActivation: undefined  // ❌ Not defined - tests will skip!
}
```

**Step 2: Check capability detection**
```typescript
it('debug capability detection', () => {
  console.log('Config:', config.displayName);
  console.log('Capabilities:', config.capabilities);
  console.log('Has activation?', hasActivationSupport(config));
  console.log('Activation config:', getActivationConfig(config));
});
```

**Output**:
```
Config: Personas
Capabilities: { supportsActivation: { activationStrategy: 'behavior-change', ... } }
Has activation? true
Activation config: { activationStrategy: 'behavior-change', ... }
```

**Step 3: Check test condition**
```typescript
// Problem: Wrong function name
if (config.capabilities.activatable) {  // ❌ Wrong property name
  describe('ACTIVATE', () => { /* ... */ });
}

// Solution: Use capability detector
if (hasActivationSupport(config)) {  // ✅ Correct
  describe('ACTIVATE', () => { /* ... */ });
}
```

---

## Adding a Custom Element Type

### Example: Adding "Plugin" Element Type

**Scenario**: Add a new "Plugin" element type that:
- Can be activated (loads plugin code)
- Has a state file (plugin state)
- Can reference dependencies (other plugins)
- Cannot be nested

**Step-by-Step**:

**1. Define Element Type Enum** (in production code):
```typescript
// src/portfolio/types.ts
export enum ElementType {
  PERSONA = 'personas',
  SKILL = 'skills',
  TEMPLATE = 'templates',
  AGENT = 'agents',
  MEMORY = 'memories',
  ENSEMBLE = 'ensembles',
  PLUGIN = 'plugins'  // ← Add new type
}
```

**2. Create Config File**:
```typescript
// tests/integration/crud/config/pluginConfig.ts

import { ElementType } from '../../../../src/portfolio/types.js';
import { ElementTypeTestConfig, ElementData, ReferenceType } from './types.js';

function createPluginTestData(overrides?: Partial<ElementData>): ElementData {
  return {
    name: overrides?.name || 'Test Plugin',
    description: overrides?.description || 'A test plugin',
    metadata: {
      entryPoint: 'index.js',
      version: '1.0.0',
      dependencies: [],
      permissions: ['read', 'write'],
      ...(overrides?.metadata || {})
    },
    ...overrides
  };
}

export const PLUGIN_CONFIG: ElementTypeTestConfig = {
  type: ElementType.PLUGIN,
  displayName: 'Plugins',
  factory: createPluginTestData,

  validExamples: [
    {
      name: 'Minimal Plugin',
      description: 'Minimal plugin',
      metadata: {
        entryPoint: 'index.js',
        version: '1.0.0'
      }
    }
  ],

  invalidExamples: [],

  requiredFields: ['name', 'description', 'metadata.entryPoint'],

  editableFields: [
    {
      path: 'description',
      displayName: 'Description',
      type: 'string',
      required: true,
      validValues: ['Updated description']
    },
    {
      path: 'metadata.version',
      displayName: 'Version',
      type: 'string',
      required: true,
      validValues: ['1.1.0', '2.0.0']
    }
  ],

  nestedFields: {},

  // Key part: Define capabilities!
  capabilities: {
    // Activation: Loads plugin code
    supportsActivation: {
      activationStrategy: 'execution',
      requiresContext: true,  // Needs plugin context
      expectedResultType: 'side-effect',
      testContexts: [
        {
          description: 'Load plugin',
          context: { env: 'test' },
          expectedOutcome: 'Plugin code loaded and initialized'
        }
      ]
    },

    // State file: Plugin maintains runtime state
    hasStateFile: {
      fileExtension: '.state.yaml',
      cleanupOnDelete: true
    },

    // References: Can depend on other plugins
    supportsReferences: {
      referenceTypes: [ReferenceType.DEPENDENCY],
      bidirectional: false,
      referenceField: 'metadata.dependencies'
    }

    // No nesting capability
  },

  validators: [
    {
      name: 'entryPoint-required',
      description: 'Entry point must be specified',
      validate: (data) => ({
        valid: Boolean(data.metadata?.entryPoint),
        message: 'Plugin entry point is required'
      }),
      severity: 'error'
    }
  ]
};
```

**3. Add to Registry**:
```typescript
// tests/integration/crud/config/elementTypeRegistry.ts

import { PLUGIN_CONFIG } from './pluginConfig.js';

export const ELEMENT_TYPE_REGISTRY: ElementTypeTestConfig[] = [
  PERSONA_CONFIG,
  SKILL_CONFIG,
  TEMPLATE_CONFIG,
  AGENT_CONFIG,
  MEMORY_CONFIG,
  ENSEMBLE_CONFIG,
  PLUGIN_CONFIG  // ← Add here
];
```

**4. Run Tests**:
```bash
npm test -- tests/integration/crud/ElementCRUD.test.ts -t "Plugins"
```

**5. Expected Results**:
```
PASS  tests/integration/crud/ElementCRUD.test.ts
  CRUD+Activate Operations: Plugins
    CREATE Operations
      ✓ should create minimal element
      ✓ should create complete element
      ✓ should reject invalid element
    UPDATE Operations
      ✓ should update description field
      ✓ should update version field
    DELETE Operations
      ✓ should delete element successfully
    VALIDATE Operations
      ✓ should validate correct element
      ✓ should detect missing entry point
    ACTIVATE Operations (supportsActivation defined)
      ✓ should activate plugin
      ✓ should load with context
      ✓ should handle activation failures
    STATE FILE Operations (hasStateFile defined)
      ✓ should create state file on first activation
      ✓ should persist state
      ✓ should cleanup state on delete
    REFERENCE Operations (supportsReferences defined)
      ✓ should resolve dependencies
      ✓ should detect missing dependencies

Test Suites: 1 passed, 1 total
Tests:       15 passed, 15 total  (automatically generated!)
```

**Tests Automatically Run**:
- 40+ universal CRUD tests
- 10+ activation tests (due to `supportsActivation`)
- 5+ state file tests (due to `hasStateFile`)
- 5+ reference tests (due to `supportsReferences`)

**Total**: ~60 tests for new type with ~200 lines of config!

---

## Common Patterns

### Pattern 1: Testing Optional Fields

```typescript
it('should handle missing optional field gracefully', async () => {
  // Create element WITHOUT optional field
  const minimal = config.factory();
  delete minimal.metadata.optionalField;

  const result = await createElementViaTool(context, config.type, minimal);

  // Should succeed
  assertElementCreated(result, minimal);

  // Retrieve and verify field is absent
  const details = await getElementDetailsViaTool(context, config.type, minimal.name);
  expect(details.metadata.optionalField).toBeUndefined();
});
```

### Pattern 2: Testing Field Updates

```typescript
it('should update nested metadata field', async () => {
  // Create element
  const element = config.factory({
    metadata: { someField: 'original-value' }
  });
  await createElementViaTool(context, config.type, element);

  // Update nested field
  const updateResult = await editElementViaTool(
    context,
    config.type,
    element.name,
    'metadata.someField',
    'new-value'
  );

  assertElementUpdated(updateResult, element, { metadata: { someField: 'new-value' } });

  // Verify update
  const details = await getElementDetailsViaTool(context, config.type, element.name);
  expect(details.metadata.someField).toBe('new-value');
});
```

### Pattern 3: Testing Capability Combinations

```typescript
// For types with BOTH activation AND nesting (like ensembles)
if (hasActivationSupport(config) && hasNestingSupport(config)) {
  it('should activate all nested elements', async () => {
    // Create nested elements
    const persona = PERSONA_CONFIG.factory({ name: 'nested-persona' });
    await createElementViaTool(context, ElementType.PERSONA, persona);

    // Create parent with nesting
    const parent = config.factory({
      metadata: {
        elements: [
          { name: 'nested-persona', type: ElementType.PERSONA, order: 1 }
        ]
      }
    });
    await createElementViaTool(context, config.type, parent);

    // Activate parent
    const result = await activateElementViaTool(context, config.type, parent.name);

    // Verify parent activated
    assertElementActivated(result);

    // Verify nested element also activated
    const nestedActive = await verifyElementActive(context, ElementType.PERSONA, 'nested-persona');
    expect(nestedActive).toBe(true);
  });
}
```

---

**Document Version**: 1.0.0
**Last Updated**: 2025-11-19
**Author**: DollhouseMCP Team
