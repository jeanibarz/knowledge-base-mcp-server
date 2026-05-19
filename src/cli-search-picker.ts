// Interactive results picker for `kb search -i` (#215). Renders a TUI to
// stderr so piping `kb search ... -i | tee picked.md` keeps working: the
// chunk(s) chosen with Enter are written to stdout, the picker chrome is
// not. The data-flow is one-shot: we receive an already-computed result
// array and never re-query.

import * as readline from 'readline';
import {
  formatRetrievalAsMarkdown,
  groupRetrievalBySource,
  type GroupedRetrievalSource,
  type ScoredDocument,
} from './formatter.js';
import { FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI } from './config/retrieval.js';

export type PickerView = 'flat' | 'grouped';

export interface PickerState {
  results: ScoredDocument[];
  grouped: GroupedRetrievalSource[];
  view: PickerView;
  focusIndex: number;
  showHelp: boolean;
}

export interface PickerRenderOptions {
  rows: number;
  cols: number;
  color: boolean;
}

export interface PickerKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  shift?: boolean;
}

export type PickerAction =
  | { type: 'continue' }
  | { type: 'exit' }
  | { type: 'select'; view: PickerView; index: number };

export function createPickerState(results: ScoredDocument[]): PickerState {
  return {
    results,
    grouped: groupRetrievalBySource(results, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI),
    view: 'flat',
    focusIndex: 0,
    showHelp: false,
  };
}

export function pickerItemCount(state: PickerState): number {
  return state.view === 'flat' ? state.results.length : state.grouped.length;
}

export function renderPickerFrame(state: PickerState, opts: PickerRenderOptions): string {
  const count = pickerItemCount(state);
  const helpLines = state.showHelp ? helpBodyLines() : [];
  const reserved = 2 + helpLines.length + 1;
  const viewport = Math.max(3, opts.rows - reserved);

  const lines: string[] = [];
  lines.push(renderHeader(state, count, opts));
  lines.push('');

  if (count === 0) {
    lines.push('  (no results)');
  } else {
    const start = clamp(state.focusIndex - Math.floor(viewport / 2), 0, Math.max(0, count - viewport));
    const end = Math.min(count, start + viewport);
    for (let i = start; i < end; i += 1) {
      const focused = i === state.focusIndex;
      const row = state.view === 'flat'
        ? renderFlatRow(state.results[i], i)
        : renderGroupedRow(state.grouped[i], i);
      lines.push(renderRow(row, focused, opts));
    }
  }

  if (state.showHelp) {
    lines.push('');
    for (const helpLine of helpLines) lines.push(helpLine);
  } else {
    lines.push('');
    lines.push(renderFooterHint(opts));
  }

  return lines.join('\n');
}

export function applyKey(state: PickerState, key: PickerKey): { state: PickerState; action: PickerAction } {
  const count = pickerItemCount(state);
  const name = key.name ?? '';
  const seq = key.sequence ?? '';

  if (key.ctrl && name === 'c') return { state, action: { type: 'exit' } };
  if (name === 'return') {
    if (count === 0) return { state, action: { type: 'exit' } };
    return { state, action: { type: 'select', view: state.view, index: state.focusIndex } };
  }
  if (name === 'escape' || seq === 'q' || seq === 'Q') {
    return { state, action: { type: 'exit' } };
  }
  if (name === 'down' || seq === 'j') {
    return { state: { ...state, focusIndex: Math.min(Math.max(0, count - 1), state.focusIndex + 1) }, action: { type: 'continue' } };
  }
  if (name === 'up' || seq === 'k') {
    return { state: { ...state, focusIndex: Math.max(0, state.focusIndex - 1) }, action: { type: 'continue' } };
  }
  if (seq === 'g') {
    return { state: { ...state, focusIndex: 0 }, action: { type: 'continue' } };
  }
  if (seq === 'G') {
    return { state: { ...state, focusIndex: Math.max(0, count - 1) }, action: { type: 'continue' } };
  }
  if (seq === '?') {
    return { state: { ...state, showHelp: !state.showHelp }, action: { type: 'continue' } };
  }
  if (name === 'tab') {
    const nextView: PickerView = state.view === 'flat' ? 'grouped' : 'flat';
    const nextCount = nextView === 'flat' ? state.results.length : state.grouped.length;
    const nextFocus = Math.min(state.focusIndex, Math.max(0, nextCount - 1));
    return {
      state: { ...state, view: nextView, focusIndex: nextFocus },
      action: { type: 'continue' },
    };
  }
  return { state, action: { type: 'continue' } };
}

export function formatSelection(state: PickerState, action: { view: PickerView; index: number }): string {
  if (action.view === 'flat') {
    const doc = state.results[action.index];
    if (!doc) return '';
    return `${formatRetrievalAsMarkdown([doc], FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI)}\n`;
  }
  const group = state.grouped[action.index];
  if (!group) return '';
  const docs: ScoredDocument[] = group.chunks.map((chunk) => ({
    pageContent: chunk.content,
    metadata: chunk.metadata,
    score: chunk.score ?? undefined,
  }));
  return `${formatRetrievalAsMarkdown(docs, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI)}\n`;
}

