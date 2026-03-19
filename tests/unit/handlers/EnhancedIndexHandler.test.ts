/**
 * Unit tests for EnhancedIndexHandler.
 *
 * Contract-based testing:
 * - Does it correctly handle valid inputs?
 * - Does it gracefully handle invalid or malicious inputs?
 * - Does it return data in the expected format?
 * - Does it call the underlying manager with the correct parameters?
 */
import { DollhouseContainer } from '../../../src/di/Container.js';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EnhancedIndexHandler } from '../../../src/handlers/EnhancedIndexHandler.js';
import type { EnhancedIndexManager } from '../../../src/portfolio/EnhancedIndexManager.js';
import { UnicodeValidator } from '../../../src/security/validators/unicodeValidator.js';

// Mock dependencies
jest.mock('../../../src/security/securityMonitor.js');
jest.mock('../../../src/security/validators/unicodeValidator.js');

describe('EnhancedIndexHandler Contract', () => {
  let handler: EnhancedIndexHandler;
  let mockIndexManager: jest.Mocked<EnhancedIndexManager>;
  let mockPersonaIndicatorService: any;
  let container: DollhouseContainer;

  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();

    // 1. Create a mock instance of the manager
    mockIndexManager = {
      getIndex: jest.fn(),
      getConnectedElements: jest.fn(),
      getElementRelationships: jest.fn(),
      getElementsByAction: jest.fn(),
      getRelationshipStats: jest.fn(),
    } as unknown as jest.Mocked<EnhancedIndexManager>;

    // 2. Create mock indicator service
    mockPersonaIndicatorService = {
      getPersonaIndicator: jest.fn().mockReturnValue('🤖'),
    };

    // 3. Create the container
    container = new DollhouseContainer();

    // 4. Pure DI - pass services directly to constructor
    handler = new EnhancedIndexHandler(
      mockIndexManager,
      mockPersonaIndicatorService
    );

    // Mock the getIndex method to resolve by default for all tests
    mockIndexManager.getIndex.mockResolvedValue({} as any);

    // Mock the UnicodeValidator's static normalize method
    (UnicodeValidator.normalize as jest.Mock) = jest.fn(input => ({
      isValid: true,
      normalizedContent: input,
    }));
  });

  afterEach(async () => {
    await container.dispose();
  });

  describe('findSimilarElements()', () => {
    it('should return a formatted list of similar elements for a valid request', async () => {
      const mockSimilarElements = new Map([
        ['skill/test-skill', { path: ['skill/test-skill'], totalStrength: 0.8, relationships: ['related_to'] }],
      ]);
      mockIndexManager.getConnectedElements.mockResolvedValue(mockSimilarElements);

      const result = await handler.findSimilarElements({
        elementName: 'my-element',
        limit: 5,
        threshold: 0.5,
      });

      const textContent = result.content[0].text;
      expect(textContent).toContain('🔍 **Similar Elements**');
      expect(textContent).toContain('**test-skill** (skill)');
      expect(textContent).toContain('Similarity: 80.0%');
      expect(mockIndexManager.getConnectedElements).toHaveBeenCalledWith(
        'my-element',
        expect.any(Object)
      );
    });

    it('should return a message when no similar elements are found', async () => {
      mockIndexManager.getConnectedElements.mockResolvedValue(new Map());

      const result = await handler.findSimilarElements({
        elementName: 'my-element',
        limit: 5,
        threshold: 0.5,
      });

      const textContent = result.content[0].text;
      expect(textContent).toContain('No similar elements found');
    });

    it('should reject invalid input, such as a missing elementName', async () => {
      const result = await handler.findSimilarElements({
        elementName: '',
        limit: 5,
        threshold: 0.5,
      });

      const textContent = result.content[0].text;
      expect(textContent).toContain('❌ Failed to find similar elements');
      expect(textContent).toContain('Element name is required');
    });
  });

  describe('getElementRelationships()', () => {
    it('should return a formatted list of relationships for a valid element', async () => {
      const mockRelationships = {
        uses: [{ element: 'skill/another-skill' }],
        depends_on: [{ element: 'template/base-template' }],
      };
      mockIndexManager.getElementRelationships.mockResolvedValue(mockRelationships);

      const result = await handler.getElementRelationships({
        elementName: 'my-element',
        elementType: 'agent',
      });

      const textContent = result.content[0].text;
      expect(textContent).toContain('🔗 **Element Relationships**');
      expect(textContent).toContain('**Uses (1)**');
      expect(textContent).toContain('**Depends_on (1)**');
      expect(textContent).toContain('another-skill');
      // Issue #749: element type is normalized to plural form for index lookup
      expect(mockIndexManager.getElementRelationships).toHaveBeenCalledWith('agents:my-element');
    });

    it('should return a message when no relationships are found', async () => {
      mockIndexManager.getElementRelationships.mockResolvedValue({});

      const result = await handler.getElementRelationships({
        elementName: 'my-element',
        elementType: 'agent',
      });

      const textContent = result.content[0].text;
      expect(textContent).toContain('No relationships found');
    });
  });

  describe('searchByVerb()', () => {
    it('should return a list of elements for a given action verb', async () => {
      mockIndexManager.getElementsByAction.mockResolvedValue(['skill/code-reviewer', 'agent/qa-agent']);

      const result = await handler.searchByVerb({ verb: 'review', limit: 5 });

      const textContent = result.content[0].text;
      expect(textContent).toContain('🎯 **Elements for Action: "review"**');
      expect(textContent).toContain('**code-reviewer** (skill)');
      expect(textContent).toContain('**qa-agent** (agent)');
      expect(mockIndexManager.getElementsByAction).toHaveBeenCalledWith('review');
    });
  });

  describe('getRelationshipStats()', () => {
    it('should return formatted statistics about the index', async () => {
      const mockStats = { uses: 10, depends_on: 5 };
      const mockIndex = {
        metadata: { version: '1.0', last_updated: new Date().toISOString(), total_elements: 50 },
        action_triggers: { create: ['template/new-doc'] },
      };
      mockIndexManager.getRelationshipStats.mockResolvedValue(mockStats);
      mockIndexManager.getIndex.mockResolvedValue(mockIndex as any);

      const result = await handler.getRelationshipStats();

      const textContent = result.content[0].text;
      expect(textContent).toContain('📊 **Enhanced Index Statistics**');
      expect(textContent).toContain('Total Elements: 50');
      expect(textContent).toContain('uses: 10');
      expect(textContent).toContain('Top Action Verbs:');
    });
  });
});
