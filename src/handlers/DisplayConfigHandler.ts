/**
 * DisplayConfigHandler - Manages runtime indicator display preferences
 *
 * Handles session-scoped tweaks to persona indicator formatting such as:
 * - Enabling/disabling indicators
 * - Style selection (full/minimal/compact/custom)
 * - Visibility of version/author/category
 * - Emoji and bracket choices
 * - Custom format templates
 *
 * Uses dependency injection for all services:
 * - PersonaManager for persona state and operations
 * - InitializationService for setup tasks
 * - PersonaIndicatorService for persona indicator formatting
 *
 * FIX: DMCP-SEC-006 - Security audit suppression
 * This handler delegates configuration changes to PersonaIndicatorService.
 * Audit logging happens in PersonaIndicatorService.updateConfig().
 * @security-audit-suppress DMCP-SEC-006
 */

import {
  formatIndicator,
  validateCustomFormat,
  type IndicatorConfig,
} from '../config/indicator-config.js';
import { SecureErrorHandler } from '../security/errorHandler.js';
import { PersonaManager } from '../persona/PersonaManager.js';
import { InitializationService } from '../services/InitializationService.js';
import { PersonaIndicatorService } from '../services/PersonaIndicatorService.js';
import { SecurityMonitor } from '../security/securityMonitor.js';

const SAMPLE_PERSONA_METADATA = {
  name: 'Example Persona',
  version: '1.0',
  author: '@username',
  category: 'creative',
};

export class DisplayConfigHandler {
  constructor(
    private readonly personaManager: PersonaManager,
    private readonly initService: InitializationService,
    private readonly indicatorService: PersonaIndicatorService
  ) {}

  private async ensureInitialized(): Promise<void> {
    await this.initService.ensureInitialized();
  }

  private prefix(message: string): string {
    return `${this.indicatorService.getPersonaIndicator()}${message}`;
  }

  private cloneConfig(config: IndicatorConfig): IndicatorConfig {
    return { ...config };
  }

  private applyUpdates(
    baseConfig: IndicatorConfig,
    updates: Partial<IndicatorConfig>
  ): IndicatorConfig {
    const updated = this.cloneConfig(baseConfig);

    if (updates.enabled !== undefined) updated.enabled = updates.enabled;
    if (updates.style !== undefined) updated.style = updates.style;
    if (updates.showVersion !== undefined) updated.showVersion = updates.showVersion;
    if (updates.showAuthor !== undefined) updated.showAuthor = updates.showAuthor;
    if (updates.showCategory !== undefined) updated.showCategory = updates.showCategory;
    if (updates.emoji !== undefined) updated.emoji = updates.emoji;
    if (updates.bracketStyle !== undefined) updated.bracketStyle = updates.bracketStyle;
    if (updates.separator !== undefined) updated.separator = updates.separator;
    if (updates.showEmoji !== undefined) updated.showEmoji = updates.showEmoji;
    if (updates.showName !== undefined) updated.showName = updates.showName;

    if (updates.customFormat !== undefined) {
      updated.customFormat = updates.customFormat;
    }

    return updated;
  }

  private buildExampleIndicator(config: IndicatorConfig): string {
    const activePersona = this.personaManager.getActivePersona();
    if (activePersona) {
      return formatIndicator(config, {
        name: activePersona.metadata.name,
        version: activePersona.metadata.version,
        author: activePersona.metadata.author,
        category: activePersona.metadata.category,
      });
    }

    return formatIndicator(config, SAMPLE_PERSONA_METADATA);
  }

