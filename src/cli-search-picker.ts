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
  selectedFlatIndexes: Set<number>;
  showHelp: boolean;
  // Incremental "search-within-results" filter (#749). When `filterActive` is
  // true the picker is in filter-input mode: printable keys append to
  // `filterQuery`, which narrows the visible rows to a case-insensitive
  // substring match; Esc exits filter mode and restores the full list.
  filterActive: boolean;
  filterQuery: string;
  // Last-rendered visible window height, used to size page-wise motion
  // (PageUp/PageDown, Ctrl-U/Ctrl-D). runPicker keeps this in sync with the
  // terminal size on every render (#749).
  viewportRows: number;
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
    selectedFlatIndexes: new Set<number>(),
    showHelp: false,
    filterActive: false,
    filterQuery: '',
    viewportRows: 10,
  };
}

export function pickerItemCount(state: PickerState): number {
  return state.view === 'flat' ? state.results.length : state.grouped.length;
}

export function renderPickerFrame(state: PickerState, opts: PickerRenderOptions): string {
  const total = pickerItemCount(state);
  const visible = visibleIndexes(state);
  const count = visible.length;
  const helpLines = state.showHelp && !state.filterActive ? helpBodyLines() : [];
  const viewport = computeViewport(state, opts);
  const focusPos = Math.max(0, visible.indexOf(state.focusIndex));

  const lines: string[] = [];
  lines.push(renderHeader(state, { total, count, focusPos }));
  lines.push('');

  if (count === 0) {
    lines.push(state.filterActive && state.filterQuery !== '' ? '  (no matches)' : '  (no results)');
  } else {
    const start = clamp(focusPos - Math.floor(viewport / 2), 0, Math.max(0, count - viewport));
    const end = Math.min(count, start + viewport);
    for (let p = start; p < end; p += 1) {
      const i = visible[p];
      const focused = i === state.focusIndex;
      const row = state.view === 'flat'
        ? renderFlatRow(state.results[i], i, state.selectedFlatIndexes.has(i))
        : renderGroupedRow(state.grouped[i], i);
      lines.push(renderRow(row, focused, opts));
    }
  }

  lines.push('');
  if (state.filterActive) {
    lines.push(renderFilterLine(state));
  } else if (state.showHelp) {
    for (const helpLine of helpLines) lines.push(helpLine);
  } else {
    lines.push(renderFooterHint(state, opts));
  }

  return lines.join('\n');
}

export function applyKey(state: PickerState, key: PickerKey): { state: PickerState; action: PickerAction } {
  const name = key.name ?? '';
  const seq = key.sequence ?? '';

  // Ctrl-C always exits, in either mode.
  if (key.ctrl && name === 'c') return { state, action: { type: 'exit' } };

  // Half-page motion works in both normal and filter modes. Ctrl-D is bound to
  // half-page-down here (raw-mode keypress, not line-mode EOF), so it never
  // means quit — exit stays on Ctrl-C / q / Esc (#749).
  if (key.ctrl && name === 'd') return moveBy(state, halfPage(state));
  if (key.ctrl && name === 'u') return moveBy(state, -halfPage(state));

  if (state.filterActive) return applyFilterKey(state, key, name, seq);

  return applyNormalKey(state, key, name, seq);
}