export interface RunPickerOptions {
  results: ScoredDocument[];
  stdin?: NodeJS.ReadStream;
  stderr?: NodeJS.WriteStream;
  stdout?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
}

export async function runPicker(opts: RunPickerOptions): Promise<number> {
  const stdin = opts.stdin ?? process.stdin;
  const stderr = (opts.stderr ?? process.stderr) as NodeJS.WriteStream;
  const stdout = (opts.stdout ?? process.stdout) as NodeJS.WriteStream;
  const env = opts.env ?? process.env;

  let state = createPickerState(opts.results);
  const buildRenderOpts = (): PickerRenderOptions => ({
    rows: (stderr.rows && stderr.rows > 4) ? stderr.rows : 20,
    cols: stderr.columns ?? 80,
    color: pickerColorEnabled(env),
  });

  const wasRaw = stdin.isRaw === true;
  if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
  readline.emitKeypressEvents(stdin);
  stdin.resume();

  let lastFrameLines = 0;
  const renderFrame = (): void => {
    const frame = renderPickerFrame(state, buildRenderOpts());
    if (lastFrameLines > 0) {
      stderr.write(`\x1b[${lastFrameLines}A\x1b[J`);
    }
    stderr.write(`${frame}\n`);
    lastFrameLines = frame.split('\n').length + 1;
  };

  const teardown = (): void => {
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw);
    stdin.pause();
    if (lastFrameLines > 0) {
      stderr.write(`\x1b[${lastFrameLines}A\x1b[J`);
    }
  };

  renderFrame();

  return new Promise<number>((resolve) => {
    const onKey = (_str: string | undefined, key: PickerKey | undefined): void => {
      const next = applyKey(state, key ?? {});
      state = next.state;
      if (next.action.type === 'exit') {
        stdin.off('keypress', onKey);
        teardown();
        resolve(0);
        return;
      }
      if (next.action.type === 'select') {
        stdin.off('keypress', onKey);
        teardown();
        stdout.write(formatSelection(state, next.action));
        resolve(0);
        return;
      }
      renderFrame();
    };
    stdin.on('keypress', onKey);
  });
}

// -- helpers ----------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function pickerColorEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return true;
}

function renderHeader(state: PickerState, count: number, _opts: PickerRenderOptions): string {
  const noun = state.view === 'flat' ? 'chunk' : 'source';
  const plural = count === 1 ? noun : `${noun}s`;
  const viewTag = state.view === 'flat' ? 'flat' : 'grouped';
  const position = count === 0 ? '0/0' : `${state.focusIndex + 1}/${count}`;
  return `kb search · ${count} ${plural} · view=${viewTag} · ${position}`;
}

function renderFooterHint(_opts: PickerRenderOptions): string {
  return '[j/k] move  [Enter] open  [Tab] toggle view  [?] help  [q] quit';
}

function helpBodyLines(): string[] {
  return [
    'Keys:',
    '  j / Down     next result',
    '  k / Up       previous result',
    '  g            jump to top',
    '  G            jump to bottom',
    '  Tab          toggle flat / grouped-by-source view',
    '  Enter        print focused chunk to stdout and exit',
    '  ?            toggle this help',
    '  q / Esc      quit (no output)',
  ];
}

function renderFlatRow(doc: ScoredDocument | undefined, _idx: number): string {
  if (!doc) return '(missing result)';
  const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
  const score = doc.score === undefined ? 'n/a' : doc.score.toFixed(2);
  const source = pickSourceLabel(metadata);
  const preview = previewText(doc.pageContent);
  return `[${score}] ${source} — ${preview}`;
}

function renderGroupedRow(group: GroupedRetrievalSource | undefined, _idx: number): string {
  if (!group) return '(missing source)';
  const score = group.best_score === null ? 'n/a' : group.best_score.toFixed(2);
  const noun = group.chunk_count === 1 ? 'chunk' : 'chunks';
  return `[${score}] ${group.source} (${group.chunk_count} ${noun})`;
}

function renderRow(text: string, focused: boolean, opts: PickerRenderOptions): string {
  const marker = focused ? '>' : ' ';
  const body = `${marker} ${text}`;
  if (!focused) return `  ${body}`;
  if (!opts.color) return `* ${body}`;
  return `* \x1b[7m${body}\x1b[27m`;
}

function pickSourceLabel(metadata: Record<string, unknown>): string {
  const relative = metadata.relativePath;
  if (typeof relative === 'string' && relative.trim() !== '') return relative;
  const source = metadata.source;
  if (typeof source === 'string' && source.trim() !== '') return source;
  return '(unknown source)';
}

function previewText(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 80);
}
