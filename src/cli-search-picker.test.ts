import { describe, expect, it } from '@jest/globals';
import {
  applyKey,
  createPickerState,
  formatSelection,
  pickerItemCount,
  renderPickerFrame,
  type PickerKey,
  type PickerRenderOptions,
  type PickerState,
} from './cli-search-picker.js';
import type { ScoredDocument } from './formatter.js';

function makeDoc(idx: number, source: string, content: string, score: number): ScoredDocument {
  return {
    pageContent: content,
    metadata: {
      knowledgeBase: 'demo',
      relativePath: `demo/${source}`,
      source: `/abs/demo/${source}`,
      loc: { lines: { from: idx + 1, to: idx + 4 } },
    },
    score,
  };
}

const RENDER_OPTS: PickerRenderOptions = { rows: 24, cols: 80, color: false };

function makeState(): PickerState {
  return createPickerState([
    makeDoc(0, 'a.md', 'alpha content about rollback', 0.21),
    makeDoc(1, 'b.md', 'bravo content about deploy', 0.28),
    makeDoc(2, 'a.md', 'alpha content take two', 0.31),
  ]);
}

describe('createPickerState', () => {
  it('starts in flat view, focused on the first row, help off', () => {
    const s = makeState();
    expect(s.view).toBe('flat');
    expect(s.focusIndex).toBe(0);
    expect(s.selectedFlatIndexes.size).toBe(0);
    expect(s.showHelp).toBe(false);
    expect(pickerItemCount(s)).toBe(3);
  });

  it('pre-computes a grouped-by-source view so toggling does not re-query', () => {
    const s = makeState();
    expect(s.grouped).toHaveLength(2);
    expect(s.grouped[0].chunk_count).toBe(2);
    expect(s.grouped[1].chunk_count).toBe(1);
    // Both groups derive their source label from the chunk metadata, so the
    // exact string depends on the formatter's getSourcePath() preference order
    // (`source` field beats `relativePath`). Just assert the file names are
    // present and the two groups are distinct.
    expect(s.grouped[0].source).toMatch(/a\.md$/);
    expect(s.grouped[1].source).toMatch(/b\.md$/);
    expect(s.grouped[0].source).not.toBe(s.grouped[1].source);
  });
});