function applyNormalKey(
  state: PickerState,
  key: PickerKey,
  name: string,
  seq: string,
): { state: PickerState; action: PickerAction } {
  const count = pickerItemCount(state);

  if (name === 'return') {
    if (count === 0) return { state, action: { type: 'exit' } };
    return { state, action: { type: 'select', view: state.view, index: state.focusIndex } };
  }
  if (name === 'space' || seq === ' ') {
    if (state.view !== 'flat' || count === 0) {
      return { state, action: { type: 'continue' } };
    }
    const selectedFlatIndexes = new Set(state.selectedFlatIndexes);
    if (selectedFlatIndexes.has(state.focusIndex)) {
      selectedFlatIndexes.delete(state.focusIndex);
    } else {
      selectedFlatIndexes.add(state.focusIndex);
    }
    return { state: { ...state, selectedFlatIndexes }, action: { type: 'continue' } };
  }
  if (name === 'escape' || seq === 'q' || seq === 'Q') {
    return { state, action: { type: 'exit' } };
  }
  if (name === 'down' || seq === 'j') return moveBy(state, 1);
  if (name === 'up' || seq === 'k') return moveBy(state, -1);
  if (name === 'pagedown') return moveBy(state, page(state));
  if (name === 'pageup') return moveBy(state, -page(state));
  if (seq === 'g') return moveToEdge(state, 'first');
  if (seq === 'G') return moveToEdge(state, 'last');
  if (seq === '/') {
    return { state: { ...state, filterActive: true, filterQuery: '' }, action: { type: 'continue' } };
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

// Filter-input mode (#749): printable keys extend the query, Backspace trims
// it, Esc exits and restores the full list, Enter selects the focused row
// (mapped back to its original result index by formatSelection), and the
// arrow/page keys move the focus within the narrowed set. The vi-style motion
// keys (j/k/g/G) and Space/? are treated as literal query text here.
function applyFilterKey(
  state: PickerState,
  key: PickerKey,
  name: string,
  seq: string,
): { state: PickerState; action: PickerAction } {
  if (name === 'return') {
    if (pickerItemCount(state) === 0) return { state, action: { type: 'exit' } };
    const visible = visibleIndexes(state);
    if (visible.length === 0) return { state, action: { type: 'continue' } };
    return { state, action: { type: 'select', view: state.view, index: state.focusIndex } };
  }
  if (name === 'escape') {
    return {
      state: reconcileFocus({ ...state, filterActive: false, filterQuery: '' }),
      action: { type: 'continue' },
    };
  }
  if (name === 'backspace') {
    return {
      state: reconcileFocus({ ...state, filterQuery: state.filterQuery.slice(0, -1) }),
      action: { type: 'continue' },
    };
  }
  if (name === 'down') return moveBy(state, 1);
  if (name === 'up') return moveBy(state, -1);
  if (name === 'pagedown') return moveBy(state, page(state));
  if (name === 'pageup') return moveBy(state, -page(state));
  // A single printable character (space through ~) extends the query.
  if (!key.ctrl && seq.length === 1 && seq >= ' ' && seq <= '~') {
    return {
      state: reconcileFocus({ ...state, filterQuery: state.filterQuery + seq }),
      action: { type: 'continue' },
    };
  }
  return { state, action: { type: 'continue' } };
}

export function formatSelection(state: PickerState, action: { view: PickerView; index: number }): string {
  const selectedDocs = selectedDocumentsInResultOrder(state);
  if (selectedDocs.length > 0) {
    return `${formatRetrievalAsMarkdown(selectedDocs, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI)}\n`;
  }
  if (action.view === 'flat') {
    const docs = [state.results[action.index]].filter((doc): doc is ScoredDocument => doc !== undefined);
    if (docs.length === 0) return '';
    return `${formatRetrievalAsMarkdown(docs, FRONTMATTER_EXTRAS_WIRE_VISIBLE, KB_EDITOR_URI)}\n`;
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
    const renderOpts = buildRenderOpts();
    // Keep the page-motion window height in step with the terminal size so
    // PageUp/PageDown and Ctrl-U/Ctrl-D move by what is actually drawn (#749).
    state = { ...state, viewportRows: computeViewport(state, renderOpts) };
    const frame = renderPickerFrame(state, renderOpts);
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

// The ordered list of item indices (into results/grouped for the active view)
// currently visible. With no active filter this is every index; while filtering
// it is the case-insensitive substring matches over the row text (#749).
function visibleIndexes(state: PickerState): number[] {
  const count = pickerItemCount(state);
  const all = Array.from({ length: count }, (_, i) => i);
  const query = state.filterActive ? state.filterQuery.trim().toLowerCase() : '';
  if (query === '') return all;
  return all.filter((i) => rowFilterText(state, i).includes(query));
}

function rowFilterText(state: PickerState, i: number): string {
  if (state.view === 'flat') {
    const doc = state.results[i];
    if (!doc) return '';
    const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
    return `${pickSourceLabel(metadata)} ${doc.pageContent}`.toLowerCase();
  }
  const group = state.grouped[i];
  return group ? group.source.toLowerCase() : '';
}

// Move the focus by `delta` positions within the visible (possibly filtered)
// set, clamping to its bounds. Keeps focus on a matching row when a filter is
// active (#749).
function moveBy(state: PickerState, delta: number): { state: PickerState; action: PickerAction } {
  const visible = visibleIndexes(state);
  if (visible.length === 0) return { state, action: { type: 'continue' } };
  const pos = visible.indexOf(state.focusIndex);
  const from = pos < 0 ? 0 : pos;
  const next = clamp(from + delta, 0, visible.length - 1);
  return { state: { ...state, focusIndex: visible[next] }, action: { type: 'continue' } };
}

function moveToEdge(state: PickerState, edge: 'first' | 'last'): { state: PickerState; action: PickerAction } {
  const visible = visibleIndexes(state);
  if (visible.length === 0) return { state, action: { type: 'continue' } };
  const focusIndex = edge === 'first' ? visible[0] : visible[visible.length - 1];
  return { state: { ...state, focusIndex }, action: { type: 'continue' } };
}

// Ensure the focus lands on a visible row after the filter set changes; if the
// current focus was filtered out, snap to the first remaining match (#749).
function reconcileFocus(state: PickerState): PickerState {
  const visible = visibleIndexes(state);
  if (visible.length === 0) return state;
  if (visible.includes(state.focusIndex)) return state;
  return { ...state, focusIndex: visible[0] };
}

function page(state: PickerState): number {
  return Math.max(1, state.viewportRows);
}

function halfPage(state: PickerState): number {
  return Math.max(1, Math.floor(state.viewportRows / 2));
}

// Height of the row window, given the terminal size and the chrome (header,
// blank spacers, and the footer / help / filter trailer) that surrounds it.
// Shared by the renderer and by runPicker so page-wise motion matches what is
// actually drawn (#749).
function computeViewport(state: PickerState, opts: PickerRenderOptions): number {
  const trailer = state.filterActive ? 1 : state.showHelp ? helpBodyLines().length : 1;
  const reserved = 2 + 1 + trailer;
  return Math.max(3, opts.rows - reserved);
}

function pickerColorEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return true;
}

function renderHeader(
  state: PickerState,
  counts: { total: number; count: number; focusPos: number },
): string {
  const { total, count, focusPos } = counts;
  const noun = state.view === 'flat' ? 'chunk' : 'source';
  const plural = total === 1 ? noun : `${noun}s`;
  const viewTag = state.view === 'flat' ? 'flat' : 'grouped';
  const position = count === 0 ? '0/0' : `${focusPos + 1}/${count}`;
  const filtering = state.filterActive && state.filterQuery !== '';
  const filteredText = filtering ? ` · filtered ${count}/${total}` : '';
  const selected = state.selectedFlatIndexes.size;
  const selectedText = selected > 0 ? ` · selected=${selected}` : '';
  return `kb search · ${total} ${plural} · view=${viewTag} · ${position}${filteredText}${selectedText}`;
}

function renderFilterLine(state: PickerState): string {
  return `filter: /${state.filterQuery}  [Enter] print  [Esc] clear  [Up/Down] move`;
}

function renderFooterHint(state: PickerState, _opts: PickerRenderOptions): string {
  if (state.view === 'grouped') {
    const enter = state.selectedFlatIndexes.size > 0 ? '[Enter] print marks' : '[Enter] print source';
    return `[j/k] move  [PgUp/PgDn] page  [/] filter  ${enter}  [Tab] toggle view  [?] help  [q] quit`;
  }
  return '[j/k] move  [PgUp/PgDn] page  [/] filter  [Space] mark  [Enter] print  [Tab] toggle view  [?] help  [q] quit';
}

function helpBodyLines(): string[] {
  return [
    'Keys:',
    '  j / Down     next result',
    '  k / Up       previous result',
    '  PgDn / PgUp  page down / up',
    '  Ctrl-D/Ctrl-U  half page down / up',
    '  g            jump to top',
    '  G            jump to bottom',
    '  /            filter results (type to narrow, Esc clears, Enter selects)',
    '  Space        mark / unmark focused chunk in flat view',
    '  Tab          toggle flat / grouped-by-source view',
    '  Enter        print marked chunks, or focused row/source if none are marked',
    '  ?            toggle this help',
    '  q / Esc      quit (no output)',
  ];
}

function renderFlatRow(doc: ScoredDocument | undefined, _idx: number, selected: boolean): string {
  if (!doc) return '(missing result)';
  const metadata = (doc.metadata ?? {}) as Record<string, unknown>;
  const score = doc.score === undefined ? 'n/a' : doc.score.toFixed(2);
  const source = pickSourceLabel(metadata);
  const preview = previewText(doc.pageContent);
  const selectedMark = selected ? '[x]' : '[ ]';
  return `${selectedMark} [${score}] ${source} — ${preview}`;
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

function selectedDocumentsInResultOrder(state: PickerState): ScoredDocument[] {
  return Array.from(state.selectedFlatIndexes)
    .filter((idx) => idx >= 0 && idx < state.results.length)
    .sort((a, b) => a - b)
    .map((idx) => state.results[idx])
    .filter((doc): doc is ScoredDocument => doc !== undefined);
}
