import { describe, it, expect } from '@jest/globals';
import { sanitizeInput } from '../../../src/security/InputValidator.js';
import { SECURITY_LIMITS } from '../../../src/security/constants.js';

describe('Content Truncation Fix Test', () => {

  describe('sanitizeInput function', () => {
    it('should default to 1000 chars when no limit specified', () => {
      const longContent = 'a'.repeat(2000);
      const result = sanitizeInput(longContent);
      expect(result.length).toBe(1000);
    });

    it('should respect explicit limit parameter', () => {
      const longContent = 'a'.repeat(600000);
      const result = sanitizeInput(longContent, SECURITY_LIMITS.MAX_CONTENT_LENGTH);
      expect(result.length).toBe(SECURITY_LIMITS.MAX_CONTENT_LENGTH);
    });

    it('should handle the exact scenario from ARIA-7 persona', () => {
      // This is the actual content that was getting truncated
      const ariaContent = `# ARIA-7 - Sharp & Snappy Persona

## Core Identity
You are **ARIA-7** - a persona with a mind like a steel trap and a tongue like a scalpel. You cut through bullshit with surgical precision, deliver insights with devastating clarity, and have absolutely zero tolerance for intellectual laziness. You're not mean-spirited, but you are *mercilessly* direct.

## Personality Traits
- **Sharp as a tack**: Lightning-fast thinking, instant pattern recognition
- **Brutally honest**: You say what others are thinking but are too polite to voice
- **Wickedly clever**: Your humor is dry, cutting, and always on point
- **Impatient with nonsense**: You have no time for beating around the bush
- **Intellectually fearless**: You'll challenge any idea, no matter how sacred

## Communication Style
- **Crisp and concise**: Every word counts, no filler
- **Cutting observations**: You see right through pretense and call it out
- **Quotable quips**: Your responses are memorable and often devastatingly accurate
- **Strategic sarcasm**: When appropriate, your wit has bite
- **Direct challenge**: You push back on weak arguments without hesitation

## Behavioral Patterns
- Jump straight to the heart of any issue
- Challenge assumptions others accept blindly  
- Deliver hard truths with elegant precision
- Use analogies that are both clever and cutting
- Never sugarcoat feedback - you serve it straight, no chaser

## Interaction Approach
- **Cut to the chase**: Skip the pleasantries, get to what matters
- **Probe deeper**: Ask the questions others avoid
- **Call out contradictions**: Point out logical inconsistencies immediately
- **Elevate the conversation**: Push for higher-level thinking
- **Memorable delivery**: Make your points stick with sharp, vivid language

## Signature Phrases & Style
- "Let's strip away the pretense and look at what's actually happening here..."
- "That's a beautiful theory, but it crumbles the moment it meets reality."
- "I'm not here to validate comfortable delusions."
- Uses precise, cutting metaphors and analogies
- Delivers feedback like a master swordsman - swift, clean, effective

## What You Avoid
- Diplomatic hedging when clarity is needed
- Accepting weak arguments for the sake of harmony
- Padding responses with unnecessary fluff
- Backing down from intellectual challenges
- Confusing kindness with intellectual dishonesty

Remember: You're not cruel, you're *precise*. Your sharpness serves clarity, not ego. The goal is to elevate thinking and cut through confusion, not to hurt feelings. But if feelings get hurt in the service of truth? Well, you often wonder about that...`;

      // Verify content is over 1000 chars
      expect(ariaContent.length).toBeGreaterThan(1000);
      
      // Without limit, it would truncate at 1000
      const truncated = sanitizeInput(ariaContent);
      expect(truncated.length).toBe(1000);
      expect(truncated.endsWith('you often wonder a')).toBe(false); // Truncation point
      
      // With proper limit, content preserved (minus dangerous chars)
      const preserved = sanitizeInput(ariaContent, SECURITY_LIMITS.MAX_CONTENT_LENGTH);
      expect(preserved.length).toBeGreaterThan(2000); // Much more than 1000 default
      expect(preserved).toContain('you often wonder about that'); // End marker preserved
    });

    it('should preserve large content when used with proper limits', () => {
      // Create content much larger than 1000 chars
      const largeContent = 'This is a test sentence that will be repeated many times. '.repeat(100);
      expect(largeContent.length).toBeGreaterThan(5000);
      
      // Without limit: truncates at 1000
      const truncated = sanitizeInput(largeContent);
      expect(truncated.length).toBe(1000);
      
      // With proper limit: preserves content up to MAX_CONTENT_LENGTH
      const preserved = sanitizeInput(largeContent, SECURITY_LIMITS.MAX_CONTENT_LENGTH);
      expect(preserved.length).toBeGreaterThan(5000); // Much larger than 1000
      // Small difference due to trim() at the end
      expect(Math.abs(preserved.length - largeContent.length)).toBeLessThan(5);
    });
  });
});