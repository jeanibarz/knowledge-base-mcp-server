import {
  assertValidKbName,
  getFilesRecursively,
  isValidKbName,
  parseFrontmatter,
  resolveKbPath,
} from './utils.js';
import * as fsp from 'fs/promises';
import * as fs from 'fs'; // Import fs for PathLike and Dirent
import * as os from 'os';
import * as path from 'path';

// Mock fs/promises readdir for getFilesRecursively tests only. The
// resolveKbPath tests need the real fs, so we import and retain actual
// behavior for every other method.
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

describe('isValidKbName / assertValidKbName', () => {
  it('accepts simple lowercase names', () => {
    expect(isValidKbName('default')).toBe(true);
    expect(isValidKbName('a')).toBe(true);
    expect(isValidKbName('kb-2025')).toBe(true);
    expect(isValidKbName('notes.v1')).toBe(true);
    expect(isValidKbName('a_b.c-d')).toBe(true);
    expect(() => assertValidKbName('default')).not.toThrow();
  });

  it('rejects names with a leading dot', () => {
    expect(isValidKbName('.hidden')).toBe(false);
    expect(isValidKbName('.')).toBe(false);
    expect(() => assertValidKbName('.hidden')).toThrow(/invalid KB name/);
  });

  it('rejects `..` explicitly', () => {
    expect(isValidKbName('..')).toBe(false);
    expect(() => assertValidKbName('..')).toThrow(/invalid KB name/);
  });

  it('rejects path separators', () => {
    expect(isValidKbName('foo/bar')).toBe(false);
    expect(isValidKbName('foo\\bar')).toBe(false);
    expect(() => assertValidKbName('foo/bar')).toThrow(/invalid KB name/);
  });

  it('rejects the empty string', () => {
    expect(isValidKbName('')).toBe(false);
    expect(() => assertValidKbName('')).toThrow(/invalid KB name/);
  });

  it('rejects names longer than 64 characters', () => {
    const tooLong = 'a'.repeat(65);
    expect(isValidKbName(tooLong)).toBe(false);
    expect(() => assertValidKbName(tooLong)).toThrow(/invalid KB name/);
    // Boundary: 64 is accepted.
    expect(isValidKbName('a'.repeat(64))).toBe(true);
  });

  it('rejects names containing a null byte', () => {
    expect(isValidKbName('foo\0bar')).toBe(false);
    expect(() => assertValidKbName('foo\0bar')).toThrow(/invalid KB name/);
  });

  it('rejects uppercase (case-folding filesystems) and leading hyphen', () => {
    expect(isValidKbName('Foo')).toBe(false);
    expect(isValidKbName('-foo')).toBe(false);
  });
});

