import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

describe('logger', () => {
  const originalEnv = {
    LOG_FILE: process.env.LOG_FILE,
    LOG_LEVEL: process.env.LOG_LEVEL,
    KB_LOG_FORMAT: process.env.KB_LOG_FORMAT,
    KB_LOG_MAX_BYTES: process.env.KB_LOG_MAX_BYTES,
    KB_LOG_MAX_FILES: process.env.KB_LOG_MAX_FILES,
  };

  const restoreEnv = (key: keyof typeof originalEnv) => {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  };

  afterEach(() => {
    restoreEnv('LOG_FILE');
    restoreEnv('LOG_LEVEL');
    restoreEnv('KB_LOG_FORMAT');
    restoreEnv('KB_LOG_MAX_BYTES');
    restoreEnv('KB_LOG_MAX_FILES');
    jest.restoreAllMocks();
    jest.resetModules();
  });

  // Build a canonical payload whose written line (payload + '\n') is exactly `bytes` long.
  const canonicalLineOfBytes = (tag: string, bytes: number): string => {
    const padding = Math.max(0, bytes - 1 - tag.length); // -1 for the '\n' the logger appends
    return `${tag}${'x'.repeat(padding)}`;
  };

  it('writes log messages to the configured file', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-logger-file-'));
    const logFile = path.join(tempDir, 'logs', 'app.log');
    process.env.LOG_FILE = logFile;
    process.env.LOG_LEVEL = 'debug';

    await jest.isolateModulesAsync(async () => {
      const { logger } = await import('./logger.js');
      logger.info('File target message');
      logger.debug('debug content');
      await new Promise((resolve) => setImmediate(resolve));
    });

    expect((await fsp.stat(path.dirname(logFile))).isDirectory()).toBe(true);
    const fileContents = await fsp.readFile(logFile, 'utf-8');
    expect(fileContents).toContain('File target message');
    expect(fileContents).toContain('[DEBUG] debug content');
  });

  it('falls back to stderr when log file cannot be initialized', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-logger-stderr-'));
    const lockedDir = path.join(tempDir, 'locked');
    await fsp.mkdir(lockedDir, { recursive: true });
    await fsp.chmod(lockedDir, 0o500);

    const logFile = path.join(lockedDir, 'app.log');
    process.env.LOG_FILE = logFile;

    try {
      await jest.isolateModulesAsync(async () => {
        const { logger } = await import('./logger.js');
        logger.info('Fallback message');
        await new Promise((resolve) => setImmediate(resolve));
      });
    } finally {
      await fsp.chmod(lockedDir, 0o700);
    }

    const stderrOutput = stderrSpy.mock.calls.flat().join('');
    expect(stderrOutput).toMatch(/Failed to (initialize|write log)|Log file stream error/);
  });

  it('routes canonical JSON lines without text logs when KB_LOG_FORMAT=canonical', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-logger-canonical-'));
    const logFile = path.join(tempDir, 'logs', 'app.log');
    process.env.LOG_FILE = logFile;
    process.env.KB_LOG_FORMAT = 'canonical';

    await jest.isolateModulesAsync(async () => {
      const { logger } = await import('./logger.js');
      logger.info('text should be suppressed');
      logger.canonical('{"schema_version":"kb-canonical.v1"}');
      await new Promise((resolve) => setImmediate(resolve));
    });

    const fileContents = await fsp.readFile(logFile, 'utf-8');
    expect(fileContents).toBe('{"schema_version":"kb-canonical.v1"}\n');
  });

  it('suppresses canonical lines when KB_LOG_FORMAT=text', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-logger-text-'));
    const logFile = path.join(tempDir, 'logs', 'app.log');
    process.env.LOG_FILE = logFile;
    process.env.KB_LOG_FORMAT = 'text';

    await jest.isolateModulesAsync(async () => {
      const { logger } = await import('./logger.js');
      logger.info('text remains');
      logger.canonical('{"schema_version":"kb-canonical.v1"}');
      await new Promise((resolve) => setImmediate(resolve));
    });

    const fileContents = await fsp.readFile(logFile, 'utf-8');
    expect(fileContents).toContain('text remains');
    expect(fileContents).not.toContain('kb-canonical.v1');
  });

  it('does not rotate when KB_LOG_MAX_BYTES is unset (disabled by default)', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-logger-norotate-'));
    const logFile = path.join(tempDir, 'app.log');
    process.env.LOG_FILE = logFile;
    delete process.env.KB_LOG_MAX_BYTES;

    await jest.isolateModulesAsync(async () => {
      const { logger } = await import('./logger.js');
      for (let i = 0; i < 20; i += 1) {
        logger.canonical(canonicalLineOfBytes(`L${i}`, 50));
      }
    });

    await expect(fsp.stat(`${logFile}.1`)).rejects.toThrow();
    const contents = await fsp.readFile(logFile, 'utf-8');
    expect(contents).toContain('L0');
    expect(contents).toContain('L19');
  });

  it('rotates LOG_FILE to LOG_FILE.1 once it reaches KB_LOG_MAX_BYTES', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-logger-rotate-'));
    const logFile = path.join(tempDir, 'app.log');
    process.env.LOG_FILE = logFile;
    process.env.KB_LOG_FORMAT = 'canonical';
    process.env.KB_LOG_MAX_BYTES = '100';

    await jest.isolateModulesAsync(async () => {
      const { logger } = await import('./logger.js');
      // Each line is 61 bytes. After A (61) and B (122) the file is over the
      // 100-byte cap, so writing C rolls A+B into .1 and starts a fresh file.
      logger.canonical(canonicalLineOfBytes('A', 61));
      logger.canonical(canonicalLineOfBytes('B', 61));
      logger.canonical(canonicalLineOfBytes('C', 61));
    });

    const rolled = await fsp.readFile(`${logFile}.1`, 'utf-8');
    expect(rolled).toContain('A');
    expect(rolled).toContain('B');
    expect(rolled).not.toContain('C');

    const current = await fsp.readFile(logFile, 'utf-8');
    expect(current).toContain('C');
    expect(current).not.toContain('A');
  });

  it('honors the KB_LOG_MAX_FILES retention bound', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-logger-retention-'));
    const logFile = path.join(tempDir, 'app.log');
    process.env.LOG_FILE = logFile;
    process.env.KB_LOG_FORMAT = 'canonical';
    process.env.KB_LOG_MAX_BYTES = '50';
    process.env.KB_LOG_MAX_FILES = '2';

    await jest.isolateModulesAsync(async () => {
      const { logger } = await import('./logger.js');
      // 31-byte lines past a 50-byte cap force repeated rotations.
      for (let i = 0; i < 12; i += 1) {
        logger.canonical(canonicalLineOfBytes(`L${i}`, 31));
      }
    });

    await expect(fsp.stat(`${logFile}.1`)).resolves.toBeDefined();
    await expect(fsp.stat(`${logFile}.2`)).resolves.toBeDefined();
    // Retention is 2: a third generation must never be created.
    await expect(fsp.stat(`${logFile}.3`)).rejects.toThrow();
  });

  it('rolls an oversized pre-existing log on startup', async () => {
    const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-logger-startup-'));
    const logFile = path.join(tempDir, 'app.log');
    await fsp.writeFile(logFile, `${'x'.repeat(500)}\n`, 'utf-8');
    process.env.LOG_FILE = logFile;
    process.env.KB_LOG_MAX_BYTES = '100';

    await jest.isolateModulesAsync(async () => {
      await import('./logger.js');
      await new Promise((resolve) => setImmediate(resolve));
    });

    const rolled = await fsp.readFile(`${logFile}.1`, 'utf-8');
    expect(rolled.length).toBeGreaterThanOrEqual(500);
    const current = await fsp.readFile(logFile, 'utf-8');
    expect(current.length).toBeLessThan(100);
  });
});
