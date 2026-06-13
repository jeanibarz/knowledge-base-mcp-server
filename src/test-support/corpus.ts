import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export interface TestCorpusFileMap {
  [relativePath: string]: string | Buffer;
}

export interface TestCorpus {
  tempDir: string;
  rootDir: string;
  pathFor: (relativePath: string) => string;
  writeFile: (relativePath: string, content: string | Buffer) => Promise<string>;
  cleanup: () => Promise<void>;
}

export interface TestCorpusOptions {
  prefix?: string;
  files?: TestCorpusFileMap;
}

export async function createTestCorpus(options: TestCorpusOptions = {}): Promise<TestCorpus> {
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), options.prefix ?? 'kb-corpus-'));
  const rootDir = path.join(tempDir, 'kbs');
  await fsp.mkdir(rootDir, { recursive: true });

  const corpus: TestCorpus = {
    tempDir,
    rootDir,
    pathFor: (relativePath: string) => corpusPath(rootDir, relativePath),
    writeFile: async (relativePath: string, content: string | Buffer) => {
      const filePath = corpusPath(rootDir, relativePath);
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, content);
      return filePath;
    },
    cleanup: async () => {
      await fsp.rm(tempDir, { recursive: true, force: true });
    },
  };

  try {
    for (const [relativePath, content] of Object.entries(options.files ?? {})) {
      await corpus.writeFile(relativePath, content);
    }
  } catch (error) {
    await corpus.cleanup();
    throw error;
  }

  return corpus;
}

function corpusPath(rootDir: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`test corpus paths must be relative: ${relativePath}`);
  }

  const resolvedPath = path.resolve(rootDir, relativePath);
  const relativeToRoot = path.relative(rootDir, resolvedPath);
  if (relativeToRoot === '' || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`test corpus path escapes the root: ${relativePath}`);
  }

  return resolvedPath;
}
