// Issue #652 — structure-aware Jupyter notebook (`.ipynb`) loader tests.
//
// Two layers:
//   - `formatNotebook` directly: per-cell blocks, preserved cell-type/position
//     context, selected-output folding, image/binary dropping, and nbformat v3
//     back-compat.
//   - `loadFile` dispatch: a `.ipynb` extension routes through the notebook
//     loader (not the default UTF-8 text loader), and malformed JSON degrades
//     to verbatim text rather than aborting ingest.

import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { formatNotebook } from './loaders-ipynb.js';
import { getLoader, LOADERS, loadFile, SUPPORTED_LOADER_EXTENSIONS } from './loaders.js';

// A small nbformat v4 notebook: one markdown cell, one code cell with a
// stream + text/plain + image output, and one code cell raising an error.
function sampleNotebookV4(): string {
  return JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        cell_type: 'markdown',
        metadata: {},
        source: ['# Sales analysis\n', '\n', 'Load the data and compute totals.'],
      },
      {
        cell_type: 'code',
        execution_count: 1,
        metadata: {},
        source: ['import pandas as pd\n', "df = pd.read_csv('sales.csv')\n", 'df.head()'],
        outputs: [
          { output_type: 'stream', name: 'stdout', text: ['loaded 1000 rows\n'] },
          {
            output_type: 'execute_result',
            execution_count: 1,
            data: {
              'text/plain': ['   id  amount\n', '0   1     100'],
              'image/png': 'iVBORw0KGgoAAAANSUhEUgAA…',
            },
            metadata: {},
          },
        ],
      },
      {
        cell_type: 'code',
        execution_count: 2,
        metadata: {},
        source: ['1 / 0'],
        outputs: [
          {
            output_type: 'error',
            ename: 'ZeroDivisionError',
            evalue: 'division by zero',
            traceback: ['[0;31m---[0m', 'ZeroDivisionError: division by zero'],
          },
        ],
      },
    ],
  });
}

describe('formatNotebook — per-cell structure-aware blocks', () => {
  it('emits one labelled block per cell with type and 1-based position context', () => {
    const text = formatNotebook(sampleNotebookV4(), '/kb/sales.ipynb');

    expect(text).toContain('source_path: sales.ipynb');
    expect(text).toContain('cell 1/3 (markdown):');
    expect(text).toContain('cell 2/3 (code):');
    expect(text).toContain('cell 3/3 (code):');
  });

  it('preserves the markdown narrative and code source verbatim', () => {
    const text = formatNotebook(sampleNotebookV4(), '/kb/sales.ipynb');

    expect(text).toContain('# Sales analysis');
    expect(text).toContain('Load the data and compute totals.');
    expect(text).toContain("df = pd.read_csv('sales.csv')");
  });

  it('folds textual outputs (stream, text/plain) into the code cell block', () => {
    const text = formatNotebook(sampleNotebookV4(), '/kb/sales.ipynb');

    expect(text).toContain('output:');
    expect(text).toContain('loaded 1000 rows');
    expect(text).toContain('id  amount');
  });

  it('drops binary/image outputs from the embeddable text', () => {
    const text = formatNotebook(sampleNotebookV4(), '/kb/sales.ipynb');

    expect(text).not.toContain('image/png');
    expect(text).not.toContain('iVBORw0KGgo');
  });

  it('summarises an error output as `ename: evalue` and drops the ANSI traceback', () => {
    const text = formatNotebook(sampleNotebookV4(), '/kb/sales.ipynb');

    expect(text).toContain('ZeroDivisionError: division by zero');
    expect(text).not.toContain('[0;31m');
  });

  it('keeps cells separated by a blank line so the splitter prefers cell boundaries', () => {
    const text = formatNotebook(sampleNotebookV4(), '/kb/sales.ipynb');
    // Each cell header sits at the start of a line; consecutive cells are
    // separated by an empty line.
    expect(text).toMatch(/\n\ncell 2\/3 \(code\):/);
    expect(text).toMatch(/\n\ncell 3\/3 \(code\):/);
  });

  it('truncates runaway cell output instead of dumping it whole', () => {
    const huge = 'x'.repeat(5000);
    const notebook = JSON.stringify({
      nbformat: 4,
      cells: [
        {
          cell_type: 'code',
          source: ['print("noise")'],
          outputs: [{ output_type: 'stream', name: 'stdout', text: [huge] }],
        },
      ],
    });

    const text = formatNotebook(notebook, '/kb/noisy.ipynb');

    expect(text).toContain('… [output truncated]');
    expect(text.length).toBeLessThan(huge.length);
  });

  it('handles nbformat v3 worksheets and code cells that use `input`', () => {
    const v3 = JSON.stringify({
      nbformat: 3,
      worksheets: [
        {
          cells: [
            { cell_type: 'markdown', source: ['## Legacy notebook'] },
            { cell_type: 'code', input: ['print("hi")'], outputs: [] },
          ],
        },
      ],
    });

    const text = formatNotebook(v3, '/kb/legacy.ipynb');

    expect(text).toContain('cell 1/2 (markdown):');
    expect(text).toContain('## Legacy notebook');
    expect(text).toContain('cell 2/2 (code):');
    expect(text).toContain('print("hi")');
  });

  it('yields just the header for a well-formed but non-notebook JSON document', () => {
    const text = formatNotebook('{"hello": "world"}', '/kb/config.ipynb');
    expect(text).toBe('source_path: config.ipynb');
  });
});

describe('loadFile dispatch — `.ipynb` routing', () => {
  let tempDir = '';
  let priorCacheDir: string | undefined;

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-loaders-ipynb-'));
    priorCacheDir = process.env.EXTRACTION_TEXT_CACHE_DIR;
    process.env.EXTRACTION_TEXT_CACHE_DIR = path.join(tempDir, 'extraction-cache');
  });

  afterEach(async () => {
    if (priorCacheDir === undefined) delete process.env.EXTRACTION_TEXT_CACHE_DIR;
    else process.env.EXTRACTION_TEXT_CACHE_DIR = priorCacheDir;
    await fsp.rm(tempDir, { recursive: true, force: true });
  });

  it('registers `.ipynb` in the loader registry', () => {
    expect(SUPPORTED_LOADER_EXTENSIONS).toContain('.ipynb');
    expect(getLoader('/kb/x.ipynb')).toBe(LOADERS['.ipynb']);
  });

  it('routes a `.ipynb` file through the notebook loader, not the text loader', async () => {
    const filePath = path.join(tempDir, 'analysis.ipynb');
    await fsp.writeFile(filePath, sampleNotebookV4());

    const text = await loadFile(filePath);

    expect(getLoader(filePath)).toBe(LOADERS['.ipynb']);
    expect(text).toContain('source_path: analysis.ipynb');
    expect(text).toContain('cell 1/3 (markdown):');
    expect(text).toContain('# Sales analysis');
    // Not the raw JSON blob the default text loader would have returned.
    expect(text).not.toContain('"cell_type"');
  });

  it('degrades malformed notebook JSON to verbatim text instead of throwing', async () => {
    const filePath = path.join(tempDir, 'broken.ipynb');
    await fsp.writeFile(filePath, '{ this is not valid json');

    await expect(loadFile(filePath)).resolves.toBe('{ this is not valid json');
  });
});
