/**
 * Manual mock for fs/promises to fix ES module mocking issues
 */
import { jest } from '@jest/globals';

const mockAccess = jest.fn();
const mockMkdir = jest.fn();
const mockWriteFile = jest.fn();
const mockReadFile = jest.fn();
const mockUnlink = jest.fn();
const mockReaddir = jest.fn();
const mockStat = jest.fn();
const mockRm = jest.fn();
const mockCopyFile = jest.fn();
const mockChmod = jest.fn();

// Export all common fs/promises functions
export {
  mockAccess as access,
  mockMkdir as mkdir,
  mockWriteFile as writeFile,
  mockReadFile as readFile,
  mockUnlink as unlink,
  mockReaddir as readdir,
  mockStat as stat,
  mockRm as rm,
  mockCopyFile as copyFile,
  mockChmod as chmod
};

// Default export for compatibility
export default {
  access: mockAccess,
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  unlink: mockUnlink,
  readdir: mockReaddir,
  stat: mockStat,
  rm: mockRm,
  copyFile: mockCopyFile,
  chmod: mockChmod
};

// Helper to reset all mocks
export const resetAllMocks = () => {
  mockAccess.mockReset();
  mockMkdir.mockReset();
  mockWriteFile.mockReset();
  mockReadFile.mockReset();
  mockUnlink.mockReset();
  mockReaddir.mockReset();
  mockStat.mockReset();
  mockRm.mockReset();
  mockCopyFile.mockReset();
  mockChmod.mockReset();
};

// Helper to get mock references
export const getMocks = () => ({
  access: mockAccess,
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  unlink: mockUnlink,
  readdir: mockReaddir,
  stat: mockStat,
  rm: mockRm,
  copyFile: mockCopyFile,
  chmod: mockChmod
});