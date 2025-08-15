import { jest } from '@jest/globals';

export const mockCheckPortfolioExists = jest.fn();

export class PortfolioRepoManager {
  constructor() {}
  
  checkPortfolioExists = mockCheckPortfolioExists;
}