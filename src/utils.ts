import * as crypto from 'crypto';
import * as fsp from 'fs/promises';

export async function calculateSHA256(filePath: string): Promise<string> {
  const fileBuffer = await fsp.readFile(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex');
}
