import { jest } from '@jest/globals';

export const mockFetchFromGitHub = jest.fn();

export class GitHubClient {
  constructor() {}
  
  fetchFromGitHub = mockFetchFromGitHub;
}