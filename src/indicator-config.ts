/**
 * Configuration for persona active indicator system
 */

export interface IndicatorConfig {
  // Whether to show the indicator at all
  enabled: boolean;
  
  // Format style: 'full', 'minimal', 'compact', 'custom'
  style: 'full' | 'minimal' | 'compact' | 'custom';
  
  // Custom format template (used when style is 'custom')
  // Available placeholders: {emoji}, {name}, {version}, {author}, {category}
  customFormat?: string;
  
  // Whether to include specific elements
  showEmoji: boolean;
  showName: boolean;
  showVersion: boolean;
  showAuthor: boolean;
  showCategory: boolean;
  
  // Separator between indicator and response
  separator: string;
  
  // Emoji to use (defaults to 🎭)
  emoji: string;
  
  // Bracket style: 'square', 'round', 'curly', 'angle', 'none'
  bracketStyle: 'square' | 'round' | 'curly' | 'angle' | 'none';
}

// Default configuration
export const DEFAULT_INDICATOR_CONFIG: IndicatorConfig = {
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

// Predefined styles
export const INDICATOR_STYLES = {
  full: '[{emoji} {name} v{version} by {author}]',
  minimal: '{emoji} {name}',
  compact: '[{name} v{version}]',
  custom: '{customFormat}'
};

// Bracket mappings
export const BRACKETS = {
  square: { open: '[', close: ']' },
  round: { open: '(', close: ')' },
  curly: { open: '{', close: '}' },
  angle: { open: '<', close: '>' },
  none: { open: '', close: '' }
};

/**
 * Load indicator configuration from environment or use defaults
 */
export function loadIndicatorConfig(): IndicatorConfig {
  const config = { ...DEFAULT_INDICATOR_CONFIG };
  
  // Check environment variables for overrides
  if (process.env.DOLLHOUSE_INDICATOR_ENABLED !== undefined) {
    config.enabled = process.env.DOLLHOUSE_INDICATOR_ENABLED === 'true';
  }
  
  if (process.env.DOLLHOUSE_INDICATOR_STYLE) {
    config.style = process.env.DOLLHOUSE_INDICATOR_STYLE as any;
  }
  
  if (process.env.DOLLHOUSE_INDICATOR_FORMAT) {
    config.customFormat = process.env.DOLLHOUSE_INDICATOR_FORMAT;
    config.style = 'custom';
  }
  
  if (process.env.DOLLHOUSE_INDICATOR_EMOJI) {
    config.emoji = process.env.DOLLHOUSE_INDICATOR_EMOJI;
  }
  
  if (process.env.DOLLHOUSE_INDICATOR_BRACKETS) {
    config.bracketStyle = process.env.DOLLHOUSE_INDICATOR_BRACKETS as any;
  }
  
  // Parse show flags from environment
  if (process.env.DOLLHOUSE_INDICATOR_SHOW_VERSION !== undefined) {
    config.showVersion = process.env.DOLLHOUSE_INDICATOR_SHOW_VERSION === 'true';
  }
  
  if (process.env.DOLLHOUSE_INDICATOR_SHOW_AUTHOR !== undefined) {
    config.showAuthor = process.env.DOLLHOUSE_INDICATOR_SHOW_AUTHOR === 'true';
  }
  
  if (process.env.DOLLHOUSE_INDICATOR_SHOW_CATEGORY !== undefined) {
    config.showCategory = process.env.DOLLHOUSE_INDICATOR_SHOW_CATEGORY === 'true';
  }
  
  return config;
}

/**
 * Format the indicator based on configuration and persona metadata
 */
export function formatIndicator(
  config: IndicatorConfig,
  metadata: {
    name: string;
    version?: string;
    author?: string;
    category?: string;
  }
): string {
  if (!config.enabled) {
    return '';
  }
  
  // Get the format template based on style
  let template = INDICATOR_STYLES[config.style];
  if (config.style === 'custom' && config.customFormat) {
    template = config.customFormat;
  }
  
  // Replace placeholders with values or empty strings
  let result = template
    .replace('{emoji}', config.showEmoji ? config.emoji : '')
    .replace('{name}', config.showName ? metadata.name : '')
    .replace('{version}', config.showVersion && metadata.version ? metadata.version : '')
    .replace('{author}', config.showAuthor && metadata.author ? metadata.author : '')
    .replace('{category}', config.showCategory && metadata.category ? metadata.category : '');
  
  // Clean up the format string
  // Remove "v" if no version follows it
  if (!config.showVersion || !metadata.version) {
    result = result.replace(/\sv(?=\s|]|\)|>|}|$)/, '');
  }
  // Remove "by" if no author follows it
  if (!config.showAuthor || !metadata.author) {
    result = result.replace(/\sby(?=\s|]|\)|>|}|$)/, '');
  }
  // Clean up extra spaces
  result = result.replace(/\s+/g, ' ').trim();
  
  // Apply brackets based on the template format (only if template doesn't already have them)
  if (result && config.style !== 'custom') {
    // Check if the template already includes brackets
    const templateHasBrackets = template.includes('[') || template.includes(']') || 
                               template.includes('(') || template.includes(')') ||
                               template.includes('{') || template.includes('}') ||
                               template.includes('<') || template.includes('>');
    
    if (!templateHasBrackets) {
      const brackets = BRACKETS[config.bracketStyle];
      if (brackets.open || brackets.close) {
        result = `${brackets.open}${result}${brackets.close}`;
      }
    }
  }
  
  // Add separator if we have content
  if (result) {
    result += config.separator;
  }
  
  return result;
}