/**
 * Manual mock for git utils
 */

export const safeExec = jest.fn();
export const exec = jest.fn();
export const getCurrentGitBranch = jest.fn();
export const getCurrentGitCommit = jest.fn();
export const hasUncommittedChanges = jest.fn();