describe('applyKey navigation', () => {
  it('j / Down advances focus, stopping at the last row', () => {
    let s = makeState();
    s = applyKey(s, { sequence: 'j' }).state;
    expect(s.focusIndex).toBe(1);
    s = applyKey(s, { name: 'down' }).state;
    expect(s.focusIndex).toBe(2);
    // hits the bottom
    s = applyKey(s, { sequence: 'j' }).state;
    expect(s.focusIndex).toBe(2);
  });

  it('k / Up rewinds focus, stopping at the first row', () => {
    let s = makeState();
    s.focusIndex = 2;
    s = applyKey(s, { sequence: 'k' }).state;
    expect(s.focusIndex).toBe(1);
    s = applyKey(s, { name: 'up' }).state;
    expect(s.focusIndex).toBe(0);
    s = applyKey(s, { sequence: 'k' }).state;
    expect(s.focusIndex).toBe(0);
  });

  it('g / G jump to the top and bottom of the list', () => {
    let s = makeState();
    s.focusIndex = 1;
    s = applyKey(s, { sequence: 'G', shift: true }).state;
    expect(s.focusIndex).toBe(2);
    s = applyKey(s, { sequence: 'g' }).state;
    expect(s.focusIndex).toBe(0);
  });

  it('? toggles the help footer', () => {
    let s = makeState();
    s = applyKey(s, { sequence: '?' }).state;
    expect(s.showHelp).toBe(true);
    s = applyKey(s, { sequence: '?' }).state;
    expect(s.showHelp).toBe(false);
  });

  it('Tab toggles between flat and grouped views without re-querying', () => {
    let s = makeState();
    s = applyKey(s, { name: 'tab' }).state;
    expect(s.view).toBe('grouped');
    expect(pickerItemCount(s)).toBe(2);
    // Switching back keeps the original 3 chunks
    s = applyKey(s, { name: 'tab' }).state;
    expect(s.view).toBe('flat');
    expect(pickerItemCount(s)).toBe(3);
  });

  it('clamps the focus index when toggling into a smaller grouped view', () => {
    let s = makeState();
    s.focusIndex = 2;
    s = applyKey(s, { name: 'tab' }).state;
    expect(s.view).toBe('grouped');
    expect(s.focusIndex).toBe(1);
  });

  it('q / Esc / Ctrl-C signal an exit (no selection)', () => {
    const s = makeState();
    expect(applyKey(s, { sequence: 'q' }).action).toEqual({ type: 'exit' });
    expect(applyKey(s, { name: 'escape' }).action).toEqual({ type: 'exit' });
    expect(applyKey(s, { name: 'c', ctrl: true }).action).toEqual({ type: 'exit' });
  });

  it('Enter selects the focused row and reports the chosen view', () => {
    let s = makeState();
    s = applyKey(s, { sequence: 'j' }).state;
    const r = applyKey(s, { name: 'return' });
    expect(r.action).toEqual({ type: 'select', view: 'flat', index: 1 });
  });

  it('Space marks and unmarks the focused flat row', () => {
    let s = makeState();
    s = applyKey(s, { sequence: 'j' }).state;

    s = applyKey(s, { name: 'space' }).state;
    expect(Array.from(s.selectedFlatIndexes)).toEqual([1]);

    s = applyKey(s, { sequence: ' ' }).state;
    expect(Array.from(s.selectedFlatIndexes)).toEqual([]);
  });

  it('Space is a no-op in grouped view', () => {
    let s = makeState();
    s = applyKey(s, { name: 'space' }).state;
    s = applyKey(s, { name: 'tab' }).state;
    const r = applyKey(s, { name: 'space' });
    expect(r.action).toEqual({ type: 'continue' });
    expect(Array.from(r.state.selectedFlatIndexes)).toEqual([0]);
  });

  it('Enter on an empty result list exits with no selection', () => {
    const s = createPickerState([]);
    const r = applyKey(s, { name: 'return' });
    expect(r.action).toEqual({ type: 'exit' });
  });

  it('unknown keys are no-ops', () => {
    const s = makeState();
    const r = applyKey(s, { sequence: 'x' });
    expect(r.action).toEqual({ type: 'continue' });
    expect(r.state).toEqual(s);
  });
});

function makeBigState(n: number): PickerState {
  const s = createPickerState(
    Array.from({ length: n }, (_, i) => makeDoc(i, `f${i}.md`, `body number ${i}`, i / 100)),
  );
  s.viewportRows = 10;
  return s;
}

describe('applyKey page-wise navigation', () => {
  it('PageDown / PageUp move the focus by a full window height', () => {
    let s = makeBigState(50);
    s = applyKey(s, { name: 'pagedown' }).state;
    expect(s.focusIndex).toBe(10);
    s = applyKey(s, { name: 'pagedown' }).state;
    expect(s.focusIndex).toBe(20);
    s = applyKey(s, { name: 'pageup' }).state;
    expect(s.focusIndex).toBe(10);
  });

  it('PageDown clamps at the last row', () => {
    let s = makeBigState(15);
    s.focusIndex = 10;
    s = applyKey(s, { name: 'pagedown' }).state;
    expect(s.focusIndex).toBe(14);
  });

  it('Ctrl-D / Ctrl-U move the focus by a half window height', () => {
    let s = makeBigState(50);
    s = applyKey(s, { name: 'd', ctrl: true }).state;
    expect(s.focusIndex).toBe(5);
    s = applyKey(s, { name: 'd', ctrl: true }).state;
    expect(s.focusIndex).toBe(10);
    s = applyKey(s, { name: 'u', ctrl: true }).state;
    expect(s.focusIndex).toBe(5);
  });

  it('Ctrl-D never signals an exit (distinct from EOF/quit)', () => {
    const s = makeBigState(50);
    const r = applyKey(s, { name: 'd', ctrl: true });
    expect(r.action).toEqual({ type: 'continue' });
  });
});

