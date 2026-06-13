import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const cliPath = path.join(process.cwd(), 'build', 'cli.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

let tempDir: string;
let kbRoot: string;
let faissPath: string;
let notePath: string;

beforeEach(async () => {
  tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-inspect-'));
  kbRoot = path.join(tempDir, 'knowledge-bases');
  faissPath = path.join(tempDir, 'faiss');
  const docsDir = path.join(kbRoot, 'alpha', 'docs');
  await fsp.mkdir(docsDir, { recursive: true });
  notePath = path.join(docsDir, 'note.md');
  await fsp.writeFile(notePath, [
    '---',
    'tags:',
    '  - ops',
    'title: Inspectable note',
    'status: active',
    '---',
    '',
    '# Runbook',
    '',
    'Restart workers when queue lag exceeds five minutes.',
    '',
    'Escalate if lag keeps growing after restart.',
  ].join('\n'), 'utf-8');
});

afterEach(async () => {
  await fsp.rm(tempDir, { recursive: true, force: true });
});

function runInspect(args: string[], extraEnv: Record<string, string> = {}): RunResult {
  const result = spawnSync('node', [cliPath, 'inspect', ...args], {
    env: {
      ...process.env,
      LOG_FILE: '',
      KB_LOG_FORMAT: 'text',
      KNOWLEDGE_BASES_ROOT_DIR: kbRoot,
      FAISS_INDEX_PATH: faissPath,
      EXTRACTION_TEXT_CACHE_DIR: path.join(tempDir, 'extraction-cache'),
      KB_CONTEXTUAL_RETRIEVAL: '',
      KB_LLM_FAKE: '',
      KB_INGEST_SECRET_SCAN: '',
      KB_CHUNK_SIZE: '80',
      KB_CHUNK_OVERLAP: '0',
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('kb inspect', () => {
  it('emits chunking diagnostics for a KB-relative path as JSON', () => {
    const result = runInspect(['alpha/docs/note.md', '--format=json']);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const body = JSON.parse(result.stdout) as Record<string, any>;
    expect(body).toMatchObject({
      schema_version: 'kb.inspect.v1',
      knowledgeBase: 'alpha',
      relativePath: 'alpha/docs/note.md',
      read_only: true,
      splitter: {
        type: 'markdown',
        chunk_size: 80,
        chunk_overlap: 0,
      },
      secret_scan: {
        verdict: 'disabled',
      },
      quarantine: {
        present: false,
      },
      contextual_preface: {
        generation_skipped: true,
        sidecar_exists: false,
      },
    });
    expect(body.path).toBe(notePath);
    expect(body.frontmatter.tags).toEqual(['ops']);
    expect(body.frontmatter.lifted_keys).toEqual(expect.arrayContaining(['status', 'title']));
    expect(body.chunks.length).toBeGreaterThan(0);
    expect(body.chunks[0]).toEqual(expect.objectContaining({
      chunk_index: 0,
      chars: expect.any(Number),
      bytes: expect.any(Number),
      normalized_text_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it('accepts kb:// references and local filesystem paths inside the KB root', () => {
    const uriResult = runInspect(['kb://alpha/docs/note.md', '--json']);
    const localResult = runInspect([notePath, '--json']);

    expect(uriResult.code).toBe(0);
    expect(localResult.code).toBe(0);
    expect(JSON.parse(uriResult.stdout).relativePath).toBe('alpha/docs/note.md');
    expect(JSON.parse(localResult.stdout).relativePath).toBe('alpha/docs/note.md');
  });

  it('reports secret-detected files as an inspect verdict instead of crashing', async () => {
    await fsp.writeFile(notePath, [
      '# Secret fixture',
      '',
      'token=abcDEF1234567890abcDEF1234567890',
    ].join('\n'), 'utf-8');

    const result = runInspect(['alpha/docs/note.md', '--json'], {
      KB_INGEST_SECRET_SCAN: 'on',
    });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const body = JSON.parse(result.stdout) as Record<string, any>;
    expect(body.secret_scan).toMatchObject({
      enabled: true,
      verdict: 'secret_detected',
      error_code: 'KB_INGEST_SECRET_DETECTED',
      locations: ['chunk'],
    });
    expect(body.secret_scan.categories).toContain('key_value_secret');
  });

  it('reads quarantine state without mutating it', async () => {
    const source = await fsp.readFile(notePath);
    const sourceSha = crypto.createHash('sha256').update(source).digest('hex');
    const manifestDir = path.join(kbRoot, 'alpha', '.index');
    await fsp.mkdir(manifestDir, { recursive: true });
    const record = {
      schema_version: 'ingest-quarantine.v1',
      reason: 'secret_detected',
      relative_path: 'docs/note.md',
      source_sha256: sourceSha,
      error_category: 'secret_detected',
      error_code: 'KB_INGEST_SECRET_DETECTED',
      error_fingerprint: `sha256:${'a'.repeat(64)}`,
      first_seen_at: '2026-06-13T10:00:00.000Z',
      last_attempted_at: '2026-06-13T10:00:00.000Z',
      retry_count: 1,
      next_retry_at: '2026-06-13T11:00:00.000Z',
      ack: false,
      dead_lettered_at: null,
      message: 'secret-like content detected in alpha/docs/note.md',
    };
    await fsp.writeFile(path.join(manifestDir, 'quarantine.jsonl'), `${JSON.stringify(record)}\n`, 'utf-8');

    const result = runInspect(['alpha/docs/note.md', '--json']);

    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as Record<string, any>;
    expect(body.quarantine).toMatchObject({
      present: true,
      source_sha256_matches: true,
      record: {
        relative_path: 'docs/note.md',
        error_category: 'secret_detected',
      },
    });
    await expect(fsp.readFile(path.join(manifestDir, 'quarantine.jsonl'), 'utf-8'))
      .resolves.toBe(`${JSON.stringify(record)}\n`);
  });

  it('does not generate contextual-preface sidecars during inspection', async () => {
    const result = runInspect(['alpha/docs/note.md', '--json'], {
      KB_CONTEXTUAL_RETRIEVAL: 'on',
      KB_LLM_FAKE: '1',
    });

    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as Record<string, any>;
    expect(body.contextual_preface).toMatchObject({
      enabled: true,
      generation_skipped: true,
      sidecar_exists: false,
    });
    await expect(fsp.stat(path.join(faissPath, '.contextual-prefaces')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('loads cache-backed formats without writing extracted-text cache misses', async () => {
    const csvPath = path.join(kbRoot, 'alpha', 'docs', 'table.csv');
    await fsp.writeFile(csvPath, 'name,value\nqueue,42\nworker,7\n', 'utf-8');

    const result = runInspect(['alpha/docs/table.csv', '--json']);

    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as Record<string, any>;
    expect(body.loader.extraction_cache).toMatchObject({
      applies: true,
      may_write_on_miss: false,
      entry_count_before: 0,
      entry_count_after: 0,
      changed_during_inspect: false,
    });
    await expect(fsp.stat(path.join(tempDir, 'extraction-cache')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
