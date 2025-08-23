import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as path from 'path';

export async function calculateSHA256(filePath: string): Promise<string> {
  const fileBuffer = await fsp.readFile(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}

/**
 * Recursively gets all files in a directory, excluding hidden files and directories.
 * @param dirPath The directory path to search
 * @returns Array of file paths
 */
export async function getFilesRecursively(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  
  async function traverse(currentPath: string): Promise<void> {
    try {
      const entries = await fsp.readdir(currentPath, { withFileTypes: true });
      
      for (const entry of entries) {
        // Skip hidden files and directories
        if (entry.name.startsWith('.')) {
          continue;
        }
        
        const fullPath = path.join(currentPath, entry.name);
        
        if (entry.isDirectory()) {
          await traverse(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      console.error(`Error traversing directory ${currentPath}:`, error);
    }
  }
  
  await traverse(dirPath);
  return files;
}
