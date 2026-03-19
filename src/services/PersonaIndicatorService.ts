import { IndicatorConfig, formatIndicator } from '../config/indicator-config.js';
import { PersonaManager } from '../persona/PersonaManager.js';
import {
  StateChangeNotifier,
  type PersonaStateChangeEvent,
} from './StateChangeNotifier.js';
import { ElementEventDispatcher, type ElementEventPayload } from '../events/ElementEventDispatcher.js';
import { ElementType } from '../portfolio/types.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

/**
 * SOURCE OF TRUTH for persona indicator formatting. Mirrors the
 * HandlerContext.getPersonaIndicator responsibility so handlers can rely on
 * explicit constructor injection instead of the service locator pattern.
 */
export class PersonaIndicatorService {
  private cachedIndicator: string | null = null;
  private cachedPersonaId: string | null = null;
  private readonly boundListener?: (event: PersonaStateChangeEvent) => void;
  private readonly boundElementListener?: (payload: ElementEventPayload) => void;
  private readonly elementUnsubscribes: Array<() => void> = [];
  private fallbackProvider?: () => string;

  constructor(
    private personaManager: PersonaManager,
    private indicatorConfig: IndicatorConfig,
    private notifier?: StateChangeNotifier,
    private eventDispatcher?: ElementEventDispatcher
  ) {
    if (this.notifier) {
      this.boundListener = this.handlePersonaChange.bind(this);
      this.notifier.on('state-change:persona-activated', this.boundListener);
      this.notifier.on('state-change:persona-deactivated', this.boundListener);
      this.notifier.on('state-change:user-changed', this.boundListener);
    }

    if (this.eventDispatcher) {
      this.boundElementListener = this.handleElementEvent.bind(this);
      this.elementUnsubscribes.push(
        this.eventDispatcher.on('element:activate', this.boundElementListener),
        this.eventDispatcher.on('element:deactivate', this.boundElementListener)
      );
    }
  }

  getPersonaIndicator(): string {
    const persona = this.personaManager.getActivePersona();

    if (!persona) {
      return this.fallbackProvider ? this.fallbackProvider() : '';
    }

    if (this.cachedIndicator !== null && this.cachedPersonaId === persona.filename) {
      return this.cachedIndicator;
    }

    const indicator = formatIndicator(this.indicatorConfig, {
      name: persona.metadata.name,
      version: persona.metadata.version,
      author: persona.metadata.author,
      category: persona.metadata.category,
    });

    this.cachedIndicator = indicator;
    this.cachedPersonaId = persona.filename;
    return indicator;
  }

  /**
   * Get the current indicator configuration.
   * Used by ConfigHandler to read current settings before applying updates.
   *
   * @returns Current IndicatorConfig
   */
  getConfig(): IndicatorConfig {
    return { ...this.indicatorConfig };
  }

  updateConfig(config: IndicatorConfig): void {
    // FIX: DMCP-SEC-006 - Add security audit logging for configuration changes
    SecurityMonitor.logSecurityEvent({
      type: 'CONFIG_UPDATED',
      severity: 'LOW',
      source: 'PersonaIndicatorService.updateConfig',
      details: `Indicator configuration updated: style=${config.style}, enabled=${config.enabled}`,
      additionalData: {
        style: config.style,
        enabled: config.enabled,
        showVersion: config.showVersion,
        showAuthor: config.showAuthor
      }
    });

    this.indicatorConfig = config;
    this.invalidateCache();
  }

  setFallbackProvider(provider?: () => string): void {
    this.fallbackProvider = provider;
    this.invalidateCache();
  }

  invalidateCache(): void {
    this.cachedIndicator = null;
    this.cachedPersonaId = null;
  }

  async dispose(): Promise<void> {
    if (this.boundListener && this.notifier) {
      this.notifier.off('state-change:persona-activated', this.boundListener);
      this.notifier.off('state-change:persona-deactivated', this.boundListener);
      this.notifier.off('state-change:user-changed', this.boundListener);
    }
    while (this.elementUnsubscribes.length > 0) {
      const unsubscribe = this.elementUnsubscribes.pop();
      if (unsubscribe) {
        unsubscribe();
      }
    }
    this.invalidateCache();
  }

  private handlePersonaChange(_event: PersonaStateChangeEvent): void {
    this.invalidateCache();
  }

  private handleElementEvent(payload: ElementEventPayload): void {
    if (payload.elementType !== ElementType.PERSONA) {
      return;
    }
    this.invalidateCache();
  }
}