describe('applyKey incremental filter', () => {
  it('/ enters filter mode with an empty query', () => {
    const s = makeState();
    const r = applyKey(s, { sequence: '/' });
    expect(r.state.filterActive).toBe(true);
    expect(r.state.filterQuery).toBe('');
    expect(r.action).toEqual({ type: 'continue' });
  });

  it('typing narrows the visible set and snaps focus to the first match', () => {
    let s = makeState();
    s = applyKey(s, { sequence: '/' }).state;
    // "bravo" only appears in the second doc (index 1).
    for (const ch of 'bravo') s = applyKey(s, { sequence: ch }).state;
    expect(s.filterQuery).toBe('bravo');
    expect(pickerItemCount(s)).toBe(3); // underlying item count is unchanged
    expect(s.focusIndex).toBe(1); // focus snapped onto the only match
  });

  it('vi-motion keys are literal query text while filtering', () => {
    let s = makeState();
    s = applyKey(s, { sequence: '/' }).state;
    s = applyKey(s, { sequence: 'j' }).state;
    expect(s.filterQuery).toBe('j');
    expect(s.focusIndex).toBe(0); // did not navigate
  });

  it('Enter within a filter selects the correct original result index', () => {
    let s = makeState();
    s = applyKey(s, { sequence: '/' }).state;
    for (const ch of 'take two') s = applyKey(s, { sequence: ch }).state;
    // "take two" matches only the third doc (index 2).
    expect(s.focusIndex).toBe(2);
    const r = applyKey(s, { name: 'return' });
    expect(r.action).toEqual({ type: 'select', view: 'flat', index: 2 });
    // The selection maps back to the original document.
    const out = formatSelection(r.state, { view: 'flat', index: 2 });
    expect(out).toMatch(/alpha content take two/);
  });

  it('Down / Up move within the filtered set', () => {
    let s = makeState();
    s = applyKey(s, { sequence: '/' }).state;
    // "alpha" matches docs 0 and 2.
    for (const ch of 'alpha') s = applyKey(s, { sequence: ch }).state;
    expect(s.focusIndex).toBe(0);
    s = applyKey(s, { name: 'down' }).state;
    expect(s.focusIndex).toBe(2); // skips the non-matching doc 1
    s = applyKey(s, { name: 'down' }).state;
    expect(s.focusIndex).toBe(2); // clamps at the last match
    s = applyKey(s, { name: 'up' }).state;
    expect(s.focusIndex).toBe(0);
  });

  it('Backspace trims the query and re-widens the visible set', () => {
    let s = makeState();
    s = applyKey(s, { sequence: '/' }).state;
    for (const ch of 'bravo') s = applyKey(s, { sequence: ch }).state;
    s = applyKey(s, { name: 'backspace' }).state;
    expect(s.filterQuery).toBe('brav');
    s = applyKey(s, { name: 'backspace' }).state;
    s = applyKey(s, { name: 'backspace' }).state;
    s = applyKey(s, { name: 'backspace' }).state;
    s = applyKey(s, { name: 'backspace' }).state;
    expect(s.filterQuery).toBe('');
  });

  it('Esc clears the filter and restores the full list without exiting', () => {
    let s = makeState();
    s.focusIndex = 2;
    s = applyKey(s, { sequence: '/' }).state;
    for (const ch of 'bravo') s = applyKey(s, { sequence: ch }).state;
    expect(s.focusIndex).toBe(1);
    const r = applyKey(s, { name: 'escape' });
    expect(r.action).toEqual({ type: 'continue' }); // does NOT exit in filter mode
    expect(r.state.filterActive).toBe(false);
    expect(r.state.filterQuery).toBe('');
    expect(pickerItemCount(r.state)).toBe(3);
  });

  it('Ctrl-C still exits from within filter mode', () => {
    let s = makeState();
    s = applyKey(s, { sequence: '/' }).state;
    const r = applyKey(s, { name: 'c', ctrl: true });
    expect(r.action).toEqual({ type: 'exit' });
  });
});

