import { ElementDefinitionBuilder } from './ElementDefinitionBuilder.js';
import { ActionTriggerExtractor, ActionTriggerExtractorContext } from './ActionTriggerExtractor.js';
import { TriggerMetricsTracker, TriggerMetricsTrackerOptions } from './TriggerMetricsTracker.js';
import { SemanticRelationshipService } from './SemanticRelationshipService.js';

export type ActionTriggerExtractorFactory = (context: ActionTriggerExtractorContext) => ActionTriggerExtractor;
export type TriggerMetricsTrackerFactory = (options: TriggerMetricsTrackerOptions) => TriggerMetricsTracker;

export interface EnhancedIndexHelpers {
  readonly elementDefinitionBuilder: ElementDefinitionBuilder;
  readonly semanticRelationshipService: SemanticRelationshipService;
  createActionTriggerExtractor(context: ActionTriggerExtractorContext): ActionTriggerExtractor;
  createTriggerMetricsTracker(options: TriggerMetricsTrackerOptions): TriggerMetricsTracker;
}

export class DefaultEnhancedIndexHelpers implements EnhancedIndexHelpers {
  public constructor(
    private readonly builder: ElementDefinitionBuilder,
    private readonly relationshipService: SemanticRelationshipService,
    private readonly actionTriggerExtractorFactory: ActionTriggerExtractorFactory,
    private readonly triggerMetricsTrackerFactory: TriggerMetricsTrackerFactory,
  ) {}

  public get elementDefinitionBuilder(): ElementDefinitionBuilder {
    return this.builder;
  }

  public get semanticRelationshipService(): SemanticRelationshipService {
    return this.relationshipService;
  }

  public createActionTriggerExtractor(context: ActionTriggerExtractorContext): ActionTriggerExtractor {
    return this.actionTriggerExtractorFactory(context);
  }

  public createTriggerMetricsTracker(options: TriggerMetricsTrackerOptions): TriggerMetricsTracker {
    return this.triggerMetricsTrackerFactory(options);
  }
}
