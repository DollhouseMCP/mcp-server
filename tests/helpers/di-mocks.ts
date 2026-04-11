/**
 * Dependency Injection Mock Utilities
 *
 * Provides reusable mock factories for services used in DI pattern.
 * Makes it easy to create consistent mocks across all test files.
 *
 * Usage:
 * ```typescript
 * import { createMockPersonaManager, createMockPersonaIndicatorService } from '../helpers/di-mocks';
 *
 * const mockPersonaManager = createMockPersonaManager();
 * const mockPersonaIndicatorService = createMockPersonaIndicatorService();
 * const handler = new PersonaHandler(mockPersonaManager, ..., mockPersonaIndicatorService);
 * ```
 */

// This file intentionally uses the `?? new Service()` pattern for test factories.
// Test helpers need to create default instances when no override is provided.
// This is the correct pattern for test builders, not production DI code.

import { jest } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';

// Real service imports for integration test factories
import { FileLockManager } from '../../src/security/fileLockManager.js';
import { FileOperationsService } from '../../src/services/FileOperationsService.js';
import { PortfolioManager } from '../../src/portfolio/PortfolioManager.js';
import { SerializationService } from '../../src/services/SerializationService.js';
import { TriggerValidationService } from '../../src/services/validation/TriggerValidationService.js';
import { ValidationService } from '../../src/services/validation/ValidationService.js';
import { ValidationRegistry } from '../../src/services/validation/ValidationRegistry.js';
import { MetadataService } from '../../src/services/MetadataService.js';
import { SkillManager } from '../../src/elements/skills/SkillManager.js';
import { TemplateManager } from '../../src/elements/templates/TemplateManager.js';
import { AgentManager } from '../../src/elements/agents/AgentManager.js';
import { MemoryManager } from '../../src/elements/memories/MemoryManager.js';
import { EnsembleManager } from '../../src/elements/ensembles/EnsembleManager.js';
import { PersonaManager } from '../../src/persona/PersonaManager.js';
import { FileWatchService } from '../../src/services/FileWatchService.js';
import { TokenManager } from '../../src/security/tokenManager.js';
import { PortfolioRepoManager } from '../../src/portfolio/PortfolioRepoManager.js';
import type { IndicatorConfig } from '../../src/config/indicator-config.js';
import type { PersonaImporter } from '../../src/persona/export-import/PersonaImporter.js';
import type { StateChangeNotifier } from '../../src/services/StateChangeNotifier.js';

/**
 * Create a real MetadataService for tests.
 * This is a simple, stateless service that doesn't need mocking in most cases.
 *
 * Usage:
 * ```typescript
 * const metadataService = createTestMetadataService();
 * const template = new Template({ name: 'Test' }, 'content', metadataService);
 * ```
 */
export function createTestMetadataService(): MetadataService {
  return new MetadataService();
}

/**
 * Create a mock PersonaManager with common methods
 */
export function createMockPersonaManager(overrides: Partial<any> = {}) {
  return {
    list: jest.fn().mockResolvedValue([]),
    find: jest.fn().mockResolvedValue(null),
    reload: jest.fn().mockResolvedValue(undefined),
    // v2: Use unified create() instead of createNewPersona
    create: jest.fn().mockResolvedValue({ metadata: { name: 'test-persona' } }),
    editExistingPersona: jest.fn().mockResolvedValue(undefined),
    exportElement: jest.fn().mockResolvedValue(undefined),
    importPersona: jest.fn().mockResolvedValue(undefined),
    validatePersona: jest.fn().mockResolvedValue({ isValid: true, errors: [], warnings: [] }),
    // v2: Use unified delete() instead of deletePersona
    delete: jest.fn().mockResolvedValue(undefined),
    getActivePersona: jest.fn().mockReturnValue(null),
    getActivePersonas: jest.fn().mockReturnValue([]),
    activatePersona: jest.fn().mockResolvedValue(undefined),
    deactivatePersona: jest.fn().mockResolvedValue(undefined),
    getCurrentUserForAttribution: jest.fn().mockReturnValue('test-user'),
    ...overrides
  };
}

/**
 * Create a mock InitializationService
 */
