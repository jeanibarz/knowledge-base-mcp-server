import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'fs';
import { dirname } from 'path';
import { format } from 'util';
import { KB_LOG_MAX_BYTES, KB_LOG_MAX_FILES } from './config/logging.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogFormat = 'text' | 'canonical' | 'both';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase() as LogLevel;
const activeLevel = LEVEL_PRIORITY[envLevel] ? envLevel : 'info';
const envFormat = (process.env.KB_LOG_FORMAT || 'both').toLowerCase() as LogFormat;
const activeFormat: LogFormat = ['text', 'canonical', 'both'].includes(envFormat) ? envFormat : 'both';

const logFilePath = process.env.LOG_FILE;
// Rotation is opt-in: undefined byte cap means the log appends forever (legacy behavior).
const maxBytes = KB_LOG_MAX_BYTES;
const maxFiles = KB_LOG_MAX_FILES;

// The active append stream for text logs; reopened after each rotation so that
// subsequent writes target the fresh LOG_FILE inode rather than a rolled file.
let fileStream: NodeJS.WritableStream | undefined;

function openFileStream(): void {
  if (!logFilePath) return;
  const stream = createWriteStream(logFilePath, { flags: 'a' });
  stream.on('error', (error) => {
    const message = `${new Date().toISOString()} [ERROR] Log file stream error for ${logFilePath}: ${format(error)}`;
    process.stderr.write(`${message}\n`);
  });
  fileStream = stream;
  try {
    stream.write('');
  } catch (error) {
    const message = `${new Date().toISOString()} [ERROR] Failed to prime log file ${logFilePath}: ${format(error)}`;
    process.stderr.write(`${message}\n`);
  }
}

// Roll LOG_FILE → LOG_FILE.1, shifting existing generations and dropping any
// beyond the retention bound. Closes the active stream first so the rename
// targets a quiescent file, then reopens it on the fresh path.
function rotate(): void {
  if (!logFilePath) return;
  const wasOpen = fileStream !== undefined;
  if (fileStream) {
    try {
      fileStream.end();
    } catch {
      // best effort – continue with the rotation regardless
    }
    fileStream = undefined;
  }
  try {
    const oldest = `${logFilePath}.${maxFiles}`;
    if (existsSync(oldest)) {
      unlinkSync(oldest);
    }
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      const src = `${logFilePath}.${i}`;
      if (existsSync(src)) {
        renameSync(src, `${logFilePath}.${i + 1}`);
      }
    }
    renameSync(logFilePath, `${logFilePath}.1`);
  } catch (error) {
    process.stderr.write(
      `${new Date().toISOString()} [ERROR] Failed to rotate log file ${logFilePath}: ${format(error)}\n`,
    );
  } finally {
    if (wasOpen) {
      openFileStream();
    }
  }
}

// Rotate before writing when the existing file has reached the byte cap. The
// stat is skipped entirely when rotation is disabled, so the default path pays
// no per-write overhead.
function maybeRotate(): void {
  if (!logFilePath || maxBytes === undefined) return;
  let currentSize: number;
  try {
    currentSize = statSync(logFilePath).size;
  } catch {
    return; // file is absent or unreadable – nothing to roll
  }
  if (currentSize < maxBytes) return;
  rotate();
}

if (logFilePath) {
  try {
    const parentDir = dirname(logFilePath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    appendFileSync(logFilePath, '');
    // Roll an oversized pre-existing log on startup before opening the stream.
    maybeRotate();
    openFileStream();
    process.on('exit', () => {
      try {
        fileStream?.end();
      } catch {
        // noop – logging best effort on shutdown
      }
    });
  } catch (error) {
    const message = `${new Date().toISOString()} [ERROR] Failed to initialize log file ${logFilePath}: ${format(error)}`;
    process.stderr.write(`${message}\n`);
  }
}

function write(level: LogLevel, args: unknown[]): void {
  if (activeFormat === 'canonical') {
    return;
  }
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[activeLevel]) {
    return;
  }
  const message = format(...args);
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}\n`;
  try {
    process.stderr.write(line);
  } catch {
    // stderr failures are unrecoverable here; swallow to protect the caller.
  }
  if (fileStream) {
    maybeRotate();
    try {
      fileStream?.write(line);
    } catch (error) {
      process.stderr.write(`${new Date().toISOString()} [ERROR] Failed to write log: ${format(error)}\n`);
    }
  }
}

function writeCanonical(jsonLine: string): void {
  if (activeFormat === 'text') {
    return;
  }
  const line = `${jsonLine}\n`;
  if (logFilePath) {
    maybeRotate();
    try {
      appendFileSync(logFilePath, line);
    } catch (error) {
      process.stderr.write(`${new Date().toISOString()} [ERROR] Failed to write canonical log: ${format(error)}\n`);
    }
    return;
  }
  try {
    process.stderr.write(line);
  } catch {
    // canonical logging is best-effort and must not affect the caller
  }
}

export const logger = {
  debug: (...args: unknown[]) => write('debug', args),
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
  canonical: (jsonLine: string) => writeCanonical(jsonLine),
};
