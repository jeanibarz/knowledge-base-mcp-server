import {
  TtyProgress,
  createTtyProgress,
  ttyProgressEnabled,
} from './tty-progress.js';

// A minimal stream stub: capture writes and advertise a TTY flag.
function fakeStream(isTTY: boolean) {
  const writes: string[] = [];
  return {
    isTTY,
    write: (text: string) => {
      writes.push(text);
      return true;
    },
    writes,
  };
}

describe('ttyProgressEnabled', () => {
  it('is enabled on a TTY with no suppressors', () => {
    expect(ttyProgressEnabled({ label: 'x', stream: fakeStream(true), env: {} })).toBe(true);
  });

  it('is disabled when the stream is not a TTY', () => {
    expect(ttyProgressEnabled({ label: 'x', stream: fakeStream(false), env: {} })).toBe(false);
  });

  it('is disabled for --format=json even on a TTY', () => {
    expect(
      ttyProgressEnabled({ label: 'x', stream: fakeStream(true), env: {}, format: 'json' }),
    ).toBe(false);
  });

  it('is disabled when NO_COLOR is set', () => {
    expect(
      ttyProgressEnabled({ label: 'x', stream: fakeStream(true), env: { NO_COLOR: '1' } }),
    ).toBe(false);
  });

  it('is disabled when --color=never', () => {
    expect(
      ttyProgressEnabled({ label: 'x', stream: fakeStream(true), env: {}, colorFlag: 'never' }),
    ).toBe(false);
  });

  it('does NOT spray ANSI into a pipe even with --color=always (hard TTY gate)', () => {
    expect(
      ttyProgressEnabled({ label: 'x', stream: fakeStream(false), env: {}, colorFlag: 'always' }),
    ).toBe(false);
  });
});

describe('TtyProgress when disabled', () => {
  it('never writes anything — output is byte-identical to no spinner', () => {
    const writes: string[] = [];
    const progress = new TtyProgress({
      label: 'kb ask: thinking',
      enabled: false,
      write: (t) => writes.push(t),
    });
    progress.start();
    progress.tick();
    progress.stop();
    expect(writes).toEqual([]);
  });
});

describe('TtyProgress when enabled', () => {
  // Deterministic seams: a manual scheduler that never fires on its own, plus
  // a controllable clock, so frame emission is driven explicitly by the test.
  function harness(nowValues: number[]) {
    const writes: string[] = [];
    let scheduled: (() => void) | null = null;
    let cleared = false;
    let nowIdx = 0;
    const progress = new TtyProgress({
      label: 'kb ask: thinking',
      enabled: true,
      write: (t) => writes.push(t),
      now: () => nowValues[Math.min(nowIdx++, nowValues.length - 1)]!,
      scheduler: {
        set: (cb) => {
          scheduled = cb;
          return 0 as unknown as ReturnType<typeof setInterval>;
        },
        clear: () => {
          cleared = true;
        },
      },
    });
    return {
      progress,
      writes,
      fireTimer: () => scheduled?.(),
      wasCleared: () => cleared,
    };
  }

  it('renders a frame with a carriage return, clear-line, spinner glyph and label on start', () => {
    const h = harness([0]);
    h.progress.start();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toContain('\r\x1b[K');
    expect(h.writes[0]).toMatch(/kb ask: thinking \(0s\)$/);
    // The first glyph is the first frame of the spinner set.
    expect(h.writes[0]).toContain('⠋');
  });

  it('advances the spinner glyph and elapsed clock on tick', () => {
    const h = harness([0, 2000]);
    h.progress.start();
    h.progress.tick();
    expect(h.writes).toHaveLength(2);
    expect(h.writes[0]).toContain('⠋');
    expect(h.writes[1]).toContain('⠙');
    expect(h.writes[1]).toMatch(/\(2s\)$/);
  });

  it('animates via the scheduled timer callback', () => {
    const h = harness([0, 500]);
    h.progress.start();
    h.fireTimer();
    expect(h.writes).toHaveLength(2);
  });

  it('clears its line and stops the timer on stop()', () => {
    const h = harness([0]);
    h.progress.start();
    h.progress.stop();
    expect(h.writes[h.writes.length - 1]).toBe('\r\x1b[K');
    expect(h.wasCleared()).toBe(true);
  });

  it('is idempotent: a second stop() is a no-op', () => {
    const h = harness([0]);
    h.progress.start();
    h.progress.stop();
    const countAfterFirstStop = h.writes.length;
    h.progress.stop();
    expect(h.writes).toHaveLength(countAfterFirstStop);
  });

  it('does not render after stop() even if a stale timer fires', () => {
    const h = harness([0]);
    h.progress.start();
    h.progress.stop();
    const countAfterStop = h.writes.length;
    h.fireTimer();
    expect(h.writes).toHaveLength(countAfterStop);
  });
});

describe('createTtyProgress', () => {
  it('produces an inert instance that writes nothing on a non-TTY stream', () => {
    const stream = fakeStream(false);
    const progress = createTtyProgress({ label: 'kb reindex', stream, env: {} });
    progress.start();
    progress.tick();
    progress.stop();
    expect(stream.writes).toEqual([]);
  });

  it('writes spinner frames to the stream when enabled', () => {
    const stream = fakeStream(true);
    const progress = createTtyProgress({ label: 'kb reindex', stream, env: {}, now: () => 0 });
    progress.start();
    expect(stream.writes.length).toBeGreaterThan(0);
    progress.stop();
    expect(stream.writes[stream.writes.length - 1]).toBe('\r\x1b[K');
  });
});
