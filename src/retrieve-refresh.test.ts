const warnMock = jest.fn();
jest.mock('./logger.js', () => ({
  logger: { warn: (...a: unknown[]) => warnMock(...a), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { BackgroundRefreshCoordinator } from './retrieve-refresh.js';
import { resolveRetrieveRefreshMode } from './config/retrieval.js';

describe('BackgroundRefreshCoordinator (#1228)', () => {
  beforeEach(() => warnMock.mockReset());

  it('a burst joins the in-flight run with no rerun; the next trigger after it starts a new one', async () => {
    const c = new BackgroundRefreshCoordinator();
    let release!: () => void;
    const run = jest.fn(() => new Promise<void>((r) => { release = r; }));
    c.trigger('m', run);
    c.trigger('m', run);
    c.trigger('m', run);
    expect(c.isRefreshing('m')).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await c.idle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(c.isRefreshing('m')).toBe(false);
    c.trigger('m', run);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    await c.idle();
  });

  it('settled() waits for the in-flight run and is a no-op when idle', async () => {
    const c = new BackgroundRefreshCoordinator();
    await c.settled('m');
    let release!: () => void;
    c.trigger('m', () => new Promise<void>((r) => { release = r; }));
    let done = false;
    const w = c.settled('m').then(() => { done = true; });
    await new Promise((r) => setImmediate(r));
    expect(done).toBe(false);
    release();
    await w;
    expect(done).toBe(true);
  });

  it('keys are independent', async () => {
    const c = new BackgroundRefreshCoordinator();
    const run = jest.fn().mockResolvedValue(undefined);
    c.trigger('a', run);
    c.trigger('b', run);
    await c.idle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('logs failures instead of throwing and allows a later run', async () => {
    const c = new BackgroundRefreshCoordinator();
    c.trigger('m', () => Promise.reject(new Error('boom')));
    await expect(c.idle()).resolves.toBeUndefined();
    expect(warnMock).toHaveBeenCalledWith(expect.stringContaining('boom'));
    const run = jest.fn().mockResolvedValue(undefined);
    c.trigger('m', run);
    await c.idle();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('resolveRetrieveRefreshMode', () => {
  it.each([
    [undefined, 'sync'], ['', 'sync'], ['sync', 'sync'], ['ASYNC', 'async'], [' off ', 'off'], ['bogus', 'sync'],
  ])('%j -> %s', (raw, expected) => {
    expect(resolveRetrieveRefreshMode({ KB_RETRIEVE_REFRESH_MODE: raw })).toBe(expected);
  });
});
