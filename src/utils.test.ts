import {
  __resetSkippedFilenameLogForTests,
  assertValidKbName,
  filterIngestablePaths,
  getFilesRecursively,
  isValidKbName,
  parseFrontmatter,
  resolveKbPath,
  SKIPPED_FILENAME_PATTERNS,
  toError,
} from './utils.js';
import { logger } from './logger.js';
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
  it('returns `{ tags: [], body: content, frontmatter: {} }` when there is no frontmatter', () => {
    const content = '# Just a heading\n\nSome text.\n';
    const result = parseFrontmatter(content);
    expect(result).toEqual({ tags: [], body: content, frontmatter: {} });
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

describe('filterIngestablePaths (RFC 011 §5.2)', () => {
  // All fixtures are path-only — filterIngestablePaths is pure and never
  // touches the filesystem. Using POSIX separators in the fixtures keeps
  // the tests host-OS-agnostic; the helper normalizes separators internally.
  const kbRoot = '/kbs/arxiv';
  const abs = (rel: string): string => `${kbRoot}/${rel}`;

  it('(a) arxiv KB: notes/*.md and PDFs pass (issue #46); _seen.jsonl and logs/** excluded', () => {
    const input = [
      abs('notes/2604.21215.md'),
      abs('notes/2604.21221.md'),
      abs('pdfs/2604.21215.pdf'),
      abs('pdfs/2604.21221.pdf'),
      abs('_seen.jsonl'),
      abs('logs/2026-04-24.log'),
    ];
    const output = filterIngestablePaths(input, kbRoot);
    // Issue #46 — `.pdf` is now part of the base allowlist; arxiv-shaped KBs
    // that want to keep their `pdfs/` directory out of the embedding (because
    // a markdown sibling already covers it) opt in via
    // `INGEST_EXCLUDE_PATHS=pdfs/**` (see test (a.1) below).
    expect(output).toEqual([
      abs('notes/2604.21215.md'),
      abs('notes/2604.21221.md'),
      abs('pdfs/2604.21215.pdf'),
      abs('pdfs/2604.21221.pdf'),
    ]);
  });

  it('(a.1) arxiv KB with INGEST_EXCLUDE_PATHS="pdfs/**" suppresses the PDF subtree', () => {
    // The natural arxiv migration after issue #46: notes/ stay embedded,
    // pdfs/ stays out so the same paper isn't double-indexed.
    const input = [
      abs('notes/2604.21215.md'),
      abs('pdfs/2604.21215.pdf'),
      abs('_seen.jsonl'),
    ];
    const output = filterIngestablePaths(input, kbRoot, {
      excludePaths: ['pdfs/**'],
    });
    expect(output).toEqual([abs('notes/2604.21215.md')]);
  });

  it('(b) all-markdown KB: filter is a no-op', () => {
    const kb = '/kbs/claude-code-notes';
    const input = [
      `${kb}/claude-code-setup.md`,
      `${kb}/knowledge-base-mcp-server.md`,
    ];
    const output = filterIngestablePaths(input, kb);
    expect(output).toEqual(input);
  });

  it('(c) INGEST_EXTRA_EXTENSIONS=".json" includes a notes/config.json but Rule A still excludes _seen.jsonl', () => {
    const input = [
      abs('notes/config.json'),
      abs('notes/paper.md'),
      abs('_seen.jsonl'),
    ];
    const output = filterIngestablePaths(input, kbRoot, {
      extraExtensions: ['.json'],
    });
    expect(output).toEqual([
      abs('notes/config.json'),
      abs('notes/paper.md'),
    ]);
  });

  it('(c.1) INGEST_EXTRA_EXTENSIONS accepts entries without a leading dot', () => {
    const input = [abs('notes/data.csv'), abs('notes/paper.md')];
    const output = filterIngestablePaths(input, kbRoot, {
      extraExtensions: ['csv'],
    });
    expect(output).toEqual([abs('notes/data.csv'), abs('notes/paper.md')]);
  });

  it('(d) INGEST_EXCLUDE_PATHS excludes a glob; notes/ stays included', () => {
    const input = [
      abs('drafts/scratch.md'),
      abs('drafts/nested/old.md'),
      abs('notes/paper.md'),
    ];
    const output = filterIngestablePaths(input, kbRoot, {
      excludePaths: ['drafts/**'],
    });
    expect(output).toEqual([abs('notes/paper.md')]);
  });

  it('(e) case sensitivity: .MD and .PDF normalize to lowercase and pass; .EXE stays excluded', () => {
    const input = [abs('pdfs/Paper.PDF'), abs('NOTES/PAPER.MD'), abs('bin/tool.EXE')];
    const output = filterIngestablePaths(input, kbRoot);
    // Issue #46 — `.pdf` is base-allowed; .EXE is not.
    expect(output).toEqual([abs('pdfs/Paper.PDF'), abs('NOTES/PAPER.MD')]);
  });

  it('(f) basename _seen.jsonl is excluded even if placed under notes/', () => {
    // A workflow-bug fixture: the ledger file lands inside `notes/`.
    // Rule A.2 (segment-literal) matches regardless of depth.
    const input = [abs('notes/_seen.jsonl'), abs('notes/paper.md')];
    const output = filterIngestablePaths(input, kbRoot);
    expect(output).toEqual([abs('notes/paper.md')]);
  });

  it('excludes common OS turds by basename', () => {
    const input = [
      abs('.DS_Store'),
      abs('notes/.DS_Store'),
      abs('notes/Thumbs.db'),
      abs('notes/desktop.ini'),
      abs('notes/paper.md'),
    ];
    const output = filterIngestablePaths(input, kbRoot);
    expect(output).toEqual([abs('notes/paper.md')]);
  });

  it('first-segment `logs` excludes a subtree but a flat-file named logs.md stays', () => {
    const input = [
      abs('logs/2026-04-24.log'),
      abs('logs/2026-04-25.log'),
      abs('logs.md'), // depth-1 file literally named `logs.md` — allowed
    ];
    const output = filterIngestablePaths(input, kbRoot);
    expect(output).toEqual([abs('logs.md')]);
  });

  it('empty options are equivalent to default base allowlist', () => {
    const input = [abs('notes/paper.md'), abs('notes/data.json')];
    const output = filterIngestablePaths(input, kbRoot, {});
    expect(output).toEqual([abs('notes/paper.md')]);
  });

  it('rejects .log files even without Rule A triggering', () => {
    // A .log at depth 1 (not inside logs/) is still excluded by Rule B.
    const input = [abs('ingest.log'), abs('notes/paper.md')];
    const output = filterIngestablePaths(input, kbRoot);
    expect(output).toEqual([abs('notes/paper.md')]);
  });
});

describe('filterIngestablePaths — SKIPPED_FILENAME_PATTERNS (issue #89)', () => {
  const kbRoot = '/kbs/onshape';
  const abs = (rel: string): string => `${kbRoot}/${rel}`;

  beforeEach(() => {
    __resetSkippedFilenameLogForTests();
  });

  it('skips NTFS ADS Zone.Identifier sidecars (anchored colon-suffix)', () => {
    // The bug: rsync from a Windows NTFS volume through WSL surfaces
    // `<file>.md:Zone.Identifier` zero-byte siblings. Without the
    // Zone.Identifier-anchored pattern the scanner would re-attempt
    // embedding on every retrieve call.
    const input = [
      abs('api-adv/assemblies.md'),
      abs('api-adv/assemblies.md:Zone.Identifier'),
      abs('api-adv/billing.md:Zone.Identifier'),
      abs('api-adv/CASED.md:zone.identifier'), // case-insensitive
    ];
    const output = filterIngestablePaths(input, kbRoot);
    expect(output).toEqual([abs('api-adv/assemblies.md')]);
  });

  it('preserves legitimate POSIX filenames that contain a colon', () => {
    // Regression guard against the over-broad `/:/` pattern: colons are
    // valid in POSIX filenames and appear in real-world markdown documents
    // (titles like "Design:Tradeoffs", date-prefix conventions, etc.). The
    // skip pattern must anchor on the actual NTFS ADS suffix, not just the
    // colon character — otherwise these files vanish silently with no
    // recoverable override (Rule A.0 runs before extension/options checks).
    const input = [
      abs('Design:Tradeoffs.md'),
      abs('notes/2024-01-15: meeting.md'),
      abs('Topic: Subtopic.md'),
      abs('14:30 standup.md'),
    ];
    const output = filterIngestablePaths(input, kbRoot);
    expect(output).toEqual(input);
  });

  it('skips macOS AppleDouble sidecars (`._` prefix) even when the suffix matches the allowlist', () => {
    // `._foo.md` ends in `.md` so Rule B (extension) accepts it, but it is a
    // metadata sidecar, not a markdown file. The walker's dotfile skip is
    // upstream; this test guards bypass paths (manual ingest, glob expansion).
    const input = [abs('notes/paper.md'), abs('notes/._paper.md')];
    const output = filterIngestablePaths(input, kbRoot);
    expect(output).toEqual([abs('notes/paper.md')]);
  });

  it('skips Thumbs.db case-insensitively', () => {
    const input = [abs('notes/Thumbs.db'), abs('notes/THUMBS.DB'), abs('notes/paper.md')];
    const output = filterIngestablePaths(input, kbRoot);
    expect(output).toEqual([abs('notes/paper.md')]);
  });

  it('skips .DS_Store via the regex layer (in addition to the literal set)', () => {
    const input = [abs('.DS_Store'), abs('notes/.DS_Store'), abs('notes/paper.md')];
    const output = filterIngestablePaths(input, kbRoot);
    expect(output).toEqual([abs('notes/paper.md')]);
  });

  it('logs each skip pattern at most once per process', () => {
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      const input = [
        abs('a.md:Zone.Identifier'),
        abs('b.md:Zone.Identifier'),
        abs('c.md:Zone.Identifier'),
        abs('notes/._d.md'),
        abs('notes/._e.md'),
      ];
      filterIngestablePaths(input, kbRoot);

      const skipCalls = infoSpy.mock.calls
        .map((args) => String(args[0]))
        .filter((m) => m.startsWith('Skipping filesystem-metadata sidecar'));
      // One log for the Zone.Identifier pattern (3 hits), one log for `^\._` (2 hits).
      expect(skipCalls).toHaveLength(2);
      expect(skipCalls.some((m) => m.includes('a.md:Zone.Identifier'))).toBe(true);
      expect(skipCalls.some((m) => m.includes('._d.md'))).toBe(true);
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('exposes the pattern list so future loaders can reuse it', () => {
    // Issue #89 keeps the regex list public so loaders added by #46
    // (PDF/HTML) inherit the same skip list rather than re-deriving it.
    expect(SKIPPED_FILENAME_PATTERNS.some((re) => re.test('foo.md:Zone.Identifier'))).toBe(true);
    expect(SKIPPED_FILENAME_PATTERNS.some((re) => re.test('._foo.md'))).toBe(true);
    expect(SKIPPED_FILENAME_PATTERNS.some((re) => re.test('Thumbs.db'))).toBe(true);
    expect(SKIPPED_FILENAME_PATTERNS.some((re) => re.test('.DS_Store'))).toBe(true);
    // Sanity: normal markdown files (incl. POSIX-legal colons) do not match.
    expect(SKIPPED_FILENAME_PATTERNS.every((re) => !re.test('paper.md'))).toBe(true);
    expect(SKIPPED_FILENAME_PATTERNS.every((re) => !re.test('Design:Tradeoffs.md'))).toBe(true);
    expect(SKIPPED_FILENAME_PATTERNS.every((re) => !re.test('2024-01-15: meeting.md'))).toBe(true);
  });
});

describe('parseFrontmatter (RFC 011 M2 frontmatter lift)', () => {
  it('returns the full parsed object under `frontmatter` when YAML is a map', () => {
    const content =
      '---\n' +
      'arxiv_id: 2604.21221\n' +
      'title: "Sparse Forcing"\n' +
      'relevance_score: 7\n' +
      'tags: [kv-cache]\n' +
      '---\n' +
      '# Body\n';
    const result = parseFrontmatter(content);
    // FAILSAFE: scalars arrive as strings, so 7 stays "7" here. Coercion
    // is the callsite's job in liftFrontmatter.
    expect(result.frontmatter).toEqual({
      arxiv_id: '2604.21221',
      title: 'Sparse Forcing',
      relevance_score: '7',
      tags: ['kv-cache'],
    });
    expect(result.tags).toEqual(['kv-cache']);
  });

  it('returns `frontmatter: {}` on no-frontmatter files', () => {
    const result = parseFrontmatter('# Plain\n\nBody only.\n');
    expect(result.frontmatter).toEqual({});
  });

  it('returns `frontmatter: {}` on malformed YAML', () => {
    const result = parseFrontmatter('---\ntags: [unterminated\n---\nBody\n');
    expect(result.frontmatter).toEqual({});
  });

  it('returns `frontmatter: {}` when the YAML document is a scalar (not an object)', () => {
    // A YAML document that parses to a plain string (not a map) must not
    // leak a string-shaped frontmatter into downstream consumers.
    const result = parseFrontmatter('---\njust a scalar\n---\nBody\n');
    expect(result.frontmatter).toEqual({});
  });

  it('preserves non-whitelisted keys so liftFrontmatter can route them to extras', () => {
    const content = '---\narxiv_id: 2604.1\ncustom_field: value\n---\nBody\n';
    const result = parseFrontmatter(content);
    expect(result.frontmatter).toEqual({
      arxiv_id: '2604.1',
      custom_field: 'value',
    });
  });
});

describe('toError', () => {
  it('returns the same Error reference when given an Error', () => {
    // Identity matters: callers in FaissIndexManager attach an
    // `__alreadyLogged` marker to the thrown Error, and the migration helper
    // must not break that pattern by wrapping the Error in a new instance.
    const original = new Error('boom') as Error & { __alreadyLogged?: boolean };
    original.__alreadyLogged = true;
    const result = toError(original);
    expect(result).toBe(original);
    expect((result as Error & { __alreadyLogged?: boolean }).__alreadyLogged).toBe(true);
  });

  it('preserves Error subclass instances by reference (TypeError, custom)', () => {
    const typeErr = new TypeError('bad type');
    expect(toError(typeErr)).toBe(typeErr);

    class CustomError extends Error {}
    const custom = new CustomError('custom');
    expect(toError(custom)).toBe(custom);
  });

  it('wraps a string into a new Error whose message is the string', () => {
    const result = toError('something failed');
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('something failed');
  });

  it('JSON-stringifies plain objects into the Error message', () => {
    const result = toError({ code: 'EACCES', path: '/tmp/x' });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe('{"code":"EACCES","path":"/tmp/x"}');
  });

  it('handles values JSON.stringify cannot serialize (cycles) without throwing', () => {
    type Cyclic = { self?: Cyclic };
    const cyclic: Cyclic = {};
    cyclic.self = cyclic;
    const result = toError(cyclic);
    expect(result).toBeInstanceOf(Error);
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  });
});