describe('resolveKbPath', () => {
  let tempRoot: string;
  let kbName: string;
  let kbRoot: string;

  beforeEach(async () => {
    tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-resolve-'));
    kbName = 'default';
    kbRoot = path.join(tempRoot, kbName);
    await fsp.mkdir(kbRoot, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  });

  it('resolves a legal inner path to its realpath under the KB root', async () => {
    const filePath = path.join(kbRoot, 'docs', 'hello.md');
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, 'hi');

    const resolved = await resolveKbPath(kbName, 'docs/hello.md', tempRoot);
    expect(resolved).toBe(await fsp.realpath(filePath));
  });

  it('resolves the KB root itself when given an empty relative path', async () => {
    const resolved = await resolveKbPath(kbName, '', tempRoot);
    expect(resolved).toBe(await fsp.realpath(kbRoot));
  });

  it('throws on `..` escape that resolves outside the KB', async () => {
    // Create a sibling file next to the KB root so realpath succeeds,
    // guaranteeing the prefix check (not ENOENT) is what fails.
    const sibling = path.join(tempRoot, 'secret.txt');
    await fsp.writeFile(sibling, 'nope');

    await expect(resolveKbPath(kbName, '../secret.txt', tempRoot)).rejects.toThrow(
      /path escapes KB root/
    );
  });

  it('throws on a symlink pointing outside the KB', async () => {
    const outside = path.join(tempRoot, 'outside.txt');
    await fsp.writeFile(outside, 'nope');
    const linkPath = path.join(kbRoot, 'escape.txt');
    await fsp.symlink(outside, linkPath);

    await expect(resolveKbPath(kbName, 'escape.txt', tempRoot)).rejects.toThrow(
      /path escapes KB root/
    );
  });

  it('throws when an intermediate directory in the walked chain is a symlink to outside', async () => {
    const outsideDir = path.join(tempRoot, 'elsewhere');
    await fsp.mkdir(outsideDir);
    await fsp.writeFile(path.join(outsideDir, 'target.md'), 'nope');
    const linkDir = path.join(kbRoot, 'shortcut');
    await fsp.symlink(outsideDir, linkDir, 'dir');

    await expect(resolveKbPath(kbName, 'shortcut/target.md', tempRoot)).rejects.toThrow(
      /path escapes KB root/
    );
  });

  it('throws when the KB directory is missing', async () => {
    await expect(resolveKbPath('does-not-exist', 'any.md', tempRoot)).rejects.toThrow();
  });

  it('throws on a null byte in the relative path', async () => {
    await expect(resolveKbPath(kbName, 'foo\0bar', tempRoot)).rejects.toThrow(
      /null byte/
    );
  });

  it('rejects an invalid kbName before touching the filesystem', async () => {
    // Without the internal assertValidKbName guard, kbName === '..' would make
    // kbRoot === tempRoot's parent and the prefix check would cover every
    // absolute path on disk. Lock that defence in.
    await expect(resolveKbPath('..', 'anything.md', tempRoot)).rejects.toThrow(
      /invalid KB name/
    );
    await expect(resolveKbPath('foo/bar', 'anything.md', tempRoot)).rejects.toThrow(
      /invalid KB name/
    );
  });
});

describe('parseFrontmatter', () => {
  it('returns `{ tags: [], body: content }` when there is no frontmatter', () => {
    const content = '# Just a heading\n\nSome text.\n';
    const result = parseFrontmatter(content);
    expect(result).toEqual({ tags: [], body: content });
  });

  it('extracts `tags` given as an array', () => {
    const content = '---\ntags: [alpha, beta]\n---\n# Body\n';
    const result = parseFrontmatter(content);
    expect(result.tags).toEqual(['alpha', 'beta']);
    expect(result.body).toBe('# Body\n');
  });

  it('coerces a scalar `tags: foo` to `[foo]`', () => {
    const content = '---\ntags: foo\n---\nBody here\n';
    const result = parseFrontmatter(content);
    expect(result.tags).toEqual(['foo']);
    expect(result.body).toBe('Body here\n');
  });

  it('returns `{ tags: [], body: original }` on malformed YAML — never throws', () => {
    // Unterminated YAML flow sequence — parser throws; we must not.
    const content = '---\ntags: [unterminated\nmore\n---\nBody\n';
    let result: { tags: string[]; body: string } | undefined;
    expect(() => {
      result = parseFrontmatter(content);
    }).not.toThrow();
    expect(result!.tags).toEqual([]);
    expect(result!.body).toBe(content);
  });

  it('strips frontmatter from the body on successful parse', () => {
    const content = '---\ntags:\n  - one\n  - two\n---\nReal body\n';
    const result = parseFrontmatter(content);
    expect(result.tags).toEqual(['one', 'two']);
    expect(result.body).toBe('Real body\n');
    expect(result.body).not.toContain('---');
    expect(result.body).not.toContain('tags:');
  });

  it('returns `{ tags: [], body: content }` when frontmatter has no closing fence', () => {
    const content = '---\ntags: [a, b]\nno close here\n';
    const result = parseFrontmatter(content);
    expect(result.tags).toEqual([]);
    expect(result.body).toBe(content);
  });

  it('handles CRLF line endings in frontmatter', () => {
    const content = '---\r\ntags: [crlf]\r\n---\r\nBody\r\n';
    const result = parseFrontmatter(content);
    expect(result.tags).toEqual(['crlf']);
    expect(result.body).toBe('Body\r\n');
  });

  it('returns `{ tags: [] }` when frontmatter lacks a `tags` key', () => {
    const content = '---\ntitle: hello\n---\nBody\n';
    const result = parseFrontmatter(content);
    expect(result.tags).toEqual([]);
    expect(result.body).toBe('Body\n');
  });
});
