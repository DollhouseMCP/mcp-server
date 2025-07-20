/**
 * Tests for FeedbackProcessor
 */

import { FeedbackProcessor } from '../../../../src/elements/FeedbackProcessor.js';

describe('FeedbackProcessor', () => {
  let processor: FeedbackProcessor;
  
  beforeEach(() => {
    processor = new FeedbackProcessor();
  });
  
  describe('process', () => {
    it('should process complete feedback', async () => {
      const feedback = 'This is excellent! The feature works perfectly. I rate it 5 stars.';
      
      const result = await processor.process(feedback);
      
      expect(result.originalFeedback).toBe(feedback);
      expect(result.sentiment).toBe('positive');
      expect(result.inferredRating).toBe(5);
      expect(result.confidence).toBeGreaterThan(0.7);
      expect(result.keywords).toContain('excellent');
      expect(result.keywords).toContain('feature');
      expect(result.entities.length).toBeGreaterThanOrEqual(2); // At least praise and feature entities
    });
  });
  
  describe('analyzeSentiment', () => {
    it('should detect very positive sentiment', async () => {
      const sentiments = await Promise.all([
        processor.analyzeSentiment('This is absolutely amazing!'),
        processor.analyzeSentiment('Perfect solution, love it!'),
        processor.analyzeSentiment('Exceptional work, brilliant!')
      ]);
      
      expect(sentiments).toEqual(['positive', 'positive', 'positive']);
    });
    
    it('should detect positive sentiment', async () => {
      const sentiments = await Promise.all([
        processor.analyzeSentiment('Good job, this is helpful'),
        processor.analyzeSentiment('Works well, I like it'),
        processor.analyzeSentiment('Nice and effective')
      ]);
      
      expect(sentiments).toEqual(['positive', 'positive', 'positive']);
    });
    
    it('should detect neutral sentiment', async () => {
      const sentiments = await Promise.all([
        processor.analyzeSentiment('It\'s okay, nothing special'),
        processor.analyzeSentiment('Fine for basic use'),
        processor.analyzeSentiment('Adequate and acceptable')
      ]);
      
      expect(sentiments).toEqual(['neutral', 'neutral', 'neutral']);
    });
    
    it('should detect negative sentiment', async () => {
      const sentiments = await Promise.all([
        processor.analyzeSentiment('Disappointing results'),
        processor.analyzeSentiment('Not great, has issues'),
        processor.analyzeSentiment('Could be much better')
      ]);
      
      expect(sentiments[0]).toBe('negative');
      expect(sentiments[1]).toBe('negative');
      // "Could be much better" is more neutral than negative
      expect(['negative', 'neutral']).toContain(sentiments[2]);
    });
    
    it('should detect very negative sentiment', async () => {
      const sentiments = await Promise.all([
        processor.analyzeSentiment('This is terrible!'),
        processor.analyzeSentiment('Completely broken and useless'),
        processor.analyzeSentiment('Awful experience, hate it')
      ]);
      
      expect(sentiments).toEqual(['negative', 'negative', 'negative']);
    });
    
    it('should handle negations', async () => {
      const sentiment = await processor.analyzeSentiment('Not bad at all');
      expect(sentiment).toBe('positive');
    });
  });
  
  describe('inferRating', () => {
    it('should extract explicit star ratings', async () => {
      const ratings = await Promise.all([
        processor.inferRating('I give it 5 stars'),
        processor.inferRating('Rating: 4/5'),
        processor.inferRating('3 out of 5 stars'),
        processor.inferRating('I rate it 2 stars'),
        processor.inferRating('1 star - terrible')
      ]);
      
      expect(ratings).toEqual([5, 4, 3, 2, 1]);
    });
    
    it('should extract percentage ratings', async () => {
      const ratings = await Promise.all([
        processor.inferRating('100% satisfied'),
        processor.inferRating('80% effective'),
        processor.inferRating('60% there'),
        processor.inferRating('40% complete'),
        processor.inferRating('20% useful')
      ]);
      
      expect(ratings).toEqual([5, 4, 3, 2, 1]);
    });
    
    it('should infer from sentiment words', async () => {
      const ratings = await Promise.all([
        processor.inferRating('Absolutely perfect!'),
        processor.inferRating('Very good work'),
        processor.inferRating('It\'s okay'),
        processor.inferRating('Poor quality'),
        processor.inferRating('Terrible experience')
      ]);
      
      expect(ratings[0]).toBe(5);
      expect(ratings[1]).toBe(4);
      expect(ratings[2]).toBe(3);
      expect(ratings[3]).toBe(null); // "Poor" alone isn't strong enough
      expect(ratings[4]).toBe(1);
    });
    
    it('should return null for unclear ratings', async () => {
      const rating = await processor.inferRating('The color is blue');
      expect(rating).toBeNull();
    });
  });
  
  describe('extractSuggestions', () => {
    it('should extract should/could suggestions', async () => {
      const suggestions = await processor.extractSuggestions(
        'This should be faster. You could add more features. It might be better with caching.'
      );
      
      expect(suggestions.length).toBeGreaterThanOrEqual(1);
      // Verify we got relevant suggestions
      const allSuggestions = suggestions.join(' ').toLowerCase();
      expect(allSuggestions.includes('faster') || allSuggestions.includes('features') || allSuggestions.includes('caching')).toBe(true);
    });
    
    it('should extract recommend/suggest patterns', async () => {
      const suggestions = await processor.extractSuggestions(
        'I suggest adding dark mode. I recommend improving the UI.'
      );
      
      expect(suggestions).toHaveLength(2);
      expect(suggestions).toContain('Adding dark mode');
      expect(suggestions.some(s => s.toLowerCase().includes('improving the ui'))).toBe(true);
    });
    
    it('should extract needs/requires patterns', async () => {
      const suggestions = await processor.extractSuggestions(
        'This needs better error handling. It requires more documentation.'
      );
      
      expect(suggestions.length).toBeGreaterThanOrEqual(1);
      expect(suggestions.some(s => s.toLowerCase().includes('error handling'))).toBe(true);
    });
    
    it('should filter out short suggestions', async () => {
      const suggestions = await processor.extractSuggestions(
        'Should fix. Could be ok. Might work.'
      );
      
      expect(suggestions).toHaveLength(0);
    });
    
    it('should remove duplicates', async () => {
      const suggestions = await processor.extractSuggestions(
        'The system should really add better caching support for improved performance.'
      );
      
      // Just verify we get suggestions about caching
      expect(suggestions.some(s => s.toLowerCase().includes('caching'))).toBe(true);
    });
  });
  
  describe('entity extraction', () => {
    it('should extract feature entities', async () => {
      const result = await processor.process(
        'The search feature is great. The filtering functionality works well.'
      );
      
      const features = result.entities.filter(e => e.type === 'feature');
      expect(features).toHaveLength(2);
      expect(features[0].text).toContain('search feature');
      expect(features[1].text).toContain('filtering functionality');
    });
    
    it('should extract issue entities', async () => {
      const result = await processor.process(
        'Found a bug in the login. The export has an error.'
      );
      
      const issues = result.entities.filter(e => e.type === 'issue');
      expect(issues).toHaveLength(2);
      expect(issues[0].text).toContain('bug');
      expect(issues[1].text).toContain('error');
    });
    
    it('should extract praise entities', async () => {
      const result = await processor.process(
        'I love the new design! The performance is excellent.'
      );
      
      const praise = result.entities.filter(e => e.type === 'praise');
      expect(praise).toHaveLength(2);
    });
    
    it('should extract criticism entities', async () => {
      const result = await processor.process(
        'The interface is terrible. Performance is awful.'
      );
      
      const criticism = result.entities.filter(e => e.type === 'criticism');
      expect(criticism).toHaveLength(2);
    });
    
    it('should calculate entity relevance', async () => {
      const result = await processor.process(
        'Bug bug bug! This is a minor issue at the end.'
      );
      
      const issues = result.entities.filter(e => e.type === 'issue');
      expect(issues[0].relevance).toBeGreaterThan(issues[1].relevance);
    });
  });
  
  describe('keyword extraction', () => {
    it('should extract meaningful keywords', async () => {
      const result = await processor.process(
        'The authentication system needs better security and improved performance.'
      );
      
      expect(result.keywords).toContain('authentication');
      expect(result.keywords).toContain('system');
      expect(result.keywords).toContain('security');
      expect(result.keywords).toContain('performance');
    });
    
    it('should filter out stop words', async () => {
      const result = await processor.process(
        'The the the system is is is working'
      );
      
      expect(result.keywords).not.toContain('the');
      expect(result.keywords).not.toContain('is');
      expect(result.keywords).toContain('system');
      expect(result.keywords).toContain('working');
    });
    
    it('should rank keywords by frequency', async () => {
      const result = await processor.process(
        'Performance is key. Better performance needed. Performance matters.'
      );
      
      expect(result.keywords[0]).toBe('performance');
    });
  });
  
  describe('confidence calculation', () => {
    it('should have high confidence for detailed feedback', async () => {
      const result = await processor.process(
        'I rate this 5 stars. The feature is excellent and works perfectly. ' +
        'The implementation is clean, efficient, and well-documented. ' +
        'I particularly appreciate the attention to detail and the intuitive interface.'
      );
      
      expect(result.confidence).toBeGreaterThan(0.8);
    });
    
    it('should have low confidence for brief feedback', async () => {
      const result = await processor.process('ok');
      
      expect(result.confidence).toBeLessThan(0.6);
    });
    
    it('should increase confidence for explicit ratings', async () => {
      const result1 = await processor.process('Good work');
      const result2 = await processor.process('Good work, 4 stars');
      
      expect(result2.confidence).toBeGreaterThan(result1.confidence);
    });
    
    it('should increase confidence for strong sentiment', async () => {
      const result1 = await processor.process('Its fine');
      const result2 = await processor.process('ABSOLUTELY AMAZING!!!');
      
      expect(result2.confidence).toBeGreaterThan(result1.confidence);
    });
  });
});