describe('renderPickerFrame', () => {
  it('shows a header with the result count and focus position', () => {
    const out = renderPickerFrame(makeState(), RENDER_OPTS);
    expect(out).toMatch(/3 chunks/);
    expect(out).toMatch(/view=flat/);
    expect(out).toMatch(/1\/3/);
  });

  it('shows selected count when flat rows are marked', () => {
    let s = makeState();
    s = applyKey(s, { name: 'space' }).state;
    s = applyKey(s, { sequence: 'j' }).state;
    s = applyKey(s, { name: 'space' }).state;

    const out = renderPickerFrame(s, RENDER_OPTS);
    expect(out).toMatch(/selected=2/);
  });

  it('renders marked and unmarked flat row markers', () => {
    let s = makeState();
    s = applyKey(s, { name: 'space' }).state;

    const out = renderPickerFrame(s, RENDER_OPTS);
    expect(out).toMatch(/\[x\] \[0\.21\] .*alpha content about rollback/);
    expect(out).toMatch(/\[ \] \[0\.28\] .*bravo content about deploy/);
  });

  it('renders one row per result and marks the focused row', () => {
    const out = renderPickerFrame(makeState(), RENDER_OPTS);
    expect(out).toMatch(/demo\/a\.md/);
    expect(out).toMatch(/demo\/b\.md/);
    // marker for focused row ("* > " prefix; unfocused rows start with four
    // leading spaces and no caret).
    expect(out).toMatch(/\* > .*alpha content about rollback/);
    expect(out).not.toMatch(/\* > .*bravo/);
  });

  it('emits no ANSI escape sequences when color is disabled', () => {
    const out = renderPickerFrame(makeState(), RENDER_OPTS);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x1b\[/);
  });

  it('emits an inverse-video ANSI sequence around the focused row when color is enabled', () => {
    const out = renderPickerFrame(makeState(), { ...RENDER_OPTS, color: true });
    // eslint-disable-next-line no-control-regex
    expect(out).toMatch(/\x1b\[7m.*demo\/a\.md.*\x1b\[27m/);
  });

  it('renders a help body when help is toggled on', () => {
    let s = makeState();
    s = applyKey(s, { sequence: '?' }).state;
    const out = renderPickerFrame(s, RENDER_OPTS);
    expect(out).toMatch(/Keys:/);
    expect(out).toMatch(/j \/ Down/);
    expect(out).toMatch(/Space\s+mark \/ unmark focused chunk/);
    expect(out).toMatch(/print marked chunks/);
  });

  it('shows a short footer hint when help is collapsed', () => {
    const out = renderPickerFrame(makeState(), RENDER_OPTS);
    expect(out).toMatch(/\[Space\] mark/);
    expect(out).toMatch(/\[Enter\] print/);
    expect(out).toMatch(/\[Tab\] toggle view/);
    expect(out).not.toMatch(/Keys:/);
  });

  it('uses grouped footer copy that does not advertise Space marking', () => {
    let s = makeState();
    s = applyKey(s, { name: 'tab' }).state;

    const out = renderPickerFrame(s, RENDER_OPTS);
    expect(out).toMatch(/\[Enter\] print source/);
    expect(out).not.toMatch(/\[Space\] mark/);
  });

  it('reports "(no results)" when the picker received an empty list', () => {
    const out = renderPickerFrame(createPickerState([]), RENDER_OPTS);
    expect(out).toMatch(/\(no results\)/);
    expect(out).toMatch(/0\/0/);
  });

  it('renders the grouped view with source paths and chunk counts', () => {
    let s = makeState();
    s = applyKey(s, { name: 'tab' }).state;
    const out = renderPickerFrame(s, RENDER_OPTS);
    expect(out).toMatch(/view=grouped/);
    expect(out).toMatch(/demo\/a\.md \(2 chunks\)/);
    expect(out).toMatch(/demo\/b\.md \(1 chunk\)/);
  });

  it('advertises paging and filter keys in the flat footer hint', () => {
    const out = renderPickerFrame(makeState(), RENDER_OPTS);
    expect(out).toMatch(/\[PgUp\/PgDn\] page/);
    expect(out).toMatch(/\[\/\] filter/);
  });

  it('renders the active filter query and a filtered count in filter mode', () => {
    let s = makeState();
    s = applyKey(s, { sequence: '/' }).state;
    for (const ch of 'bravo') s = applyKey(s, { sequence: ch }).state;
    const out = renderPickerFrame(s, RENDER_OPTS);
    expect(out).toMatch(/filter: \/bravo/);
    expect(out).toMatch(/filtered 1\/3/);
    // Only the matching row is drawn.
    expect(out).toMatch(/bravo content about deploy/);
    expect(out).not.toMatch(/alpha content about rollback/);
    // The footer hint is replaced by the filter prompt.
    expect(out).not.toMatch(/\[Tab\] toggle view/);
  });

  it('reports "(no matches)" when a filter excludes every row', () => {
    let s = makeState();
    s = applyKey(s, { sequence: '/' }).state;
    for (const ch of 'zzz') s = applyKey(s, { sequence: ch }).state;
    const out = renderPickerFrame(s, RENDER_OPTS);
    expect(out).toMatch(/\(no matches\)/);
  });

  it('documents paging and filter keys in the help body', () => {
    let s = makeState();
    s = applyKey(s, { sequence: '?' }).state;
    const out = renderPickerFrame(s, RENDER_OPTS);
    expect(out).toMatch(/PgDn \/ PgUp/);
    expect(out).toMatch(/filter results/);
  });

  it('respects a small viewport by emitting a windowed slice of the rows', () => {
    const big = createPickerState(
      Array.from({ length: 50 }, (_, i) => makeDoc(i, `f${i}.md`, `body ${i}`, i / 100)),
    );
    big.focusIndex = 25;
    const out = renderPickerFrame(big, { rows: 10, cols: 80, color: false });
    // Only a window of rows is drawn; the first and last files are off-screen.
    expect(out).not.toMatch(/demo\/f0\.md/);
    expect(out).not.toMatch(/demo\/f49\.md/);
    // The focused row is on-screen.
    expect(out).toMatch(/demo\/f25\.md/);
  });
});

describe('formatSelection', () => {
  it('emits the focused chunk as markdown in flat view', () => {
    const s = makeState();
    const out = formatSelection(s, { view: 'flat', index: 1 });
    expect(out).toMatch(/Semantic Search Results/);
    expect(out).toMatch(/bravo content about deploy/);
    expect(out).not.toMatch(/alpha content/);
  });

  it('emits marked flat chunks in stable result order', () => {
    let s = makeState();
    s.focusIndex = 2;
    s = applyKey(s, { name: 'space' }).state;
    s.focusIndex = 0;
    s = applyKey(s, { name: 'space' }).state;

    const out = formatSelection(s, { view: 'flat', index: 1 });
    expect(out).toMatch(/alpha content about rollback/);
    expect(out).toMatch(/alpha content take two/);
    expect(out).not.toMatch(/bravo content about deploy/);
    expect(out.indexOf('alpha content about rollback')).toBeLessThan(out.indexOf('alpha content take two'));
  });

  it('emits marked flat chunks after switching to grouped view', () => {
    let s = makeState();
    s = applyKey(s, { name: 'space' }).state;
    s = applyKey(s, { sequence: 'j' }).state;
    s = applyKey(s, { name: 'space' }).state;
    s = applyKey(s, { name: 'tab' }).state;

    const out = formatSelection(s, { view: 'grouped', index: 0 });
    expect(out).toMatch(/alpha content about rollback/);
    expect(out).toMatch(/bravo content about deploy/);
    expect(out).not.toMatch(/alpha content take two/);
  });

  it('emits all chunks of the focused source in grouped view', () => {
    const s = makeState();
    const out = formatSelection(s, { view: 'grouped', index: 0 });
    expect(out).toMatch(/alpha content about rollback/);
    expect(out).toMatch(/alpha content take two/);
    expect(out).not.toMatch(/bravo content about deploy/);
  });

  it('returns an empty string when index is out of range', () => {
    const s = makeState();
    expect(formatSelection(s, { view: 'flat', index: 99 })).toBe('');
    expect(formatSelection(s, { view: 'grouped', index: 99 })).toBe('');
  });
});

describe('Ctrl-C path', () => {
  it('does not confuse ctrl-c with the literal "c" key', () => {
    const cKey: PickerKey = { name: 'c' };
    const r = applyKey(makeState(), cKey);
    expect(r.action).toEqual({ type: 'continue' });
  });
});