export function createMockInitializationService(overrides: Partial<any> = {}) {
  return {
    ensureInitialized: jest.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

/**
 * Create a mock PersonaIndicatorService
 */
export function createMockPersonaIndicatorService(indicator: string = '>>', overrides: Partial<any> = {}) {
  return {
    getPersonaIndicator: jest.fn().mockReturnValue(indicator),
    ...overrides
  };
}

/**
 * Create a mock PersonaExporter
 */
export function createMockPersonaExporter(overrides: Partial<any> = {}) {
  return {
    exportPersona: jest.fn().mockResolvedValue({ success: true, data: '' }),
    toBase64: jest.fn().mockReturnValue('base64data'),
    formatExportResult: jest.fn().mockReturnValue({ content: [{ type: 'text', text: 'Exported' }] }),
    exportBundle: jest.fn().mockResolvedValue({ success: true, personas: [] }),
    formatBundleResult: jest.fn().mockReturnValue({ content: [{ type: 'text', text: 'Bundle exported' }] }),
    ...overrides
  };
}

/**
 * Create a mock PersonaImporter
 */
export function createMockPersonaImporter(overrides: Partial<any> = {}) {
  return {
    importPersona: jest.fn().mockResolvedValue({ success: true, persona: null }),
    ...overrides
  };
}

/**
 * Create a mock TriggerValidationService
 */
export function createMockTriggerValidationService(overrides: Partial<any> = {}) {
  return {
    validateTriggers: jest.fn().mockReturnValue({
      validTriggers: [],
      rejectedTriggers: [],
      hasRejections: false,
      totalInput: 0,
      warnings: [],
    }),
    ...overrides,
  };
}

/**
 * Create a mock FileLockManager
 */
export function createMockFileLockManager(overrides: Partial<any> = {}) {
  return {
    acquireLock: jest.fn().mockResolvedValue(undefined),
    releaseLock: jest.fn().mockResolvedValue(undefined),
    atomicReadFile: jest.fn().mockResolvedValue(''),
    atomicWriteFile: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Create a mock FileOperationsService
 */
export function createMockFileOperationsService(overrides: Partial<any> = {}) {
  return {
    readFile: jest.fn().mockResolvedValue(''),
    readElementFile: jest.fn().mockResolvedValue(''),
    writeFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    createDirectory: jest.fn().mockResolvedValue(undefined),
    listDirectory: jest.fn().mockResolvedValue([]),
    listDirectoryWithTypes: jest.fn().mockResolvedValue([]),
    renameFile: jest.fn().mockResolvedValue(undefined),
    exists: jest.fn().mockResolvedValue(false),
    stat: jest.fn().mockResolvedValue({} as any),
    resolvePath: jest.fn().mockReturnValue(''),
    validatePath: jest.fn().mockReturnValue(true),
    createFileExclusive: jest.fn().mockResolvedValue(true),
    copyFile: jest.fn().mockResolvedValue(undefined),
    chmod: jest.fn().mockResolvedValue(undefined),
    appendFile: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/**
 * Create a mock SerializationService
 */
export function createMockSerializationService(overrides: Partial<any> = {}) {
  return {
    parsePureYaml: jest.fn().mockReturnValue({}),
    parseFrontmatter: jest.fn().mockReturnValue({ data: {}, content: '' }),
    parseAuto: jest.fn().mockReturnValue({ format: 'unknown', data: {} }),
    dumpYaml: jest.fn().mockReturnValue(''),
    createFrontmatter: jest.fn().mockReturnValue(''),
    parseJson: jest.fn().mockReturnValue({}),
    stringifyJson: jest.fn().mockReturnValue(''),
    cleanMetadata: jest.fn((metadata) => metadata), // Default to returning original metadata
    detectFormat: jest.fn().mockReturnValue('unknown'),
    hasFrontmatter: jest.fn().mockReturnValue(false),
    logSecurityEvent: jest.fn(),
    validateSize: jest.fn(),
    ...overrides,
  };
}

/**
 * Create a mock ValidationService
 */
export function createMockValidationService(overrides: Partial<any> = {}) {
  return {
    validateAndSanitizeInput: jest.fn().mockReturnValue({ isValid: true, sanitizedValue: 'test' }),
    validateMetadataField: jest.fn().mockReturnValue({ isValid: true, sanitizedValue: 'test' }),
    validateCategory: jest.fn().mockReturnValue({ isValid: true, sanitizedValue: 'test' }),
    validateUsername: jest.fn().mockReturnValue({ isValid: true, sanitizedValue: 'test' }),
    validateEmail: jest.fn().mockReturnValue({ isValid: true, sanitizedValue: 'test' }),
    normalizeUnicode: jest.fn().mockReturnValue({ isValid: true, normalizedContent: 'test' }),
    validateContent: jest.fn().mockReturnValue({ isValid: true, detectedPatterns: [] }),
    ...overrides,
  };
}

/**
 * Create a mock ValidationRegistry
 */
export function createMockValidationRegistry(overrides: Partial<any> = {}) {
  const mockValidator = {
    elementType: 'personas',
    validateCreate: jest.fn().mockResolvedValue({
      isValid: true,
      errors: [],
      warnings: [],
      suggestions: []
    }),
    validateEdit: jest.fn().mockResolvedValue({
      isValid: true,
      errors: [],
      warnings: []
    }),
    validateMetadata: jest.fn().mockResolvedValue({
      isValid: true,
      errors: [],
      warnings: []
    }),
    generateReport: jest.fn().mockResolvedValue({
      status: 'pass',
      summary: 'Validation passed',
      details: [],
      timestamp: new Date()
    })
  };

  return {
    getValidator: jest.fn().mockReturnValue(mockValidator),
    registerValidator: jest.fn(),
    hasSpecializedValidator: jest.fn().mockReturnValue(false),
    getRegisteredTypes: jest.fn().mockReturnValue([]),
    getValidationService: jest.fn().mockReturnValue(createMockValidationService()),
    getTriggerValidationService: jest.fn().mockReturnValue(createMockTriggerValidationService()),
    getMetadataService: jest.fn().mockReturnValue(createTestMetadataService()),
    ...overrides,
  };
}

/**
 * Create a mock TokenManager
 */
export function createMockTokenManager(overrides: Partial<any> = {}) {
  return {
    getGitHubToken: jest.fn().mockReturnValue(null),
    getGitHubTokenAsync: jest.fn().mockResolvedValue(null),
    validateTokenFormat: jest.fn().mockReturnValue(true),
    validateTokenScopes: jest.fn().mockResolvedValue({ isValid: true, scopes: ['public_repo'] }),
    getTokenType: jest.fn().mockReturnValue('Personal Access Token'),
    getTokenPrefix: jest.fn().mockReturnValue('ghp_...'),
    redactToken: jest.fn().mockReturnValue('[REDACTED]'),
    createSafeErrorMessage: jest.fn((msg: string) => msg),
    getRequiredScopes: jest.fn().mockReturnValue({ required: ['public_repo'] }),
    ensureTokenPermissions: jest.fn().mockResolvedValue({ isValid: true }),
    storeGitHubToken: jest.fn().mockResolvedValue(undefined),
    retrieveGitHubToken: jest.fn().mockResolvedValue(null),
    removeStoredToken: jest.fn().mockResolvedValue(undefined),
    resetTokenValidationLimiter: jest.fn(),
    ...overrides,
  };
}

/**
 * Create a mock FileWatchService
 */
export function createMockFileWatchService(overrides: Partial<any> = {}) {
  return {
    watchDirectory: jest.fn().mockReturnValue(() => {}), // Returns a no-op cleanup function
    ...overrides,
  };
}

/**
 * Create a mock StateAccessor for active persona
 */
export function createMockStateAccessor<T>(initialValue: T) {
  const state = { current: initialValue };
  return {
    get: () => state.current,
    set: (value: T) => { state.current = value; },
    state // Expose state for test assertions
  };
}

/**
 * Create a mock SkillManager
 */
export function createMockSkillManager(overrides: Partial<any> = {}) {
  return {
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue(undefined),
    validate: jest.fn().mockResolvedValue({ isValid: true, errors: [], warnings: [] }),
    ...overrides
  };
}

/**
 * Create a mock TemplateManager
 */
export function createMockTemplateManager(overrides: Partial<any> = {}) {
  return {
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue(undefined),
    validate: jest.fn().mockResolvedValue({ isValid: true, errors: [], warnings: [] }),
    render: jest.fn().mockResolvedValue('rendered content'),
    ...overrides
  };
}

/**
 * Create a mock AgentManager
 */
export function createMockAgentManager(overrides: Partial<any> = {}) {
  return {
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue({}),
    update: jest.fn().mockResolvedValue({}),
    delete: jest.fn().mockResolvedValue(undefined),
    validate: jest.fn().mockResolvedValue({ isValid: true, errors: [], warnings: [] }),
    execute: jest.fn().mockResolvedValue({}),
    ...overrides
  };
}

/**
 * Create a mock MemoryManager
 */
export function createMockMemoryManager(overrides: Partial<any> = {}) {
  return {
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
    search: jest.fn().mockResolvedValue([]),
    validate: jest.fn().mockResolvedValue({ isValid: true, errors: [], warnings: [] }),
    ...overrides
  };
}

/**
 * Create a mock PortfolioManager
 */
export function createMockPortfolioManager(overrides: Partial<any> = {}) {
  return {
    getElementDir: jest.fn().mockReturnValue(path.join(os.tmpdir(), 'portfolio')),
    getElementPath: jest.fn().mockImplementation((type: string, filename: string) => path.join(os.tmpdir(), 'portfolio', type, filename)),
    listElements: jest.fn().mockResolvedValue([]),
    getElement: jest.fn().mockResolvedValue(null),
    saveElement: jest.fn().mockResolvedValue(undefined),
    deleteElement: jest.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

/**
 * Create a mock CollectionBrowser
 */
export function createMockCollectionBrowser(overrides: Partial<any> = {}) {
  return {
    browse: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    getContent: jest.fn().mockResolvedValue(null),
    ...overrides
  };
}

/**
 * Create a mock CollectionSearch
 */
export function createMockCollectionSearch(overrides: Partial<any> = {}) {
  return {
    search: jest.fn().mockResolvedValue({ results: [], total: 0 }),
    searchEnhanced: jest.fn().mockResolvedValue({ results: [], total: 0 }),
    ...overrides
  };
}

/**
 * Create a mock GitHubAuthManager
 */
export function createMockGitHubAuthManager(overrides: Partial<any> = {}) {
  return {
    isAuthenticated: jest.fn().mockResolvedValue(false),
    setupAuth: jest.fn().mockResolvedValue({ success: true }),
    checkAuth: jest.fn().mockResolvedValue({ authenticated: false }),
    clearAuth: jest.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

/**
 * Create a mock OperationalTelemetry
 */
export function createMockOperationalTelemetry(overrides: Partial<any> = {}) {
  return {
    isEnabled: jest.fn().mockReturnValue(false),
    initialize: jest.fn().mockResolvedValue(undefined),
    recordAutoLoadMetrics: jest.fn().mockResolvedValue(undefined),
    shutdown: jest.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

/**
 * Create a complete set of mocks for handler testing
 */
export function createHandlerMocks() {
  return {
    personaManager: createMockPersonaManager(),
    personaExporter: createMockPersonaExporter(),
    personaImporter: createMockPersonaImporter(),
    initService: createMockInitializationService(),
    indicatorService: createMockPersonaIndicatorService(),
    skillManager: createMockSkillManager(),
    templateManager: createMockTemplateManager(),
    agentManager: createMockAgentManager(),
    memoryManager: createMockMemoryManager(),
    portfolioManager: createMockPortfolioManager(),
    collectionBrowser: createMockCollectionBrowser(),
    collectionSearch: createMockCollectionSearch(),
    githubAuthManager: createMockGitHubAuthManager(),
  };
}

// =============================================================================
// REAL MANAGER FACTORIES FOR INTEGRATION TESTS
// =============================================================================
// These factories create real manager instances with proper dependency injection.
// Use these in integration tests that need actual functionality rather than mocks.

/**
 * Common dependencies shared across all managers
 */
export interface CommonManagerDependencies {
  portfolioManager?: PortfolioManager;
  fileLockManager?: FileLockManager;
  fileOperationsService?: FileOperationsService;
  serializationService?: SerializationService;
  validationRegistry?: ValidationRegistry;
  fileWatchService?: FileWatchService;
  metadataService?: MetadataService;
}

/**
 * Create a real FileOperationsService for integration tests.
 * This service handles file operations with atomic locking.
 *
 * @param fileLockManager - Optional FileLockManager instance to use
 * @returns FileOperationsService instance
 */
export function createTestFileOperationsService(
  fileLockManager?: FileLockManager
): FileOperationsService {
  const lockManager = fileLockManager ?? new FileLockManager();
  return new FileOperationsService(lockManager);
}

/**
 * Create a real SkillManager for integration tests.
 *
 * @param portfolioDir - Root directory for the portfolio
 * @param overrides - Optional dependency overrides
 * @returns SkillManager instance
 */
export function createRealSkillManager(
  portfolioDir: string,
  overrides?: CommonManagerDependencies
): SkillManager {
  const fileLockManager = overrides?.fileLockManager ?? new FileLockManager();
  const fileOperations = overrides?.fileOperationsService ?? new FileOperationsService(fileLockManager);
  const portfolioManager = overrides?.portfolioManager ?? new PortfolioManager(fileOperations, { baseDir: portfolioDir });
  const serializationService = overrides?.serializationService ?? new SerializationService();
  const metadataService = overrides?.metadataService ?? new MetadataService();
  // Don't create FileWatchService by default - it holds open handles
  // Tests that need file watching can explicitly pass one in overrides
  const fileWatchService = overrides?.fileWatchService;
  const validationRegistry = overrides?.validationRegistry ?? new ValidationRegistry(
    new ValidationService(),
    new TriggerValidationService(),
    metadataService
  );

  return new SkillManager(
    portfolioManager,
    fileLockManager,
    fileOperations,
    validationRegistry,
    serializationService,
    metadataService,
    fileWatchService
  );
}

/**
 * Create a real TemplateManager for integration tests.
 *
 * @param portfolioDir - Root directory for the portfolio
 * @param overrides - Optional dependency overrides
 * @returns TemplateManager instance
 */
export function createRealTemplateManager(
  portfolioDir: string,
  overrides?: CommonManagerDependencies
): TemplateManager {
  const fileLockManager = overrides?.fileLockManager ?? new FileLockManager();
  const fileOperations = overrides?.fileOperationsService ?? new FileOperationsService(fileLockManager);
  const portfolioManager = overrides?.portfolioManager ?? new PortfolioManager(fileOperations, { baseDir: portfolioDir });
  const serializationService = overrides?.serializationService ?? new SerializationService();
  const metadataService = overrides?.metadataService ?? new MetadataService();
  // Don't create FileWatchService by default - it holds open handles
  const fileWatchService = overrides?.fileWatchService;
  const validationRegistry = overrides?.validationRegistry ?? new ValidationRegistry(
    new ValidationService(),
    new TriggerValidationService(),
    metadataService
  );

  return new TemplateManager(
    portfolioManager,
    fileLockManager,
    fileOperations,
    validationRegistry,
    serializationService,
    metadataService,
    fileWatchService
  );
}

/**
 * Create a real MemoryManager for integration tests.
 *
 * @param portfolioDir - Root directory for the portfolio
 * @param overrides - Optional dependency overrides
 * @returns MemoryManager instance
 */
export function createRealMemoryManager(
  portfolioDir: string,
  overrides?: CommonManagerDependencies
): MemoryManager {
  const fileLockManager = overrides?.fileLockManager ?? new FileLockManager();
  const fileOperations = overrides?.fileOperationsService ?? new FileOperationsService(fileLockManager);
  const portfolioManager = overrides?.portfolioManager ?? new PortfolioManager(fileOperations, { baseDir: portfolioDir });
  const serializationService = overrides?.serializationService ?? new SerializationService();
  const metadataService = overrides?.metadataService ?? new MetadataService();
  // Don't create FileWatchService by default - it holds open handles
  const fileWatchService = overrides?.fileWatchService;
  const validationRegistry = overrides?.validationRegistry ?? new ValidationRegistry(
    new ValidationService(),
    new TriggerValidationService(),
    metadataService
  );

  return new MemoryManager(
    portfolioManager,
    fileLockManager,
    fileOperations,
    validationRegistry,
    serializationService,
    metadataService,
    fileWatchService
  );
}

/**
 * Create a real EnsembleManager for integration tests.
 *
 * @param portfolioDir - Root directory for the portfolio
 * @param overrides - Optional dependency overrides
 * @returns EnsembleManager instance
 */
export function createRealEnsembleManager(
  portfolioDir: string,
  overrides?: CommonManagerDependencies
): EnsembleManager {
  const fileLockManager = overrides?.fileLockManager ?? new FileLockManager();
  const fileOperations = overrides?.fileOperationsService ?? new FileOperationsService(fileLockManager);
  const portfolioManager = overrides?.portfolioManager ?? new PortfolioManager(fileOperations, { baseDir: portfolioDir });
  const serializationService = overrides?.serializationService ?? new SerializationService();
  const metadataService = overrides?.metadataService ?? new MetadataService();
  // Don't create FileWatchService by default - it holds open handles
  const fileWatchService = overrides?.fileWatchService;
  const validationRegistry = overrides?.validationRegistry ?? new ValidationRegistry(
    new ValidationService(),
    new TriggerValidationService(),
    metadataService
  );

  return new EnsembleManager(
    portfolioManager,
    fileLockManager,
    fileOperations,
    validationRegistry,
    serializationService,
    metadataService,
    fileWatchService
  );
}

/**
 * AgentManager-specific dependency overrides
 */
export interface AgentManagerDependencies extends CommonManagerDependencies {
  metadataService?: MetadataService;
}

/**
 * Create a real AgentManager for integration tests.
 * Note: AgentManager requires a baseDir for state management.
 *
 * @param portfolioDir - Root directory for the portfolio
 * @param baseDir - Base directory for agent state (typically same as portfolioDir)
 * @param overrides - Optional dependency overrides
 * @returns AgentManager instance
 */
export function createRealAgentManager(
  portfolioDir: string,
  baseDir?: string,
  overrides?: AgentManagerDependencies
): AgentManager {
  const fileLockManager = overrides?.fileLockManager ?? new FileLockManager();
  const fileOperations = overrides?.fileOperationsService ?? new FileOperationsService(fileLockManager);
  const portfolioManager = overrides?.portfolioManager ?? new PortfolioManager(fileOperations, { baseDir: portfolioDir });
  const serializationService = overrides?.serializationService ?? new SerializationService();
  const metadataService = overrides?.metadataService ?? new MetadataService();
  // Don't create FileWatchService by default - it holds open handles
  const fileWatchService = overrides?.fileWatchService;
  const validationRegistry = overrides?.validationRegistry ?? new ValidationRegistry(
    new ValidationService(),
    new TriggerValidationService(),
    metadataService
  );

  // Use portfolioDir as baseDir if not specified
  const agentBaseDir = baseDir ?? portfolioDir;

  return new AgentManager(
    portfolioManager,
    fileLockManager,
    agentBaseDir,
    fileOperations,
    validationRegistry,
    serializationService,
    metadataService,
    fileWatchService
  );
}

/**
 * PersonaManager-specific dependency overrides
 */
export interface PersonaManagerDependencies extends CommonManagerDependencies {
  indicatorConfig?: IndicatorConfig;
  personaImporter?: PersonaImporter;
  notifier?: StateChangeNotifier;
}

/**
 * Create a real PersonaManager for integration tests.
 * PersonaManager has additional dependencies for indicators, import/export, and notifications.
 *
 * @param portfolioDir - Root directory for the portfolio
 * @param overrides - Optional dependency overrides
 * @returns PersonaManager instance
 */
export function createRealPersonaManager(
  portfolioDir: string,
  overrides?: PersonaManagerDependencies
): PersonaManager {
  const fileLockManager = overrides?.fileLockManager ?? new FileLockManager();
  const fileOperations = overrides?.fileOperationsService ?? new FileOperationsService(fileLockManager);
  const portfolioManager = overrides?.portfolioManager ?? new PortfolioManager(fileOperations, { baseDir: portfolioDir });
  const metadataService = overrides?.metadataService ?? new MetadataService();
  // Don't create FileWatchService by default - it holds open handles
  const fileWatchService = overrides?.fileWatchService;
  const validationRegistry = overrides?.validationRegistry ?? new ValidationRegistry(
    new ValidationService(),
    new TriggerValidationService(),
    metadataService
  );

  // Default indicator config - must match IndicatorConfig interface
  const indicatorConfig: IndicatorConfig = overrides?.indicatorConfig ?? {
    enabled: true,
    style: 'full',
    showEmoji: true,
    showName: true,
    showVersion: true,
    showAuthor: true,
    showCategory: false,
    separator: ' | ',
    emoji: '🎭',
    bracketStyle: 'square'
  };

  return new PersonaManager(
    portfolioManager,
    indicatorConfig,
    fileLockManager,
    fileOperations,
    validationRegistry,
    metadataService,
    overrides?.personaImporter,
    overrides?.notifier,
    undefined, // contextTracker — injected by DI container in production
    { fileWatchService } // baseOptions
  );
}

/**
 * Create a complete set of real managers sharing the same dependencies.
 * Useful for integration tests that need multiple managers working together.
 *
 * @param portfolioDir - Root directory for the portfolio
 * @returns Object containing all real managers and shared dependencies
 */
export function createRealManagerSuite(portfolioDir: string, options?: { enableFileWatcher?: boolean }) {
  // Create shared dependencies
  const fileLockManager = new FileLockManager();
  const fileOperationsService = new FileOperationsService(fileLockManager);
  const portfolioManager = new PortfolioManager(fileOperationsService, { baseDir: portfolioDir });
  const serializationService = new SerializationService();
  const metadataService = new MetadataService();
  // Only create FileWatchService if explicitly enabled - it holds open handles
  const fileWatchService = options?.enableFileWatcher ? new FileWatchService() : undefined;
  const validationRegistry = new ValidationRegistry(
    new ValidationService(),
    new TriggerValidationService(),
    metadataService
  );

  const sharedDeps: CommonManagerDependencies = {
    fileLockManager,
    fileOperationsService,
    portfolioManager,
    serializationService,
    validationRegistry,
    metadataService,
    fileWatchService
  };

  return {
    // Shared dependencies for test access
    fileLockManager,
    fileOperationsService,
    portfolioManager,
    serializationService,
    validationRegistry,
    metadataService,
    fileWatchService,

    // Real manager instances
    skillManager: createRealSkillManager(portfolioDir, sharedDeps),
    templateManager: createRealTemplateManager(portfolioDir, sharedDeps),
    memoryManager: createRealMemoryManager(portfolioDir, sharedDeps),
    ensembleManager: createRealEnsembleManager(portfolioDir, sharedDeps),
    agentManager: createRealAgentManager(portfolioDir, portfolioDir, sharedDeps),
    personaManager: createRealPersonaManager(portfolioDir, sharedDeps)
  };
}

/**
 * Create a real TokenManager for integration/e2e tests.
 * TokenManager handles GitHub token storage, retrieval, and validation.
 *
 * @param fileOperationsService - Optional FileOperationsService instance
 * @returns TokenManager instance
 */
export function createRealTokenManager(
  fileOperationsService?: FileOperationsService
): TokenManager {
  const fileLockManager = new FileLockManager();
  const fileOps = fileOperationsService ?? new FileOperationsService(fileLockManager);
  return new TokenManager(fileOps);
}

/**
 * Create a real PortfolioRepoManager for integration/e2e tests.
 * PortfolioRepoManager handles GitHub portfolio repository operations.
 *
 * @param tokenManager - Optional TokenManager instance (will create one if not provided)
 * @param repositoryName - Optional repository name override
 * @param fileOperationsService - Optional FileOperationsService for TokenManager creation
 * @returns PortfolioRepoManager instance
 */
export function createRealPortfolioRepoManager(
  tokenManager?: TokenManager,
  repositoryName?: string,
  fileOperationsService?: FileOperationsService
): PortfolioRepoManager {
  const tm = tokenManager ?? createRealTokenManager(fileOperationsService);
  return new PortfolioRepoManager(tm, repositoryName);
}

// Note: createRealDollhouseMCPServer has been moved to server-factory.ts
// to avoid importing src/index.ts (and its module-level side effects)
// in tests that don't need the full server.
// Import from '../helpers/server-factory.js' instead.

/**
 * TestableAgentManager - Exposes protected methods for testing
 *
 * This subclass provides test access to protected methods like saveAgentState()
 * that are intentionally not public for architectural reasons.
 *
 * @see Issue #123 - saveAgentState is protected to enforce save() as the only entry point
 */
import type { AgentState } from '../../src/elements/agents/types.js';

export class TestableAgentManager extends AgentManager {
  /**
   * Expose protected saveAgentState for testing edge cases
   * (version conflicts, size limits, corruption recovery)
   */
  public async exposedSaveAgentState(name: string, state: AgentState): Promise<number> {
    return this.saveAgentState(name, state);
  }
}
