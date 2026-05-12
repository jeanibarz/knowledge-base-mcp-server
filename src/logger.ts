import { appendFileSync, createWriteStream, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { format } from 'util';

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
const destinations: NodeJS.WritableStream[] = [process.stderr];

const logFilePath = process.env.LOG_FILE;
if (logFilePath) {
  try {
    const parentDir = dirname(logFilePath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    appendFileSync(logFilePath, '');
    const stream = createWriteStream(logFilePath, { flags: 'a' });
    stream.on('error', (error) => {
      const message = `${new Date().toISOString()} [ERROR] Log file stream error for ${logFilePath}: ${format(error)}`;
      process.stderr.write(`${message}\n`);
    });
    destinations.push(stream);
    try {
      stream.write('');
    } catch (error) {
      const message = `${new Date().toISOString()} [ERROR] Failed to prime log file ${logFilePath}: ${format(error)}`;
      process.stderr.write(`${message}\n`);
    }
    process.on('exit', () => {
      try {
        stream.end();
      } catch (error) {
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
  for (const destination of destinations) {
    try {
      destination.write(line);
    } catch (error) {
      // If writing to a destination fails, fall back to stderr without recursion.
      if (destination !== process.stderr) {
        process.stderr.write(`${new Date().toISOString()} [ERROR] Failed to write log: ${format(error)}\n`);
      }
    }
  }
}

function writeCanonical(jsonLine: string): void {
  if (activeFormat === 'text') {
    return;
  }
  const line = `${jsonLine}\n`;
  if (logFilePath) {
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
