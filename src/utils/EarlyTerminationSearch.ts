/**
 * EarlyTerminationSearch - Utility for parallel searches with early termination
 * 
 * Optimizes search operations by terminating when exact matches are found,
 * while still providing comprehensive results for diagnostics.
 */

import { logger } from './logger.js';

export interface SearchResult<T> {
  success: boolean;
  result: T | null;
  error?: string;
}

export interface EarlyTerminationResult<T> {
  matches: T[];
  exactMatch?: T;
  totalSearches: number;
  completedSearches: number;
  failures: Array<{ index: number; error: string }>;
  earlyTerminationTriggered: boolean;
  performanceGain?: string;
}

export class EarlyTerminationSearch {
  /**
   * Perform parallel searches with early termination when exact match found
   * @param searches Array of search functions to execute
   * @param isExactMatch Function to determine if a result is an exact match
   * @param options Configuration options
   */
  static async executeWithEarlyTermination<T>(
    searches: Array<() => Promise<T | null>>,
    isExactMatch: (result: T) => boolean,
    options: {
      operationName: string;
      timeoutAfterExactMatch?: number; // ms to wait for other searches after exact match
      maxParallelSearches?: number; // limit concurrent searches
    } = { operationName: 'search' }
  ): Promise<EarlyTerminationResult<T>> {
    const {
      operationName,
      timeoutAfterExactMatch = 1000,
      maxParallelSearches = 10
    } = options;

    const startTime = Date.now();
    const results: EarlyTerminationResult<T> = {
      matches: [],
      totalSearches: searches.length,
      completedSearches: 0,
      failures: [],
      earlyTerminationTriggered: false
    };

    if (searches.length === 0) {
      logger.debug(`${operationName}: No searches to execute`);
      return results;
    }

    // Execute searches in batches if there are many
    const batches: Array<Array<() => Promise<T | null>>> = [];
    for (let i = 0; i < searches.length; i += maxParallelSearches) {
      batches.push(searches.slice(i, i + maxParallelSearches));
    }

    let exactMatchFound = false;
    let exactMatch: T | null = null;

    for (const batch of batches) {
      // Create promises for the current batch
      const batchPromises = batch.map(async (search, batchIndex) => {
        const globalIndex = batches.indexOf(batch) * maxParallelSearches + batchIndex;
        
        try {
          const result = await search();
          
          if (result) {
            // Check if this is an exact match
            if (!exactMatchFound && isExactMatch(result)) {
              exactMatchFound = true;
              exactMatch = result;
              
              logger.debug(`${operationName}: Exact match found at index ${globalIndex}`, {
                operationName,
                exactMatchIndex: globalIndex,
                timeToExactMatch: Date.now() - startTime
              });
            }
            
            return { success: true, result, index: globalIndex };
          }
          
          return { success: true, result: null, index: globalIndex };
        } catch (error: any) {
          return {
            success: false,
            result: null,
            error: error?.message || String(error),
            index: globalIndex
          };
        }
      });

      // If we found an exact match in a previous batch, use timeout for remaining batches
      if (exactMatchFound && timeoutAfterExactMatch > 0) {
        logger.debug(`${operationName}: Using early termination timeout for remaining searches`, {
          operationName,
          timeoutMs: timeoutAfterExactMatch,
          remainingBatches: batches.length - batches.indexOf(batch)
        });

        try {
          // Race between batch completion and timeout
          const batchResults = await Promise.race([
            Promise.allSettled(batchPromises),
            new Promise<never>((_, reject) => {
              setTimeout(() => {
                reject(new Error('Early termination timeout'));
              }, timeoutAfterExactMatch);
            })
          ]);

          this.processBatchResults(batchResults, results);
        } catch (error: any) {
          if (error.message === 'Early termination timeout') {
            results.earlyTerminationTriggered = true;
            results.performanceGain = `Terminated early after exact match, saving ${searches.length - results.completedSearches} searches`;
            logger.info(`${operationName}: Early termination triggered`, {
              operationName,
              exactMatch: exactMatch ? 'found' : 'none',
              completedSearches: results.completedSearches,
              totalSearches: results.totalSearches,
              timeSaved: `${Date.now() - startTime}ms`
            });
            break;
          }
          throw error;
        }
      } else {
        // Normal execution without timeout
        const batchResults = await Promise.allSettled(batchPromises);
        this.processBatchResults(batchResults, results);
      }

      // If we found an exact match and this is the first batch, we can potentially terminate
      if (exactMatchFound && batches.indexOf(batch) === 0 && batches.length > 1) {
        logger.debug(`${operationName}: Considering early termination after first batch`, {
          operationName,
          exactMatchFound: true,
          remainingBatches: batches.length - 1
        });
        // Continue to next batch with timeout
      }
    }

    // Add exact match to results if found
    if (exactMatch) {
      results.exactMatch = exactMatch;
      // Ensure exact match is in matches array
      if (!results.matches.some(m => m === exactMatch)) {
        results.matches.unshift(exactMatch); // Put exact match first
      }
    }

    const totalTime = Date.now() - startTime;
    logger.debug(`${operationName}: Search operation completed`, {
      operationName,
      totalTime: `${totalTime}ms`,
      totalSearches: results.totalSearches,
      completedSearches: results.completedSearches,
      matches: results.matches.length,
      failures: results.failures.length,
      exactMatchFound: !!results.exactMatch,
      earlyTerminationTriggered: results.earlyTerminationTriggered,
      performanceGain: results.performanceGain
    });

    return results;
  }

  /**
   * Process batch results and update the main results object
   */
  private static processBatchResults<T>(
    batchResults: PromiseSettledResult<{ success: boolean; result: T | null; error?: string; index: number }>[],
    results: EarlyTerminationResult<T>
  ): void {
    for (const promiseResult of batchResults) {
      if (promiseResult.status === 'fulfilled') {
        const { success, result, error, index } = promiseResult.value;
        results.completedSearches++;
        
        if (success && result) {
          results.matches.push(result);
        } else if (!success && error) {
          results.failures.push({ index, error });
        }
      } else {
        // Promise itself was rejected
        results.completedSearches++;
        results.failures.push({ 
          index: -1, // Unknown index for rejected promise
          error: promiseResult.reason?.message || String(promiseResult.reason)
        });
      }
    }
  }
}