  private formatConfigureSuccess(config: IndicatorConfig, example: string): string {
    return `✅ Indicator configuration updated successfully!

Current settings:
- Enabled: ${config.enabled}
- Style: ${config.style}
- Show Version: ${config.showVersion}
- Show Author: ${config.showAuthor}
- Show Category: ${config.showCategory}
- Emoji: ${config.emoji}
- Brackets: ${config.bracketStyle}
${config.customFormat ? `- Custom Format: ${config.customFormat}\n` : ''}Example indicator: ${example || '(none - indicators disabled)'}

Note: Configuration is temporary for this session. To make permanent, set environment variables:
- DOLLHOUSE_INDICATOR_ENABLED=true/false
- DOLLHOUSE_INDICATOR_STYLE=full/minimal/compact/custom
- DOLLHOUSE_INDICATOR_FORMAT="custom format template"
- DOLLHOUSE_INDICATOR_SHOW_VERSION=true/false
- DOLLHOUSE_INDICATOR_SHOW_AUTHOR=true/false
- DOLLHOUSE_INDICATOR_SHOW_CATEGORY=true/false
- DOLLHOUSE_INDICATOR_EMOJI=🎭
- DOLLHOUSE_INDICATOR_BRACKETS=square/round/curly/angle/none`;
  }

  private formatConfigReport(config: IndicatorConfig, example: string): string {
    return `📊 Current Indicator Configuration:

Settings:
- Enabled: ${config.enabled}
- Style: ${config.style}
- Show Version: ${config.showVersion}
- Show Author: ${config.showAuthor}
- Show Category: ${config.showCategory}
- Emoji: ${config.emoji}
- Brackets: ${config.bracketStyle}
- Separator: "${config.separator}"
${config.customFormat ? `- Custom Format: ${config.customFormat}\n` : ''}
Available styles:
- full: [🎭 Persona Name v1.0 by @author]
- minimal: 🎭 Persona Name
- compact: [Persona Name v1.0]
- custom: Use your own format with placeholders

Example with current settings: ${example || '(none - indicators disabled)'}

Placeholders for custom format:
- {emoji} - The configured emoji
- {name} - Persona name
- {version} - Persona version
- {author} - Persona author
- {category} - Persona category`;
  }

  /**
   * Configure indicator settings (runtime-only)
   */
  async configureIndicator(config: Partial<IndicatorConfig>) {
    await this.ensureInitialized();

    try {
      if (config.customFormat !== undefined) {
        const validation = validateCustomFormat(config.customFormat);
        if (!validation.valid) {
          return {
            content: [
              {
                type: 'text' as const,
                text: this.prefix(`❌ Invalid custom format: ${validation.error}`),
              },
            ],
          };
        }
      }

      const baseConfig = this.personaManager.getIndicatorConfig();
      const updatedConfig = this.applyUpdates(baseConfig, config);

      this.personaManager.updateIndicatorConfig(updatedConfig);
      this.indicatorService.updateConfig(updatedConfig);

      // FIX: DMCP-SEC-006 - Add security audit logging for configuration changes
      SecurityMonitor.logSecurityEvent({
        type: 'CONFIG_UPDATED',
        severity: 'LOW',
        source: 'DisplayConfigHandler.configureIndicator',
        details: `Display indicator configuration updated: ${Object.keys(config).join(', ')}`,
        additionalData: {
          updatedFields: Object.keys(config),
          style: config.style,
          enabled: config.enabled,
        }
      });

      const exampleIndicator = this.buildExampleIndicator(updatedConfig);

      return {
        content: [
          {
            type: 'text' as const,
            text: this.prefix(this.formatConfigureSuccess(updatedConfig, exampleIndicator)),
          },
        ],
      };
    } catch (error) {
      const sanitized = SecureErrorHandler.sanitizeError(error);
      return {
        content: [
          {
            type: 'text' as const,
            text: this.prefix(`❌ Error configuring indicator: ${sanitized.message}`),
          },
        ],
      };
    }
  }

  /**
   * Retrieve current indicator configuration and preview example
   */
  async getIndicatorConfig() {
    await this.ensureInitialized();

    const currentConfig = this.personaManager.getIndicatorConfig();
    const exampleIndicator = this.buildExampleIndicator(currentConfig);

    return {
      content: [
        {
          type: 'text' as const,
          text: this.prefix(this.formatConfigReport(currentConfig, exampleIndicator)),
        },
      ],
    };
  }
}

