import { getFilesRecursively } from './utils.js';
import * as fsp from 'fs/promises';
import * as fs from 'fs'; // Import fs for PathLike and Dirent
import * as path from 'path';

// Mock fs/promises
jest.mock('fs/promises', () => ({
  ...jest.requireActual('fs/promises'), // Import and retain default behavior
  readdir: jest.fn(), // Mock readdir specifically
}));

describe('getFilesRecursively', () => {
  const mockReaddir = fsp.readdir as jest.MockedFunction<typeof fsp.readdir>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return files recursively from nested directories', async () => {
    // Mock directory structure:
    // test_dir/
    //   file1.txt
    //   sub_dir/
    //     file2.txt
    //     nested_dir/
    //       file3.txt
    mockReaddir.mockImplementation(async (dirPath: fs.PathLike, options?: any): Promise<fs.Dirent[]> => {
      const dir = dirPath.toString();
      if (dir === 'test_dir') {
        return [
          { name: 'file1.txt', isDirectory: () => false, isFile: () => true },
          { name: 'sub_dir', isDirectory: () => true, isFile: () => false }
        ] as fs.Dirent[];
      } else if (dir === path.join('test_dir', 'sub_dir')) {
        return [
          { name: 'file2.txt', isDirectory: () => false, isFile: () => true },
          { name: 'nested_dir', isDirectory: () => true, isFile: () => false }
        ] as fs.Dirent[];
      } else if (dir === path.join('test_dir', 'sub_dir', 'nested_dir')) {
        return [
          { name: 'file3.txt', isDirectory: () => false, isFile: () => true }
        ] as fs.Dirent[];
      }
      return [] as fs.Dirent[];
    });

    const files = await getFilesRecursively('test_dir');
    
    expect(files).toEqual([
      path.join('test_dir', 'file1.txt'),
      path.join('test_dir', 'sub_dir', 'file2.txt'),
      path.join('test_dir', 'sub_dir', 'nested_dir', 'file3.txt')
    ]);
  });

  it('should skip hidden files and directories', async () => {
    mockReaddir.mockImplementation(async (dirPath: fs.PathLike, options?: any): Promise<fs.Dirent[]> => {
      const dir = dirPath.toString();
      if (dir === 'test_dir') {
        return [
          { name: 'file1.txt', isDirectory: () => false, isFile: () => true },
          { name: '.hidden_file', isDirectory: () => false, isFile: () => true },
          { name: '.hidden_dir', isDirectory: () => true, isFile: () => false },
          { name: 'visible_dir', isDirectory: () => true, isFile: () => false }
        ] as fs.Dirent[];
      } else if (dir === path.join('test_dir', 'visible_dir')) {
        return [
          { name: 'file2.txt', isDirectory: () => false, isFile: () => true },
          { name: '.hidden_file2', isDirectory: () => false, isFile: () => true }
        ] as fs.Dirent[];
      }
      return [] as fs.Dirent[];
    });

    const files = await getFilesRecursively('test_dir');
    
    expect(files).toEqual([
      path.join('test_dir', 'file1.txt'),
      path.join('test_dir', 'visible_dir', 'file2.txt')
    ]);
  });

  it('should handle empty directories', async () => {
    mockReaddir.mockResolvedValue([] as any);

    const files = await getFilesRecursively('empty_dir');
    
    expect(files).toEqual([]);
  });

  it('should handle errors gracefully', async () => {
    mockReaddir.mockRejectedValue(new Error('Permission denied'));

    const files = await getFilesRecursively('error_dir');
    
    expect(files).toEqual([]);
  });
});
