// Issue #652 — structure-aware Jupyter notebook (`.ipynb`) ingest loader.
//
// A notebook is JSON, so without a dedicated loader it would either be skipped
// (no extension match) or — if opted in via `INGEST_EXTRA_EXTENSIONS=.ipynb`
// against the default text loader — ingested as one opaque JSON blob. That
// flattens the notebook's natural structure: markdown narrative, code, and
// outputs all dissolve into a single string of escaped JSON, so a chunk could
// straddle the boundary between two unrelated cells and retrieval loses the
// "this code does X, the prose above explains why" adjacency.
//
// This module mirrors the CSV/TSV structure-aware precedent (#592 / PR #605):
// it parses the notebook and re-emits one labelled block per cell, preserving
// cell position (`cell N/total`) and type (`markdown` / `code` / `raw`) as a
// short context preface. Code cells additionally fold in selected textual
// outputs (stdout/stderr streams, `text/plain` results, error name+value).
// Blocks are separated by a blank line so the downstream recursive splitter
// prefers cell boundaries when a notebook exceeds one chunk.
//
// Output handling (smallest sensible default; see PR description for the
// alternatives weighed):
//   - Included: stream text, `execute_result` / `display_data` `text/plain`,
//     and `error` `ename: evalue`. These are the textual, embeddable outputs.
//   - Dropped: images and any other binary/rich MIME bundle (`image/png`,
//     `application/*`, …) — they carry no embeddable text.
//   - Error tracebacks are summarised to `ename: evalue` rather than dumping
//     the full ANSI-coded stack, which is mostly noise for retrieval.
//   - Per-cell output text is truncated to keep a single noisy cell from
//     dominating its block.
//
// Format support: nbformat v4 (`cells[]`) is the primary target. v3 notebooks
// (`worksheets[].cells[]`, code cells using `input` instead of `source`) are
// flattened best-effort so older exports still ingest rather than throwing.

import * as path from 'path';

/** Max characters of textual output folded into a single code cell's block. */
const MAX_CELL_OUTPUT_CHARS = 1200;

interface NotebookOutput {
  output_type?: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, unknown>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface NotebookCell {
  cell_type?: string;
  source?: string | string[];
  /** nbformat v3 code cells store their source under `input`. */
  input?: string | string[];
  outputs?: NotebookOutput[];
}

interface NotebookWorksheet {
  cells?: NotebookCell[];
}

interface Notebook {
  cells?: NotebookCell[];
  worksheets?: NotebookWorksheet[];
  nbformat?: number;
}

/** Notebook `source`/`text` fields are either a string or a string[] of lines. */
function joinMultiline(value: string | string[] | undefined): string {
  if (value === undefined) return '';
  return Array.isArray(value) ? value.join('') : value;
}

/** Collapse a value to a printable string for `text/plain` MIME bundles. */
function stringifyTextPlain(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : '')).join('');
  return '';
}

/**
 * Extract the embeddable text from a single output, dropping binary/rich MIME
 * bundles. Returns an empty string when the output carries no textual payload
 * (e.g. an image-only `display_data`).
 */
function formatOutput(output: NotebookOutput): string {
  switch (output.output_type) {
    case 'stream':
      return joinMultiline(output.text);
    case 'execute_result':
    case 'display_data': {
      const data = output.data ?? {};
      return stringifyTextPlain(data['text/plain']);
    }
    case 'error': {
      const ename = output.ename ?? 'Error';
      const evalue = output.evalue ?? '';
      return evalue ? `${ename}: ${evalue}` : ename;
    }
    default:
      return '';
  }
}

/** Join the textual outputs of a code cell, truncating runaway output. */
function formatCellOutputs(outputs: NotebookOutput[] | undefined): string {
  if (!outputs || outputs.length === 0) return '';
  const parts = outputs
    .map(formatOutput)
    .map((part) => part.trimEnd())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return '';
  const joined = parts.join('\n');
  if (joined.length <= MAX_CELL_OUTPUT_CHARS) return joined;
  return `${joined.slice(0, MAX_CELL_OUTPUT_CHARS)}\n… [output truncated]`;
}

/** Flatten a notebook's cells across nbformat v4 (`cells`) and v3 (`worksheets`). */
function collectCells(notebook: Notebook): NotebookCell[] {
  if (Array.isArray(notebook.cells)) return notebook.cells;
  if (Array.isArray(notebook.worksheets)) {
    return notebook.worksheets.flatMap((sheet) => sheet.cells ?? []);
  }
  return [];
}

function formatCell(
  cell: NotebookCell,
  cellNumber: number,
  totalCells: number,
): string {
  const cellType = typeof cell.cell_type === 'string' && cell.cell_type.length > 0
    ? cell.cell_type
    : 'unknown';
  // v4 markdown/raw use `source`; v3 code cells use `input`.
  const body = joinMultiline(cell.source ?? cell.input).trimEnd();
  const header = `cell ${cellNumber}/${totalCells} (${cellType}):`;
  const lines = [header];
  if (body.length > 0) lines.push(body);
  if (cellType === 'code') {
    const outputs = formatCellOutputs(cell.outputs);
    if (outputs.length > 0) {
      lines.push('output:');
      lines.push(outputs);
    }
  }
  return lines.join('\n');
}

/**
 * Parse a notebook's raw JSON and re-emit it as structure-aware plain text:
 * a `source_path` header followed by one blank-line-separated block per cell,
 * each prefaced with its 1-based position, total count, and cell type.
 *
 * Throws `SyntaxError` on malformed JSON (the caller surfaces it as a parse
 * failure, consistent with the {@link Loader} contract). A well-formed JSON
 * document that is not notebook-shaped (no `cells`/`worksheets`) yields just
 * the header, which is harmless and keeps the file ingestable.
 */
export function formatNotebook(raw: string, filePath: string): string {
  const notebook = JSON.parse(raw) as Notebook;
  const cells = collectCells(notebook);
  const header = `source_path: ${path.basename(filePath)}`;
  if (cells.length === 0) return header;
  const blocks = cells.map((cell, index) => formatCell(cell, index + 1, cells.length));
  return [header, '', ...interleaveBlankLines(blocks)].join('\n').trimEnd();
}

/** Join blocks with a single blank line between them. */
function interleaveBlankLines(blocks: readonly string[]): string[] {
  const out: string[] = [];
  blocks.forEach((block, index) => {
    if (index > 0) out.push('');
    out.push(block);
  });
  return out;
}
